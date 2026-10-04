// Package chdb is the ClickHouse side of the analytics-worker: the native-protocol connection, the batch INSERT
// with the deduplication settings, and the adapter the migrator uses.
package chdb

import (
	"context"
	"fmt"
	"strings"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/google/uuid"

	"github.com/luantpbk/winkey/services/analytics/internal/event"
)

// Options of the connection.
type Options struct {
	Addr     string // host:port of the native protocol (localhost:9000)
	User     string
	Password string
}

// Open connects lazily (the first statement dials). The default database is used: every statement names winkey.*
// itself, and winkey may not exist yet when the worker starts.
func Open(o Options) (driver.Conn, error) {
	return clickhouse.Open(&clickhouse.Options{
		Addr:        []string{o.Addr},
		Auth:        clickhouse.Auth{Database: "default", Username: o.User, Password: o.Password},
		DialTimeout: 10 * time.Second, ReadTimeout: 60 * time.Second,
		MaxOpenConns: 4, MaxIdleConns: 2, ConnMaxLifetime: 30 * time.Minute,
		Compression: &clickhouse.Compression{Method: clickhouse.CompressionLZ4},
	})
}

// Inserter writes batches to winkey.playback_events.
type Inserter struct{ Conn driver.Conn }

// Unwritten reconciles a redelivered batch with persisted rows before a new INSERT. The old INSERT may have
// committed before its response was lost; its deduplication token cannot protect a differently bounded batch.
// Look up the existing ORDER BY key so recovery does not require a full scan of the event_id column.
func (i *Inserter) Unwritten(ctx context.Context, rows []event.Row) ([]event.Row, error) {
	// Bound the rendered UUID tuples below ClickHouse's default 256 KiB max_query_size, even when
	// the worker accepts its maximum configured batch. No rows are inserted until every lookup succeeds.
	const lookupWindow = 1000
	unwritten := make([]event.Row, 0, len(rows))
	for first := 0; first < len(rows); first += lookupWindow {
		part := rows[first:min(first+lookupWindow, len(rows))]
		ids, err := i.persisted(ctx, part)
		if err != nil {
			return nil, err
		}
		for _, row := range part {
			if !ids[row.EventID] {
				unwritten = append(unwritten, row)
			}
		}
	}
	return unwritten, nil
}

func (i *Inserter) persisted(ctx context.Context, rows []event.Row) (map[uuid.UUID]bool, error) {
	if len(rows) == 0 {
		return nil, nil
	}
	keys := make([]string, len(rows))
	args := make([]any, 0, 3*len(rows))
	for n, row := range rows {
		keys[n] = "(?, ?, ?)"
		args = append(args, row.VideoID, row.PlaybackID, row.Seq)
	}
	stored, err := i.Conn.Query(ctx, "SELECT event_id FROM winkey.playback_events WHERE (video_id, playback_id, seq) IN ("+strings.Join(keys, ",")+")", args...)
	if err != nil {
		return nil, fmt.Errorf("lookup redelivered rows: %w", err)
	}
	defer func() { _ = stored.Close() }()
	ids := make(map[uuid.UUID]bool, len(rows))
	for stored.Next() {
		var id uuid.UUID
		if err := stored.Scan(&id); err != nil {
			return nil, fmt.Errorf("scan redelivered row: %w", err)
		}
		ids[id] = true
	}
	if err := stored.Err(); err != nil {
		return nil, fmt.Errorf("read redelivered rows: %w", err)
	}
	return ids, nil
}

// InsertBatch writes the rows with ONE INSERT and the two settings that make a retry exact
// (see db/clickhouse/0001_playback.sql): the deduplication token of the batch, and the same deduplication for the
// materialized view video_qoe_hourly. Without the second one the hourly sums would count a retried batch twice.
func (i *Inserter) InsertBatch(ctx context.Context, rows []event.Row, token string) error {
	ctx = clickhouse.Context(ctx, clickhouse.WithSettings(clickhouse.Settings{
		"insert_deduplication_token":                         token,
		"deduplicate_blocks_in_dependent_materialized_views": 1,
	}))
	batch, err := i.Conn.PrepareBatch(ctx, "INSERT INTO winkey.playback_events")
	if err != nil {
		return fmt.Errorf("prepare batch: %w", err)
	}
	for _, r := range rows {
		if err := batch.Append(
			r.EventID, r.ReceivedAt, r.SentAt, r.PlaybackID, r.VideoID, r.OwnerID, r.ViewerKey, r.Authenticated,
			r.Kind, r.Seq, r.PositionMs, r.WatchedMs, r.RebufferMs, r.RebufferCount,
			r.StartupMs, r.Rendition, r.BitrateKbps, r.ErrorCode, r.Client, r.Country,
		); err != nil {
			_ = batch.Abort()
			return fmt.Errorf("append: %w", err)
		}
	}
	if err := batch.Send(); err != nil {
		return fmt.Errorf("send: %w", err)
	}
	return nil
}

// Migrations adapts a connection to migrate.DB.
type Migrations struct{ Conn driver.Conn }

func (m Migrations) Exec(ctx context.Context, query string, args ...any) error {
	return m.Conn.Exec(ctx, query, args...)
}

func (m Migrations) Applied(ctx context.Context) (map[string]bool, error) {
	rows, err := m.Conn.Query(ctx, `SELECT name FROM winkey.schema_migrations`)
	if err != nil {
		return nil, err
	}
	defer func() { _ = rows.Close() }()
	out := map[string]bool{}
	for rows.Next() {
		var n string
		if err := rows.Scan(&n); err != nil {
			return nil, err
		}
		out[n] = true
	}
	return out, rows.Err()
}

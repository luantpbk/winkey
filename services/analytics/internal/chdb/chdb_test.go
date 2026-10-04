package chdb

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/google/uuid"

	"github.com/luantpbk/winkey/services/analytics/internal/event"
)

type lookupConn struct {
	driver.Conn
	query string
	args  []any
	rows  driver.Rows
	err   error
	calls int
}

func (c *lookupConn) Query(_ context.Context, query string, args ...any) (driver.Rows, error) {
	c.query, c.args = query, args
	c.calls++
	return c.rows, c.err
}

func TestUnwrittenBoundsLookupQueriesForTheMaximumWorkerBatch(t *testing.T) {
	rows := make([]event.Row, 20000)
	for n := range rows {
		rows[n].EventID = uuid.New()
	}
	conn := &lookupConn{rows: &lookupRows{}}
	got, err := (&Inserter{Conn: conn}).Unwritten(context.Background(), rows)
	if err != nil || len(got) != len(rows) || conn.calls != 20 || len(conn.args) != 3000 {
		t.Fatalf("rows %d, queries %d, last query args %d, error %v", len(got), conn.calls, len(conn.args), err)
	}
}

type lookupRows struct {
	driver.Rows
	ids     []uuid.UUID
	pos     int
	scanErr error
	err     error
	closed  bool
}

func (r *lookupRows) Next() bool { return r.pos < len(r.ids) }
func (r *lookupRows) Scan(dest ...any) error {
	if r.scanErr != nil {
		return r.scanErr
	}
	*dest[0].(*uuid.UUID) = r.ids[r.pos]
	r.pos++
	return nil
}
func (r *lookupRows) Err() error   { return r.err }
func (r *lookupRows) Close() error { r.closed = true; return nil }

func TestUnwrittenLooksUpThePrimaryKeyAndPreservesMissingRowOrder(t *testing.T) {
	rows := []event.Row{
		{EventID: uuid.New(), VideoID: uuid.New(), PlaybackID: uuid.New(), Seq: 1},
		{EventID: uuid.New(), VideoID: uuid.New(), PlaybackID: uuid.New(), Seq: 2},
		{EventID: uuid.New(), VideoID: uuid.New(), PlaybackID: uuid.New(), Seq: 3},
	}
	stored := &lookupRows{ids: []uuid.UUID{rows[1].EventID, rows[1].EventID}}
	conn := &lookupConn{rows: stored}
	got, err := (&Inserter{Conn: conn}).Unwritten(context.Background(), rows)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, []event.Row{rows[0], rows[2]}) || !stored.closed {
		t.Fatalf("missing rows %+v, closed %v", got, stored.closed)
	}
	if !strings.Contains(conn.query, "WHERE (video_id, playback_id, seq) IN") || strings.Count(conn.query, "?") != 9 {
		t.Fatalf("lookup must use the existing sorting key: %s", conn.query)
	}
	for n, row := range rows {
		if conn.args[n*3] != row.VideoID || conn.args[n*3+1] != row.PlaybackID || conn.args[n*3+2] != row.Seq {
			t.Fatalf("wrong key for row %d: %v", n, conn.args[n*3:n*3+3])
		}
	}
}

func TestUnwrittenDoesNotTreatLookupErrorsAsPersistedRows(t *testing.T) {
	want := errors.New("database unavailable")
	for _, stage := range []string{"query", "scan", "read"} {
		t.Run(stage, func(t *testing.T) {
			stored := &lookupRows{ids: []uuid.UUID{uuid.New()}}
			conn := &lookupConn{rows: stored}
			switch stage {
			case "query":
				conn.err = want
			case "scan":
				stored.scanErr = want
			case "read":
				stored.err = want
			}
			got, err := (&Inserter{Conn: conn}).Unwritten(context.Background(), []event.Row{{EventID: uuid.New()}})
			if !errors.Is(err, want) || got != nil {
				t.Fatalf("rows %+v error %v", got, err)
			}
			if stage != "query" && !stored.closed {
				t.Fatal("lookup rows were not closed")
			}
		})
	}
}

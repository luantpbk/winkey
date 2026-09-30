// Package migrate applies the ClickHouse schema files of db/clickhouse to the node at start-up (task R1, ADR-022).
// The files are read from a directory (CLICKHOUSE_MIGRATIONS_DIR, mounted read-only from db/clickhouse), never copied
// into this module, so they cannot drift from db/. Every file is applied once, in file-name order, and recorded in
// winkey.schema_migrations; every statement in them is idempotent (IF NOT EXISTS), so a crash between a file and its
// record only re-runs harmless statements.
package migrate

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// DB is what the migrator needs of ClickHouse.
type DB interface {
	Exec(ctx context.Context, query string, args ...any) error
	// Applied returns the names recorded in winkey.schema_migrations.
	Applied(ctx context.Context) (map[string]bool, error)
}

// bootstrap creates the database and the table that records the files. 0001_playback.sql declares the same table
// with IF NOT EXISTS, so the two never conflict; the migrator needs it before it can read what was applied.
var bootstrap = []string{
	`CREATE DATABASE IF NOT EXISTS winkey`,
	`CREATE TABLE IF NOT EXISTS winkey.schema_migrations
(
    name       String,
    applied_at DateTime('UTC') DEFAULT now()
)
ENGINE = ReplacingMergeTree
ORDER BY name`,
}

// Apply runs every *.sql file of dir that is not yet recorded and returns the names it applied. A failing statement
// stops the run (the file is not recorded, the error names file and statement).
func Apply(ctx context.Context, db DB, dir string, log *slog.Logger) ([]string, error) {
	files, err := filepath.Glob(filepath.Join(dir, "*.sql"))
	if err != nil {
		return nil, err
	}
	if len(files) == 0 {
		return nil, fmt.Errorf("no *.sql files in %s", dir)
	}
	sort.Strings(files)
	for _, q := range bootstrap {
		if err := db.Exec(ctx, q); err != nil {
			return nil, fmt.Errorf("bootstrap: %w", err)
		}
	}
	done, err := db.Applied(ctx)
	if err != nil {
		return nil, fmt.Errorf("read schema_migrations: %w", err)
	}
	var applied []string
	for _, f := range files {
		name := filepath.Base(f)
		if done[name] {
			continue
		}
		raw, err := os.ReadFile(f)
		if err != nil {
			return applied, err
		}
		for i, stmt := range SplitStatements(string(raw)) {
			if err := db.Exec(ctx, stmt); err != nil {
				return applied, fmt.Errorf("%s: statement %d: %w", name, i+1, err)
			}
		}
		if err := db.Exec(ctx, `INSERT INTO winkey.schema_migrations (name) VALUES (?)`, name); err != nil {
			return applied, fmt.Errorf("%s: record: %w", name, err)
		}
		applied = append(applied, name)
		log.Info("clickhouse migration applied", "file", name)
	}
	if len(applied) == 0 {
		log.Info("clickhouse schema is up to date", "files", len(files))
	}
	return applied, nil
}

// SplitStatements splits a file on ';' outside comments, string literals and quoted identifiers, and drops the
// comments (`-- …` to the end of the line, `/* … */`) and the blank statements. The text of each statement is kept
// as written otherwise.
func SplitStatements(sql string) []string {
	var out []string
	var cur strings.Builder
	flush := func() {
		if s := strings.TrimSpace(cur.String()); s != "" {
			out = append(out, s)
		}
		cur.Reset()
	}
	for i := 0; i < len(sql); i++ {
		c := sql[i]
		switch {
		case c == '-' && i+1 < len(sql) && sql[i+1] == '-': // line comment
			for i < len(sql) && sql[i] != '\n' {
				i++
			}
			cur.WriteByte('\n')
		case c == '/' && i+1 < len(sql) && sql[i+1] == '*': // block comment
			i += 2
			for i+1 < len(sql) && !(sql[i] == '*' && sql[i+1] == '/') {
				i++
			}
			i++ // the '/'
			cur.WriteByte(' ')
		case c == '\'' || c == '"' || c == '`': // literal or identifier: copy to the closing quote
			q := c
			cur.WriteByte(c)
			for i++; i < len(sql); i++ {
				cur.WriteByte(sql[i])
				if sql[i] == '\\' && i+1 < len(sql) { // escaped character
					i++
					cur.WriteByte(sql[i])
					continue
				}
				if sql[i] == q {
					if i+1 < len(sql) && sql[i+1] == q { // doubled quote
						i++
						cur.WriteByte(sql[i])
						continue
					}
					break
				}
			}
		case c == ';':
			flush()
		default:
			cur.WriteByte(c)
		}
	}
	flush()
	return out
}

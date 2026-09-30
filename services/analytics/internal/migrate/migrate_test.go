package migrate

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestSplitStatements(t *testing.T) {
	for name, c := range map[string]struct {
		in   string
		want []string
	}{
		"two statements":         {"SELECT 1; SELECT 2;", []string{"SELECT 1", "SELECT 2"}},
		"no trailing semicolon":  {"SELECT 1", []string{"SELECT 1"}},
		"blank statements":       {";;  ;\n;SELECT 1;;", []string{"SELECT 1"}},
		"line comment":           {"-- a; b\nSELECT 1; -- c; d\nSELECT 2", []string{"SELECT 1", "SELECT 2"}},
		"comment only":           {"-- nothing here;\n/* or here; */", nil},
		"block comment":          {"SELECT /* ; */ 1; SELECT 2", []string{"SELECT   1", "SELECT 2"}},
		"semicolon in a string":  {"SELECT 'a;b'; SELECT 2", []string{"SELECT 'a;b'", "SELECT 2"}},
		"doubled quote":          {"SELECT 'it''s; fine'; SELECT 2", []string{"SELECT 'it''s; fine'", "SELECT 2"}},
		"escaped quote":          {`SELECT 'it\'s; fine'; SELECT 2`, []string{`SELECT 'it\'s; fine'`, "SELECT 2"}},
		"dashes in a string":     {"SELECT '--not a comment'; SELECT 2", []string{"SELECT '--not a comment'", "SELECT 2"}},
		"backtick identifier":    {"SELECT `a;b`; SELECT 2", []string{"SELECT `a;b`", "SELECT 2"}},
		"double quoted":          {`SELECT "a;b"; SELECT 2`, []string{`SELECT "a;b"`, "SELECT 2"}},
		"multi-line statement":   {"CREATE TABLE t\n(\n  a Int32\n)\nENGINE = Memory;\nSELECT 1;", []string{"CREATE TABLE t\n(\n  a Int32\n)\nENGINE = Memory", "SELECT 1"}},
		"minus is not a comment": {"SELECT 5 - 3; SELECT 2", []string{"SELECT 5 - 3", "SELECT 2"}},
		"empty":                  {"", nil},
	} {
		got := SplitStatements(c.in)
		if len(got) != len(c.want) {
			t.Errorf("%s: %q, want %q", name, got, c.want)
			continue
		}
		for i := range got {
			if strings.TrimSpace(got[i]) != c.want[i] {
				t.Errorf("%s: statement %d is %q, want %q", name, i, got[i], c.want[i])
			}
		}
	}
}

// The real schema file of the architect: five statements, no comment text left in them.
func TestSplitsTheRealSchemaFile(t *testing.T) {
	wd, _ := os.Getwd()
	var raw []byte
	for i := 0; i < 8; i++ {
		if b, err := os.ReadFile(filepath.Join(wd, "db", "clickhouse", "0001_playback.sql")); err == nil {
			raw = b
			break
		}
		wd = filepath.Dir(wd)
	}
	if raw == nil {
		t.Fatal("db/clickhouse/0001_playback.sql not found")
	}
	stmts := SplitStatements(string(raw))
	wantStart := []string{"CREATE DATABASE IF NOT EXISTS winkey", "CREATE TABLE IF NOT EXISTS winkey.schema_migrations",
		"CREATE TABLE IF NOT EXISTS winkey.playback_events", "CREATE TABLE IF NOT EXISTS winkey.video_qoe_hourly",
		"CREATE MATERIALIZED VIEW IF NOT EXISTS winkey.video_qoe_hourly_mv"}
	if len(stmts) != len(wantStart) {
		t.Fatalf("%d statements: %q", len(stmts), stmts)
	}
	for i, s := range stmts {
		if !strings.HasPrefix(s, wantStart[i]) {
			t.Errorf("statement %d starts with %q, want %q", i+1, s[:min(len(s), 60)], wantStart[i])
		}
		if strings.Contains(s, "--") || strings.Contains(s, "/*") {
			t.Errorf("statement %d still holds a comment: %s", i+1, s)
		}
	}
	if !strings.Contains(stmts[2], "non_replicated_deduplication_window = 1000") || !strings.Contains(stmts[4], "quantilesStateIf") {
		t.Fatal("statements lost their tail")
	}
}

type fakeDB struct {
	execs   []string
	applied map[string]bool
	failOn  string // a statement containing this fails
}

func (f *fakeDB) Exec(_ context.Context, q string, args ...any) error {
	if f.failOn != "" && strings.Contains(q, f.failOn) {
		return errors.New("boom")
	}
	f.execs = append(f.execs, q)
	if strings.HasPrefix(q, "INSERT INTO winkey.schema_migrations") {
		if f.applied == nil {
			f.applied = map[string]bool{}
		}
		f.applied[args[0].(string)] = true
	}
	return nil
}

func (f *fakeDB) Applied(context.Context) (map[string]bool, error) {
	out := map[string]bool{}
	for k := range f.applied {
		out[k] = true
	}
	return out, nil
}

func write(t *testing.T, dir, name, body string) {
	t.Helper()
	if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
}

func quiet() *slog.Logger { return slog.New(slog.NewJSONHandler(io.Discard, nil)) }

func TestApplyRunsFilesOnceInNameOrder(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "0002_second.sql", "CREATE TABLE b (x Int32) ENGINE = Memory;")
	write(t, dir, "0001_first.sql", "CREATE TABLE a (x Int32) ENGINE = Memory; -- a\nCREATE TABLE a2 (x Int32) ENGINE = Memory;")
	write(t, dir, "notes.txt", "not sql")
	db := &fakeDB{}
	got, err := Apply(context.Background(), db, dir, quiet())
	if err != nil || strings.Join(got, ",") != "0001_first.sql,0002_second.sql" {
		t.Fatalf("%v %v", got, err)
	}
	var creates []string
	for _, q := range db.execs {
		if strings.HasPrefix(q, "CREATE TABLE a") || strings.HasPrefix(q, "CREATE TABLE b") {
			creates = append(creates, q[:14])
		}
	}
	if strings.Join(creates, "|") != "CREATE TABLE a|CREATE TABLE a|CREATE TABLE b" { // a, a2 (prefix "CREATE TABLE a"), then b
		t.Fatalf("order %v", creates)
	}
	if !strings.HasPrefix(db.execs[0], "CREATE DATABASE IF NOT EXISTS winkey") || !strings.Contains(db.execs[1], "winkey.schema_migrations") {
		t.Fatalf("bootstrap first: %v", db.execs[:2])
	}
	// The second start does nothing: no file statement runs again, nothing is recorded again.
	before := len(db.execs)
	again, err := Apply(context.Background(), db, dir, quiet())
	if err != nil || len(again) != 0 {
		t.Fatalf("second run applied %v (%v)", again, err)
	}
	for _, q := range db.execs[before:] {
		if !strings.Contains(q, "IF NOT EXISTS winkey") { // only the bootstrap statements
			t.Fatalf("second run executed %q", q)
		}
	}
	// A new file is picked up alone.
	write(t, dir, "0003_third.sql", "CREATE TABLE c (x Int32) ENGINE = Memory;")
	if got, err := Apply(context.Background(), db, dir, quiet()); err != nil || len(got) != 1 || got[0] != "0003_third.sql" {
		t.Fatalf("%v %v", got, err)
	}
}

func TestAFailingStatementStopsTheFileAndIsNotRecorded(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "0001_ok.sql", "CREATE TABLE a (x Int32) ENGINE = Memory;")
	write(t, dir, "0002_bad.sql", "CREATE TABLE b (x Int32) ENGINE = Memory; CREATE TABLE explode (x Int32) ENGINE = Memory; CREATE TABLE c (x Int32) ENGINE = Memory;")
	write(t, dir, "0003_later.sql", "CREATE TABLE d (x Int32) ENGINE = Memory;")
	db := &fakeDB{failOn: "explode"}
	got, err := Apply(context.Background(), db, dir, quiet())
	if err == nil || !strings.Contains(err.Error(), "0002_bad.sql: statement 2") {
		t.Fatalf("%v", err)
	}
	if len(got) != 1 || got[0] != "0001_ok.sql" || db.applied["0002_bad.sql"] || db.applied["0003_later.sql"] {
		t.Fatalf("applied %v, recorded %v", got, db.applied)
	}
	for _, q := range db.execs {
		if strings.Contains(q, "TABLE c") || strings.Contains(q, "TABLE d") {
			t.Fatalf("ran past the failure: %s", q)
		}
	}
	// After the cause is fixed the file runs again from its start (its statements are idempotent).
	db.failOn = ""
	if got, err := Apply(context.Background(), db, dir, quiet()); err != nil || len(got) != 2 {
		t.Fatalf("%v %v", got, err)
	}
}

func TestApplyWithoutFilesIsAnError(t *testing.T) {
	if _, err := Apply(context.Background(), &fakeDB{}, t.TempDir(), quiet()); err == nil {
		t.Fatal("an empty migrations directory must not start the worker silently")
	}
}

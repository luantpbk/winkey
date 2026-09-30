package testkit

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"net/url"
	"os"
	"path/filepath"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// EnvExternalPostgres names the variable that points the tests at a PostgreSQL
// server you already run (no Docker needed), e.g.
// postgres://winkey:winkey@127.0.0.1:5432/postgres?sslmode=disable
const EnvExternalPostgres = "WINKEY_TEST_PG_URL"

// externalPostgres gives the test its own new database on the server named by
// base (the role needs CREATEDB; pg_trgm, unaccent and citext must be
// installable, i.e. the contrib package). The database is dropped when the
// test ends, so tests never see each other's data.
func externalPostgres(t testing.TB, base string) *Postgres {
	t.Helper()
	ctx := context.Background()

	u, err := url.Parse(base)
	if err != nil || u.Scheme == "" || u.Host == "" {
		t.Fatalf("testkit: %s is not a postgres:// URL", EnvExternalPostgres)
	}
	admin, err := pgx.Connect(ctx, base)
	if err != nil {
		t.Fatalf("testkit: connect to %s: %v", EnvExternalPostgres, err)
	}
	defer func() { _ = admin.Close(ctx) }()

	var suffix [6]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		t.Fatal(err)
	}
	name := "winkey_test_" + hex.EncodeToString(suffix[:])
	if _, err := admin.Exec(ctx, `CREATE DATABASE `+pgx.Identifier{name}.Sanitize()); err != nil {
		t.Fatalf("testkit: create database (the role needs CREATEDB): %v", err)
	}

	dbURL := *u
	dbURL.Path = "/" + name
	pool, err := pgxpool.New(ctx, dbURL.String())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Close()
		c, err := pgx.Connect(context.Background(), base)
		if err != nil {
			t.Logf("testkit: cleanup: connect: %v", err)
			return
		}
		defer func() { _ = c.Close(context.Background()) }()
		if _, err := c.Exec(context.Background(), `DROP DATABASE IF EXISTS `+pgx.Identifier{name}.Sanitize()+` WITH (FORCE)`); err != nil {
			t.Logf("testkit: cleanup: drop %s: %v", name, err)
		}
	})

	ApplyMigrations(t, pool, filepath.Join(RepoRoot(t), "db", "migrations"))
	return &Postgres{URL: dbURL.String(), Pool: pool}
}

func externalPostgresURL() string { return os.Getenv(EnvExternalPostgres) }

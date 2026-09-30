package testkit

import (
	"context"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/testcontainers/testcontainers-go"
	tcpostgres "github.com/testcontainers/testcontainers-go/modules/postgres"
	"github.com/testcontainers/testcontainers-go/wait"
)

// Postgres is a PostgreSQL 17 instance with db/migrations applied.
type Postgres struct {
	URL  string
	Pool *pgxpool.Pool
}

// StartPostgres starts PostgreSQL 17, applies every db/migrations/*.up.sql in
// order (the migrations are authoritative; nothing else creates schema) and
// returns a pool. The container is terminated when the test ends.
//
// With WINKEY_TEST_PG_URL set, no container is started: the test gets a new
// database on that server instead (see postgres_external.go). CI does not set
// it and runs the container with WINKEY_REQUIRE_DOCKER=1.
func StartPostgres(t testing.TB) *Postgres {
	t.Helper()
	if base := externalPostgresURL(); base != "" {
		return externalPostgres(t, base)
	}
	requireDocker(t)
	ctx := context.Background()

	c, err := tcpostgres.Run(ctx, "postgres:17-alpine",
		tcpostgres.WithDatabase("winkey"),
		tcpostgres.WithUsername("winkey"),
		tcpostgres.WithPassword("winkey"),
		testcontainers.WithWaitStrategy(
			wait.ForLog("database system is ready to accept connections").
				WithOccurrence(2).WithStartupTimeout(90*time.Second)),
	)
	if err != nil {
		t.Fatalf("testkit: start postgres: %v", err)
	}
	testcontainers.CleanupContainer(t, c)

	url, err := c.ConnectionString(ctx, "sslmode=disable")
	if err != nil {
		t.Fatal(err)
	}
	pool, err := pgxpool.New(ctx, url)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	ApplyMigrations(t, pool, filepath.Join(RepoRoot(t), "db", "migrations"))
	return &Postgres{URL: url, Pool: pool}
}

// ApplyMigrations runs every *.up.sql in dir in lexical order using the
// simple protocol (files contain multiple statements).
func ApplyMigrations(t testing.TB, pool *pgxpool.Pool, dir string) {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(dir, "*.up.sql"))
	if err != nil || len(files) == 0 {
		t.Fatalf("testkit: no migrations in %s (err=%v)", dir, err)
	}
	sort.Strings(files)
	ctx := context.Background()
	conn, err := pool.Acquire(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Release()
	for _, f := range files {
		sql, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := conn.Conn().PgConn().Exec(ctx, string(sql)).ReadAll(); err != nil {
			t.Fatalf("testkit: migration %s: %v", strings.TrimSuffix(filepath.Base(f), ".up.sql"), err)
		}
	}
}

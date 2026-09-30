package testkit

import (
	"context"
	"testing"
)

// Runs only against an external server (WINKEY_TEST_PG_URL): every StartPostgres
// gets its own migrated database, and it is dropped when the test ends.
func TestExternalPostgresGivesEachTestItsOwnDatabase(t *testing.T) {
	if externalPostgresURL() == "" {
		t.Skip(EnvExternalPostgres + " not set")
	}
	ctx := context.Background()
	var names []string
	t.Run("databases", func(t *testing.T) {
		a, b := StartPostgres(t), StartPostgres(t)
		for i, pg := range []*Postgres{a, b} {
			var db string
			var users int
			if err := pg.Pool.QueryRow(ctx, `SELECT current_database(), (SELECT count(*) FROM auth.users)`).Scan(&db, &users); err != nil {
				t.Fatalf("db %d: %v", i, err) // migrations applied: auth.users exists
			}
			names = append(names, db)
			if _, err := pg.Pool.Exec(ctx, `SELECT public.winkey_fold('Hà Nội')`); err != nil {
				t.Fatal(err)
			}
		}
		if names[0] == names[1] {
			t.Fatalf("both tests got %s", names[0])
		}
		if _, err := a.Pool.Exec(ctx, `INSERT INTO auth.users (id, email, handle, display_name) VALUES (gen_random_uuid(), 'a@example.test', 'alice', 'A')`); err != nil {
			t.Fatal(err)
		}
		var n int
		if err := b.Pool.QueryRow(ctx, `SELECT count(*) FROM auth.users`).Scan(&n); err != nil || n != 0 {
			t.Fatalf("the other database sees %d users (%v)", n, err)
		}
	})
	// The subtest is over: both databases are gone.
	admin := StartPostgres(t)
	for _, name := range names {
		var exists bool
		if err := admin.Pool.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = $1)`, name).Scan(&exists); err != nil || exists {
			t.Fatalf("database %s not dropped (%v)", name, err)
		}
	}
}

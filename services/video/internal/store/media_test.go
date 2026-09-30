package store

import (
	"context"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/luantpbk/winkey/libs/go/ids"
	"github.com/luantpbk/winkey/services/video/internal/testutil"
)

type countingTracer struct {
	queries atomic.Int64
	last    atomic.Value // string
}

func (c *countingTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, d pgx.TraceQueryStartData) context.Context {
	c.queries.Add(1)
	c.last.Store(d.SQL)
	return ctx
}
func (c *countingTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

// mediaAccess is hot (one call per video per 30 s per nginx): exactly ONE statement, served by
// the primary key.
func TestMediaPublicIsOnePrimaryKeyQuery(t *testing.T) {
	_, pg := setup(t)
	ctx := context.Background()
	owner := testutil.SeedUser(t, pg.Pool, "alice", nil, "")
	seedMany(t, pg, owner.ID, 3000, 0) // a table of realistic size (bulk seed first: it moves every row)
	if _, err := pg.Pool.Exec(ctx, `ANALYZE media.videos`); err != nil {
		t.Fatal(err)
	}
	v := testutil.SeedVideo(t, pg.Pool, testutil.Video{Owner: owner.ID})

	cfg, err := pgxpool.ParseConfig(pg.URL)
	if err != nil {
		t.Fatal(err)
	}
	tr := &countingTracer{}
	cfg.ConnConfig.Tracer = tr
	pool, err := pgxpool.NewWithConfig(ctx, cfg)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	st := &Postgres{Pool: pool}

	for _, c := range []struct {
		id   string
		want bool
	}{{v.ID.String(), true}, {ids.NewString(), false}} {
		before := tr.queries.Load()
		id := v.ID
		if !c.want {
			id = ids.New()
		}
		got, err := st.MediaPublic(ctx, id)
		if err != nil || got != c.want {
			t.Fatalf("%s: %v %v", c.id, got, err)
		}
		if n := tr.queries.Load() - before; n != 1 {
			t.Fatalf("%d statements for one check", n)
		}
	}

	// The plan reaches the video through videos_pkey (explain() discourages sequential scans, which a test table would win), .
	plan := explain(t, st, tr.last.Load().(string), []any{v.ID})
	pk := false
	plan.walk(func(n planNode) {
		if n.IndexName == "videos_pkey" {
			pk = true
		}
	})
	if !pk {
		t.Fatalf("not a primary-key lookup: %s", plan)
	}
}

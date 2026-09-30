package store

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/services/video/internal/domain"
	"github.com/luantpbk/winkey/services/video/internal/testutil"
)

// The subscription feed must read the videos of the followed channels through the partial index
// videos_owner_published (owner_id, published_at DESC, id DESC), never by scanning media.videos. The planner
// decides on its own here (sequential scans are NOT discouraged): the table is big enough that the index wins, and
// the plan is logged so it can be pasted into a review.
func TestSubscriptionFeedUsesTheOwnerPublishedIndex(t *testing.T) {
	st, pg := setup(t)
	ctx := context.Background()

	// 60 channels x 100 public videos published over 90 days, a viewer that follows 12 of them.
	me := testutil.SeedUser(t, pg.Pool, "meuser", nil, "")
	var followed []uuid.UUID
	for i := 0; i < 60; i++ {
		u := testutil.SeedUser(t, pg.Pool, "chan"+string(rune('a'+i/26))+string(rune('a'+i%26)), nil, "")
		vids := testutil.SeedManyReady(t, pg.Pool, u.ID, 100)
		if _, err := pg.Pool.Exec(ctx, `UPDATE media.videos SET published_at = now() - random() * interval '90 days' WHERE id = ANY($1)`, vids); err != nil {
			t.Fatal(err)
		}
		if i%5 == 0 {
			followed = append(followed, u.ID)
			if err := st.Subscribe(ctx, me.ID, u.ID, time.Now()); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := pg.Pool.Exec(ctx, `ANALYZE media.videos, media.subscriptions`); err != nil {
		t.Fatal(err)
	}

	after := &domain.Position{T: time.Now().Add(-30 * 24 * time.Hour), ID: uuid.Max}
	for name, q := range map[string]domain.SubscriptionFeedQuery{
		"first page": {Subscriber: me.ID, Limit: 25},
		"next page":  {Subscriber: me.ID, After: after, Limit: 25},
	} {
		sql, args := subscriptionFeedSQL(q)
		tx, err := pg.Pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		var raw []byte
		err = tx.QueryRow(ctx, `EXPLAIN (FORMAT JSON) `+sql, args...).Scan(&raw)
		_ = tx.Rollback(ctx)
		if err != nil {
			t.Fatalf("%s: explain: %v", name, err)
		}
		var top []struct {
			Plan planNode `json:"Plan"`
		}
		if err := json.Unmarshal(raw, &top); err != nil || len(top) != 1 {
			t.Fatalf("plan: %v %s", err, raw)
		}
		plan := top[0].Plan
		used := false
		plan.walk(func(n planNode) {
			if n.IndexName == "videos_owner_published" {
				used = true
			}
			if n.NodeType == "Seq Scan" && n.Relation == "videos" {
				t.Errorf("%s: sequential scan of media.videos:\n%s", name, raw)
			}
		})
		if !used {
			t.Errorf("%s: videos_owner_published is not used:\n%s", name, raw)
		}
		t.Logf("%s: %s", name, describe(plan, 0))
	}

	// And the answer is right: the 25 newest public videos of the 12 followed channels.
	rows, err := st.ListSubscriptionFeed(ctx, domain.SubscriptionFeedQuery{Subscriber: me.ID, Limit: 25})
	if err != nil || len(rows) != 25 {
		t.Fatalf("%d rows, %v", len(rows), err)
	}
	var want []uuid.UUID
	r, err := pg.Pool.Query(ctx, `SELECT id FROM media.videos WHERE owner_id = ANY($1) ORDER BY published_at DESC, id DESC LIMIT 25`, followed)
	if err != nil {
		t.Fatal(err)
	}
	for r.Next() {
		var id uuid.UUID
		if err := r.Scan(&id); err != nil {
			t.Fatal(err)
		}
		want = append(want, id)
	}
	r.Close()
	for i := range want {
		if rows[i].ID != want[i] {
			t.Fatalf("row %d: %s, want %s", i, rows[i].ID, want[i])
		}
	}
}

// describe renders a plan as one indented outline (node type, relation and index), for the test log.
func describe(n planNode, depth int) string {
	var b strings.Builder
	b.WriteString("\n" + strings.Repeat("  ", depth) + n.NodeType)
	if n.Relation != "" {
		b.WriteString(" on " + n.Relation)
	}
	if n.IndexName != "" {
		b.WriteString(" using " + n.IndexName)
	}
	for _, c := range n.Plans {
		b.WriteString(describe(c, depth+1))
	}
	return b.String()
}

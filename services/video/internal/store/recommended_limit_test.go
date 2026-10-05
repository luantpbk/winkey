package store

import (
	"context"
	"fmt"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/luantpbk/winkey/libs/go/testkit"
	"github.com/luantpbk/winkey/services/video/internal/api"
	"github.com/luantpbk/winkey/services/video/internal/domain"
	tu "github.com/luantpbk/winkey/services/video/internal/testutil"
)

func TestRecommendationCandidateLimitAndExplain(t *testing.T) {
	pg := testkit.StartPostgres(t)
	ctx := context.Background()
	now := time.Now().UTC().Truncate(time.Second)
	viewer := tu.SeedUser(t, pg.Pool, "limit_viewer", nil, "")
	main := tu.SeedUser(t, pg.Pool, "limit_main", nil, "")
	owners := make([]tu.User, 10)
	for i := range owners {
		owners[i] = tu.SeedUser(t, pg.Pool, fmt.Sprintf("limit_owner_%d", i), nil, "")
	}
	source := tu.SeedVideo(t, pg.Pool, tu.Video{Owner: owners[0].ID, Published: now.Add(-90 * 24 * time.Hour)}).ID
	key := strings.Repeat("a", 64) // synthetic fixture key, shared by both authenticated arms
	if _, err := pg.Pool.Exec(ctx, `INSERT INTO analytics.viewer_history(viewer_key,video_id,last_watched_at,watched_ms,refreshed_at) VALUES($1,$2,$3,20000,$3)`, key, source, now); err != nil {
		t.Fatal(err)
	}
	var top, alternatives []uuid.UUID
	for i := 0; i < 5; i++ {
		id := tu.SeedVideo(t, pg.Pool, tu.Video{Owner: main.ID, Published: now.Add(-time.Duration(i) * time.Minute)}).ID
		top = append(top, id)
		if _, err := pg.Pool.Exec(ctx, `INSERT INTO analytics.video_coview(video_id,neighbor_id,co_viewers,score,refreshed_at) VALUES($1,$2,3,1,$3)`, source, id, now); err != nil {
			t.Fatal(err)
		}
		if _, err := pg.Pool.Exec(ctx, `INSERT INTO media.trending(video_id,rank,score,computed_at) VALUES($1,$2,1,$3)`, id, i+1, now); err != nil {
			t.Fatal(err)
		}
	}
	for i := 0; i < 200; i++ {
		id := tu.SeedVideo(t, pg.Pool, tu.Video{Owner: owners[i%10].ID, Published: now.Add(-time.Duration(i+5) * time.Minute)}).ID
		alternatives = append(alternatives, id)
	}
	for i := 0; i < 1900; i++ {
		tu.SeedVideo(t, pg.Pool, tu.Video{Owner: main.ID, Published: now.Add(-time.Duration(i+205) * time.Minute)})
	}
	// Hand-built oracle: five top videos of one channel are deferred to positions 1,2,11,12,21.
	want := append([]uuid.UUID{}, top[:2]...)
	want = append(want, alternatives[:8]...)
	want = append(want, top[2:4]...)
	want = append(want, alternatives[8:16]...)
	want = append(want, top[4])
	want = append(want, alternatives[16:195]...)
	st := &Postgres{Pool: pg.Pool}
	for _, personalize := range []bool{true, false} {
		name := "reco"
		if !personalize {
			name = "control"
		}
		t.Run(name, func(t *testing.T) {
			// Only the test oracle removes the LIMIT; production always sends it to PostgreSQL.
			rows, err := pg.Pool.Query(ctx, strings.TrimSuffix(recommendationSQL, "\nLIMIT $5"), key, viewer.ID, now, personalize)
			if err != nil {
				t.Fatal(err)
			}
			var unbounded []domain.RecommendationCandidate
			for rows.Next() {
				var c domain.RecommendationCandidate
				if err := rows.Scan(&c.ID, &c.OwnerID, &c.Personal); err != nil {
					t.Fatal(err)
				}
				unbounded = append(unbounded, c)
			}
			if err := rows.Err(); err != nil {
				t.Fatal(err)
			}
			rows.Close()
			if len(unbounded) != 2105 || !reflect.DeepEqual(api.DiversifyRecommended(unbounded), want) {
				t.Fatal("unbounded fixture differs from the hand-built first 200")
			}
			for _, limit := range []int{0, 200, 300, 2000, 20000} {
				st.RecommendationCandidateLimit = limit
				candidates, err := st.RecommendationCandidates(ctx, key, viewer.ID, now, personalize)
				effective := limit
				if effective == 0 {
					effective = 2000
				}
				if err != nil || len(candidates) != min(2105, effective) {
					t.Fatalf("limit %d: rows %d err=%v", limit, len(candidates), err)
				}
				if !reflect.DeepEqual(candidates, unbounded[:min(2105, effective)]) || !reflect.DeepEqual(api.DiversifyRecommended(candidates), want) {
					t.Fatalf("limit %d changed SQL order or diversified first 200", limit)
				}
			}
			t.Log("2105 eligible candidates; limits 200/300/2000/20000 and default: exact SQL prefixes and the same hand-built first 200 as unbounded")
		})
	}
	// Explain the exact production query using anonymous parameters, which keep identifiers out of the plan output.
	rows, err := pg.Pool.Query(ctx, "EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF) "+recommendationSQL, "", uuid.Nil, now, false, 2000)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	var plan []string
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			t.Fatal(err)
		}
		plan = append(plan, line)
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if len(plan) == 0 || !strings.HasPrefix(plan[0], "Limit (actual rows=2000 ") {
		t.Fatal("EXPLAIN did not apply the candidate bound in PostgreSQL")
	}
	t.Log("EXPLAIN (ANALYZE, COSTS OFF, TIMING OFF, SUMMARY OFF), exact production SQL, anonymous arm, limit 2000:\n" + strings.Join(plan, "\n"))
}

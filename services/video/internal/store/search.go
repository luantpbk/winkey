package store

import (
	"context"
	"fmt"
	"strconv"
	"strings"

	"github.com/jackc/pgx/v5"

	"github.com/luantpbk/winkey/services/video/internal/domain"
)

// Video search (task SR1). The query text is folded IN SQL with public.winkey_fold,
// the same function the index expressions use (migration 000007), never in Go.
// Every query repeats the partial-index predicate literally so the planner can
// use videos_search_fts / videos_search_title_trgm.

const (
	// publicPredicate is the predicate of both partial indexes (and of the feed).
	publicPredicate = `v.status = 'READY' AND v.visibility = 'PUBLIC' AND v.moderation_state = 'VISIBLE'`

	ftsQuery  = `plainto_tsquery('simple', public.winkey_fold($1))`
	ftsRank   = `ts_rank_cd(v.search_vector, ` + ftsQuery + `)`
	trgmTitle = `public.winkey_fold(v.title)`
	trgmRank  = `similarity(` + trgmTitle + `, public.winkey_fold($1))`

	// pg_trgm.similarity_threshold used by the `%` operator (per transaction).
	trigramThreshold = "0.3"
)

// searchSQL builds the statement of one search mode. $1 is the raw query text;
// with after set, $2..$4 are the keyset position (rank, published_at, id).
// Order: rank DESC, published_at DESC, id DESC.
func searchSQL(mode string, after *domain.SearchAfter, limit int) (string, []any) {
	rank, match := ftsRank, `v.search_vector @@ `+ftsQuery
	if mode == domain.SearchTrgm {
		rank, match = trgmRank, trgmTitle+` % public.winkey_fold($1)`
	}
	var sb strings.Builder
	sb.WriteString(`
		SELECT v.id, v.title, v.duration_ms, v.view_count, v.published_at, v.thumbnail_key,
		       p.id, p.handle, p.display_name, p.avatar_key,
		       ` + rank + ` AS score
		FROM media.videos v
		JOIN auth.public_profiles p ON p.id = v.owner_id
		WHERE ` + publicPredicate + `
		  AND ` + match)
	args := []any{nil}
	arg := func(v any) string { args = append(args, v); return "$" + strconv.Itoa(len(args)) }
	if after != nil {
		r, t, id := arg(after.Rank), arg(after.T), arg(after.ID)
		sb.WriteString(` AND (` + rank + ` < ` + r + `::real OR (` + rank + ` = ` + r + `::real AND (v.published_at, v.id) < (` + t + `, ` + id + `)))`)
	}
	sb.WriteString(` ORDER BY score DESC, v.published_at DESC, v.id DESC LIMIT ` + arg(limit))
	return sb.String(), args
}

// SearchVideos runs one page of the search. Mode "" is the first page: full text
// first and, only when that finds nothing, the trigram fallback on the title.
func (p *Postgres) SearchVideos(ctx context.Context, q domain.SearchQuery) (domain.SearchResult, error) {
	tx, err := p.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return domain.SearchResult{}, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	// Transaction-local: the `%` operator reads it.
	if _, err := tx.Exec(ctx, `SET LOCAL pg_trgm.similarity_threshold = `+trigramThreshold); err != nil {
		return domain.SearchResult{}, fmt.Errorf("search: threshold: %w", err)
	}

	modes := []string{q.Mode}
	if q.Mode == "" {
		modes = []string{domain.SearchFTS, domain.SearchTrgm} // fallback only when the first page is empty
	}
	for _, mode := range modes {
		sql, args := searchSQL(mode, q.After, q.Limit)
		args[0] = q.Q
		hits, err := scanHits(ctx, tx, sql, args)
		if err != nil {
			return domain.SearchResult{}, fmt.Errorf("search %s: %w", mode, err)
		}
		if len(hits) > 0 || mode == modes[len(modes)-1] {
			return domain.SearchResult{Mode: mode, Hits: hits}, nil
		}
	}
	return domain.SearchResult{}, nil
}

func scanHits(ctx context.Context, tx pgx.Tx, sql string, args []any) ([]domain.SearchHit, error) {
	rows, err := tx.Query(ctx, sql, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []domain.SearchHit
	for rows.Next() {
		var h domain.SearchHit
		if err := rows.Scan(&h.ID, &h.Title, &h.DurationMs, &h.ViewCount, &h.PublishedAt, &h.ThumbnailKey,
			&h.Owner.ID, &h.Owner.Handle, &h.Owner.DisplayName, &h.Owner.AvatarKey, &h.Rank); err != nil {
			return nil, err
		}
		out = append(out, h)
	}
	return out, rows.Err()
}

// suggestSQL: titles of public videos whose folded title starts with the folded
// query (best), then titles similar to it. The LIKE pattern is escaped in SQL.
// Duplicates (same folded title) are collapsed; the outer query orders prefix
// matches first, then by similarity and popularity.
const suggestSQL = `
	SELECT title FROM (
		SELECT DISTINCT ON (f) title, pref, sim, view_count FROM (
			SELECT v.title, ` + trgmTitle + ` AS f, v.view_count,
			       (` + trgmTitle + ` LIKE esc.pattern) AS pref,
			       similarity(` + trgmTitle + `, public.winkey_fold($1)) AS sim
			FROM media.videos v
			JOIN auth.public_profiles p ON p.id = v.owner_id
			CROSS JOIN (SELECT replace(replace(replace(public.winkey_fold($1), '\', '\\'), '%', '\%'), '_', '\_') || '%' AS pattern) esc
			WHERE ` + publicPredicate + `
			  AND (` + trgmTitle + ` LIKE esc.pattern OR ` + trgmTitle + ` % public.winkey_fold($1))
		) c
		ORDER BY f, pref DESC, sim DESC, view_count DESC, title
	) d
	ORDER BY pref DESC, sim DESC, view_count DESC, title
	LIMIT $2`

// SuggestTitles returns up to limit distinct titles for a search box.
func (p *Postgres) SuggestTitles(ctx context.Context, q string, limit int) ([]string, error) {
	tx, err := p.Pool.BeginTx(ctx, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback(context.WithoutCancel(ctx)) }()
	if _, err := tx.Exec(ctx, `SET LOCAL pg_trgm.similarity_threshold = `+trigramThreshold); err != nil {
		return nil, fmt.Errorf("suggest: threshold: %w", err)
	}
	rows, err := tx.Query(ctx, suggestSQL, q, limit)
	if err != nil {
		return nil, fmt.Errorf("suggest: %w", err)
	}
	defer rows.Close()
	out := []string{}
	for rows.Next() {
		var t string
		if err := rows.Scan(&t); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

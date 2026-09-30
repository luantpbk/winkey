package store

import (
	"context"
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/luantpbk/winkey/services/video/internal/domain"
)

// Subscribe adds a row to media.subscriptions, the projection of social.subscription.changed (task R2-b).
// An existing row is left alone (its subscribed_at is the first event's), so a replay changes nothing.
func (p *Postgres) Subscribe(ctx context.Context, subscriber, channel uuid.UUID, at time.Time) error {
	if _, err := p.Pool.Exec(ctx, `
		INSERT INTO media.subscriptions (subscriber_id, channel_id, subscribed_at) VALUES ($1, $2, $3)
		ON CONFLICT DO NOTHING`, subscriber, channel, at); err != nil {
		return fmt.Errorf("subscribe: %w", err)
	}
	return nil
}

// Unsubscribe removes the row; a missing one is not an error (a replay, or an unsubscribe of a pair never seen).
func (p *Postgres) Unsubscribe(ctx context.Context, subscriber, channel uuid.UUID) error {
	if _, err := p.Pool.Exec(ctx, `DELETE FROM media.subscriptions WHERE subscriber_id = $1 AND channel_id = $2`, subscriber, channel); err != nil {
		return fmt.Errorf("unsubscribe: %w", err)
	}
	return nil
}

// subscriptionFeedSQL builds the feed of the channels a user follows, newest first. For each followed channel
// (an active owner: the join with auth.public_profiles is once per channel) a LATERAL subquery takes at most
// Limit of its newest public videos straight from the partial index videos_owner_published
// (owner_id, published_at DESC, id DESC), so a channel with thousands of videos costs Limit index entries, not
// thousands; the outer query merges those candidates and keeps the Limit newest. The predicate is the exact
// text of the index (and of the public feed). $1 is the subscriber; with after set, $2 and $3 are the keyset
// position (published_at, id).
func subscriptionFeedSQL(q domain.SubscriptionFeedQuery) (string, []any) {
	args := []any{q.Subscriber}
	arg := func(v any) string { args = append(args, v); return "$" + strconv.Itoa(len(args)) }
	var cursor string
	if q.After != nil {
		cursor = " AND (v.published_at, v.id) < (" + arg(q.After.T) + ", " + arg(q.After.ID) + ")"
	}
	limit := arg(q.Limit)
	var sb strings.Builder
	sb.WriteString(`
		SELECT v.id, v.title, v.duration_ms, v.view_count, v.published_at, v.thumbnail_key,
		       p.id, p.handle, p.display_name, p.avatar_key
		FROM media.subscriptions s
		JOIN auth.public_profiles p ON p.id = s.channel_id
		CROSS JOIN LATERAL (
			SELECT v.id, v.title, v.duration_ms, v.view_count, v.published_at, v.thumbnail_key
			FROM media.videos v
			WHERE v.owner_id = s.channel_id
			  AND v.status = 'READY' AND v.visibility = 'PUBLIC' AND v.moderation_state = 'VISIBLE'` + cursor + `
			ORDER BY v.published_at DESC, v.id DESC
			LIMIT ` + limit + `
		) v
		WHERE s.subscriber_id = $1
		ORDER BY v.published_at DESC, v.id DESC
		LIMIT ` + limit)
	return sb.String(), args
}

// ListSubscriptionFeed reads one page of the feed of the channels q.Subscriber follows.
func (p *Postgres) ListSubscriptionFeed(ctx context.Context, q domain.SubscriptionFeedQuery) ([]domain.Summary, error) {
	sql, args := subscriptionFeedSQL(q)
	rows, err := p.Pool.Query(ctx, sql, args...)
	if err != nil {
		return nil, fmt.Errorf("list subscription feed: %w", err)
	}
	defer rows.Close()
	var out []domain.Summary
	for rows.Next() {
		var s domain.Summary
		if err := rows.Scan(&s.ID, &s.Title, &s.DurationMs, &s.ViewCount, &s.PublishedAt, &s.ThumbnailKey,
			&s.Owner.ID, &s.Owner.Handle, &s.Owner.DisplayName, &s.Owner.AvatarKey); err != nil {
			return nil, err
		}
		out = append(out, s)
	}
	return out, rows.Err()
}

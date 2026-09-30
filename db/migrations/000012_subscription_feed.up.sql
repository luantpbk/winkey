-- Task R2-b (ADR-021): subscription feed. video-svc keeps its own copy of "who follows whom", projected from
-- social.subscription.changed (stream SOCIAL, durable video-subscriptions). No cross-schema FK (ADR-007).
CREATE TABLE media.subscriptions (
    subscriber_id uuid        NOT NULL,
    channel_id    uuid        NOT NULL,
    subscribed_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (subscriber_id, channel_id),
    CONSTRAINT media_subscriptions_not_self CHECK (subscriber_id <> channel_id)
);

-- One-time backfill: the SOCIAL stream keeps 7 days, older subscriptions exist only in social.subscriptions.
-- The migrator owns both schemas. The consumer then replays the stream from the start; replaying events that
-- are already reflected here is harmless (upsert / delete, applied in stream order).
INSERT INTO media.subscriptions (subscriber_id, channel_id, subscribed_at)
SELECT subscriber_id, channel_id, created_at FROM social.subscriptions
ON CONFLICT DO NOTHING;

-- Feed query: newest public videos of the channels a user follows.
CREATE INDEX videos_owner_published ON media.videos (owner_id, published_at DESC, id DESC)
    WHERE status = 'READY' AND visibility = 'PUBLIC' AND moderation_state = 'VISIBLE';

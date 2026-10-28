-- SOC-2a (ADR-049 addendum 2026-10-28): posts and feeds, owned by social-svc.
--   social.posts           text (≤ 2000), up to 10 images, an embedded Winkey video, or a reshare of another post
--   social.post_media      images of a post (copied from media.ready_images at creation; no cross-schema reads later)
--   social.post_reactions  one reaction per user and post
--   social.post_comments   two-level comments on posts (same rules as social.comments on videos)
--   social.post_hashtags   #hashtags, matched on the same slug as video tags (public.winkey_tag_slug)
--   social.post_mentions   @mentions (resolved user ids)
--   social.post_scores     "Khám phá" ranking, recomputed periodically by social-svc
--   notifications: post_id / post_comment_id and five POST_* kinds; reports: POST and POST_COMMENT targets.
-- IDs are UUIDv7 from the app (ADR-010); no cross-schema FKs (ADR-007).

CREATE TYPE social.post_visibility AS ENUM ('PUBLIC', 'FOLLOWERS');
CREATE TYPE social.post_status AS ENUM ('VISIBLE', 'DELETED', 'HIDDEN');
CREATE TYPE social.reaction_kind AS ENUM ('LIKE', 'LOVE', 'HAHA', 'WOW', 'SAD', 'ANGRY');

CREATE TABLE social.posts (
    id             uuid PRIMARY KEY,
    author_id      uuid NOT NULL,
    body           text NOT NULL DEFAULT '',
    visibility     social.post_visibility NOT NULL DEFAULT 'PUBLIC',  -- a private account's posts are FOLLOWERS-only
    status         social.post_status NOT NULL DEFAULT 'VISIBLE',
    video_id       uuid REFERENCES social.videos (id) ON DELETE SET NULL,  -- embedded Winkey video
    reshare_of     uuid REFERENCES social.posts (id) ON DELETE SET NULL,   -- always the original, never a reshare
    media_count    smallint NOT NULL DEFAULT 0,
    reaction_count bigint NOT NULL DEFAULT 0,   -- maintained by trigger
    comment_count  bigint NOT NULL DEFAULT 0,   -- VISIBLE comments incl. replies; maintained by trigger
    reshare_count  bigint NOT NULL DEFAULT 0,   -- VISIBLE reshares; maintained by trigger
    edited_at      timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now(),
    updated_at     timestamptz NOT NULL DEFAULT now(),
    -- HIDDEN keeps the body so a moderator can restore it; DELETED wipes it.
    CONSTRAINT posts_body_len CHECK (status = 'DELETED' OR char_length(body) <= 2000),
    CONSTRAINT posts_deleted_empty CHECK (status <> 'DELETED' OR body = ''),
    CONSTRAINT posts_media_count CHECK (media_count BETWEEN 0 AND 10),
    CONSTRAINT posts_counts CHECK (reaction_count >= 0 AND comment_count >= 0 AND reshare_count >= 0),
    CONSTRAINT posts_not_own_reshare CHECK (reshare_of IS NULL OR reshare_of <> id)
);
-- Profile timeline and the "Đang theo dõi" feed (one index range per followed author, merged by created_at, id).
CREATE INDEX posts_author_timeline ON social.posts (author_id, created_at DESC, id DESC) WHERE status = 'VISIBLE';
-- Explore candidates: recent public posts.
CREATE INDEX posts_public_recent ON social.posts (created_at DESC, id DESC)
    WHERE status = 'VISIBLE' AND visibility = 'PUBLIC';
CREATE INDEX posts_reshare_of ON social.posts (reshare_of) WHERE reshare_of IS NOT NULL;
CREATE INDEX posts_video ON social.posts (video_id) WHERE video_id IS NOT NULL;
-- A user reshares a given post at most once without adding text ("plain" reshare); quote reshares are not limited.
CREATE UNIQUE INDEX posts_one_plain_reshare ON social.posts (author_id, reshare_of)
    WHERE reshare_of IS NOT NULL AND status = 'VISIBLE' AND body = '' AND media_count = 0 AND video_id IS NULL;

-- Only body / status / visibility edits bump updated_at, so counter updates do not.
CREATE TRIGGER posts_set_updated_at
    BEFORE UPDATE OF body, status, visibility ON social.posts
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- reshare_count follows VISIBLE transitions of the resharing post.
CREATE FUNCTION social.post_reshare_counts() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    d integer := 0;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.reshare_of IS NOT NULL AND NEW.status = 'VISIBLE' THEN d := 1; END IF;
    ELSIF NEW.reshare_of IS NOT NULL THEN
        IF OLD.status = 'VISIBLE' AND NEW.status <> 'VISIBLE' THEN d := -1;
        ELSIF OLD.status <> 'VISIBLE' AND NEW.status = 'VISIBLE' THEN d := 1;
        END IF;
    END IF;
    IF d <> 0 THEN
        UPDATE social.posts SET reshare_count = reshare_count + d WHERE id = NEW.reshare_of;
    END IF;
    RETURN NULL;
END
$$;

CREATE TRIGGER posts_reshare_counts
    AFTER INSERT OR UPDATE OF status ON social.posts
    FOR EACH ROW EXECUTE FUNCTION social.post_reshare_counts();

CREATE TABLE social.post_media (
    post_id   uuid NOT NULL REFERENCES social.posts (id) ON DELETE CASCADE,
    position  smallint NOT NULL,
    image_id  uuid NOT NULL,                -- media.images.id (purpose POST, READY, owned by the author)
    image_key text NOT NULL,                -- winkey-media keys copied from media.ready_images
    thumb_key text NOT NULL,
    width     integer NOT NULL,
    height    integer NOT NULL,
    PRIMARY KEY (post_id, position),
    CONSTRAINT post_media_position CHECK (position BETWEEN 0 AND 9),
    CONSTRAINT post_media_size CHECK (width > 0 AND height > 0)
);
-- An image belongs to one post; storage-gc (image-unreferenced) checks POST images against this index.
CREATE UNIQUE INDEX post_media_image ON social.post_media (image_id);

CREATE TABLE social.post_reactions (
    post_id    uuid NOT NULL REFERENCES social.posts (id) ON DELETE CASCADE,
    user_id    uuid NOT NULL,
    reaction   social.reaction_kind NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (post_id, user_id)
);
-- listPostReactions (all, or one kind), newest first.
CREATE INDEX post_reactions_post ON social.post_reactions (post_id, created_at DESC, user_id);
CREATE INDEX post_reactions_post_kind ON social.post_reactions (post_id, reaction, created_at DESC, user_id);
CREATE INDEX post_reactions_user ON social.post_reactions (user_id, created_at DESC);

-- reaction_count counts reactions of any kind; changing the kind does not change it.
CREATE FUNCTION social.post_reaction_counts() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE social.posts SET reaction_count = reaction_count + 1 WHERE id = NEW.post_id;
    ELSE
        UPDATE social.posts SET reaction_count = reaction_count - 1 WHERE id = OLD.post_id;
    END IF;
    RETURN NULL;
END
$$;

CREATE TRIGGER post_reactions_counts
    AFTER INSERT OR DELETE ON social.post_reactions
    FOR EACH ROW EXECUTE FUNCTION social.post_reaction_counts();

CREATE TABLE social.post_comments (
    id          uuid PRIMARY KEY,
    post_id     uuid NOT NULL REFERENCES social.posts (id) ON DELETE CASCADE,
    author_id   uuid NOT NULL,
    parent_id   uuid REFERENCES social.post_comments (id) ON DELETE CASCADE,  -- NULL = top level
    body        text NOT NULL,
    status      social.comment_status NOT NULL DEFAULT 'VISIBLE',
    reply_count integer NOT NULL DEFAULT 0,   -- VISIBLE replies; maintained by trigger
    edited_at   timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT post_comments_body_len CHECK (status = 'DELETED' OR char_length(body) BETWEEN 1 AND 2000),
    CONSTRAINT post_comments_deleted_empty CHECK (status <> 'DELETED' OR body = ''),
    CONSTRAINT post_comments_not_own_parent CHECK (parent_id IS NULL OR parent_id <> id),
    CONSTRAINT post_comments_reply_count CHECK (reply_count >= 0)
);
CREATE INDEX post_comments_top_level ON social.post_comments (post_id, created_at DESC, id DESC) WHERE parent_id IS NULL;
CREATE INDEX post_comments_replies ON social.post_comments (parent_id, created_at, id) WHERE parent_id IS NOT NULL;
CREATE INDEX post_comments_author ON social.post_comments (author_id, created_at DESC);

CREATE TRIGGER post_comments_set_updated_at
    BEFORE UPDATE OF body, status ON social.post_comments
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- Exactly two levels: a reply's parent must be a top-level comment on the same post.
CREATE FUNCTION social.guard_post_comment_parent() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    p_post   uuid;
    p_parent uuid;
BEGIN
    IF NEW.parent_id IS NULL THEN
        RETURN NEW;
    END IF;
    SELECT post_id, parent_id INTO p_post, p_parent FROM social.post_comments WHERE id = NEW.parent_id;
    IF NOT FOUND THEN
        RETURN NEW;  -- the foreign key reports it
    END IF;
    IF p_parent IS NOT NULL THEN
        RAISE EXCEPTION 'post comment % replies to a reply (only two levels allowed)', NEW.id
            USING ERRCODE = 'check_violation';
    END IF;
    IF p_post <> NEW.post_id THEN
        RAISE EXCEPTION 'post comment % replies to a comment on another post', NEW.id
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER post_comments_guard_parent
    BEFORE INSERT OR UPDATE OF parent_id, post_id ON social.post_comments
    FOR EACH ROW EXECUTE FUNCTION social.guard_post_comment_parent();

-- comment_count / reply_count follow VISIBLE transitions (insert, hide, delete, restore).
CREATE FUNCTION social.post_comment_counts() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
    d integer := 0;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.status = 'VISIBLE' THEN d := 1; END IF;
    ELSIF OLD.status = 'VISIBLE' AND NEW.status <> 'VISIBLE' THEN
        d := -1;
    ELSIF OLD.status <> 'VISIBLE' AND NEW.status = 'VISIBLE' THEN
        d := 1;
    END IF;
    IF d = 0 THEN
        RETURN NULL;
    END IF;
    UPDATE social.posts SET comment_count = comment_count + d WHERE id = NEW.post_id;
    IF NEW.parent_id IS NOT NULL THEN
        UPDATE social.post_comments SET reply_count = reply_count + d WHERE id = NEW.parent_id;
    END IF;
    RETURN NULL;
END
$$;

CREATE TRIGGER post_comments_counts
    AFTER INSERT OR UPDATE OF status ON social.post_comments
    FOR EACH ROW EXECUTE FUNCTION social.post_comment_counts();

-- #hashtags as typed (first spelling in the post), matched on the video-tag slug: #HàNội, #hanoi and #HANOI share
-- the slug hanoi (#ha_noi is ha-noi). Tags whose slug is empty are not stored. created_at copies the post's for keyset paging.
CREATE TABLE social.post_hashtags (
    post_id    uuid NOT NULL REFERENCES social.posts (id) ON DELETE CASCADE,
    tag        text NOT NULL,
    slug       text GENERATED ALWAYS AS (public.winkey_tag_slug(tag)) STORED,
    created_at timestamptz NOT NULL,
    PRIMARY KEY (post_id, slug),
    CONSTRAINT post_hashtags_tag_len CHECK (char_length(tag) BETWEEN 1 AND 50),
    CONSTRAINT post_hashtags_slug CHECK (slug <> '')
);
CREATE INDEX post_hashtags_slug ON social.post_hashtags (slug, created_at DESC, post_id DESC);
CREATE INDEX post_hashtags_recent ON social.post_hashtags (created_at);

CREATE TABLE social.post_mentions (
    post_id uuid NOT NULL REFERENCES social.posts (id) ON DELETE CASCADE,
    user_id uuid NOT NULL,
    PRIMARY KEY (post_id, user_id)
);
CREATE INDEX post_mentions_user ON social.post_mentions (user_id);

-- "Khám phá": one row per ranked post, replaced by the scoring job.
CREATE TABLE social.post_scores (
    post_id     uuid PRIMARY KEY REFERENCES social.posts (id) ON DELETE CASCADE,
    score       double precision NOT NULL,
    computed_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX post_scores_rank ON social.post_scores (score DESC, post_id DESC);

-- Notifications on posts. kind::text: a new enum value cannot be referenced as a literal in the transaction
-- that adds it.
ALTER TYPE social.notification_kind ADD VALUE IF NOT EXISTS 'POST_COMMENT';
ALTER TYPE social.notification_kind ADD VALUE IF NOT EXISTS 'POST_COMMENT_REPLY';
ALTER TYPE social.notification_kind ADD VALUE IF NOT EXISTS 'POST_MENTION';
ALTER TYPE social.notification_kind ADD VALUE IF NOT EXISTS 'POST_RESHARE';
ALTER TYPE social.notification_kind ADD VALUE IF NOT EXISTS 'POST_REACTION';

ALTER TABLE social.notifications
    ADD COLUMN post_id uuid REFERENCES social.posts (id) ON DELETE CASCADE,
    ADD COLUMN post_comment_id uuid REFERENCES social.post_comments (id) ON DELETE CASCADE;

ALTER TABLE social.notifications DROP CONSTRAINT notifications_refs;
ALTER TABLE social.notifications ADD CONSTRAINT notifications_refs CHECK (
    (kind::text = 'VIDEO_PUBLISHED' AND video_id IS NOT NULL AND comment_id IS NULL
        AND post_id IS NULL AND post_comment_id IS NULL)
    OR (kind::text IN ('VIDEO_COMMENT', 'COMMENT_REPLY') AND video_id IS NOT NULL AND comment_id IS NOT NULL
        AND post_id IS NULL AND post_comment_id IS NULL)
    OR (kind::text IN ('NEW_SUBSCRIBER', 'FOLLOW_REQUEST', 'FOLLOW_REQUEST_APPROVED') AND video_id IS NULL
        AND comment_id IS NULL AND post_id IS NULL AND post_comment_id IS NULL)
    OR (kind::text IN ('POST_COMMENT', 'POST_COMMENT_REPLY') AND post_id IS NOT NULL AND post_comment_id IS NOT NULL
        AND video_id IS NULL AND comment_id IS NULL)
    OR (kind::text IN ('POST_MENTION', 'POST_RESHARE', 'POST_REACTION') AND post_id IS NOT NULL
        AND post_comment_id IS NULL AND video_id IS NULL AND comment_id IS NULL)
);

-- Subject = the post comment, else the comment, else the post, else the video, else the actor; plus the actor, so
-- POST_REACTION notifies once per reacting user and post. For the older kinds the subject already fixes the actor,
-- so their dedup is unchanged. POST_RESHARE's post_id is the new reshare.
DROP INDEX social.notifications_dedup;
CREATE UNIQUE INDEX notifications_dedup ON social.notifications
    (user_id, kind, COALESCE(post_comment_id, comment_id, post_id, video_id, actor_id), actor_id);
CREATE INDEX notifications_post ON social.notifications (post_id) WHERE post_id IS NOT NULL;
CREATE INDEX notifications_post_comment ON social.notifications (post_comment_id) WHERE post_comment_id IS NOT NULL;

ALTER TYPE social.report_target ADD VALUE IF NOT EXISTS 'POST';
ALTER TYPE social.report_target ADD VALUE IF NOT EXISTS 'POST_COMMENT';

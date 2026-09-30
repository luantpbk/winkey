-- Task PL1 (ADR-024): playlists and the watch-later list, owned by social-svc. Items reference the social.videos
-- projection, so deleting a video (video.deleted) removes it from every playlist.
CREATE TYPE social.playlist_kind AS ENUM ('REGULAR', 'WATCH_LATER');

CREATE TABLE social.playlists (
    id          uuid PRIMARY KEY,                   -- UUIDv7 from the app
    owner_id    uuid NOT NULL,
    kind        social.playlist_kind NOT NULL DEFAULT 'REGULAR',
    title       text NOT NULL,
    description text NOT NULL DEFAULT '',
    visibility  text NOT NULL DEFAULT 'PRIVATE',
    item_count  integer NOT NULL DEFAULT 0,         -- maintained by trigger; the cap enforces PLAYLIST_FULL
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(), -- bumped by the item trigger too
    CONSTRAINT playlists_title_len CHECK (char_length(title) BETWEEN 1 AND 150),
    CONSTRAINT playlists_description_len CHECK (char_length(description) <= 5000),
    CONSTRAINT playlists_visibility CHECK (visibility IN ('PUBLIC', 'UNLISTED', 'PRIVATE')),
    CONSTRAINT playlists_watch_later_private CHECK (kind <> 'WATCH_LATER' OR visibility = 'PRIVATE'),
    CONSTRAINT playlists_item_count CHECK (item_count BETWEEN 0 AND 5000)
);
-- One watch-later list per user; getWatchLater creates it with INSERT … ON CONFLICT DO NOTHING.
CREATE UNIQUE INDEX playlists_one_watch_later ON social.playlists (owner_id) WHERE kind = 'WATCH_LATER';
-- listChannelPlaylists (owner view and public view).
CREATE INDEX playlists_owner ON social.playlists (owner_id, updated_at DESC, id DESC);

CREATE TABLE social.playlist_items (
    playlist_id uuid NOT NULL REFERENCES social.playlists (id) ON DELETE CASCADE,
    video_id    uuid NOT NULL REFERENCES social.videos (id) ON DELETE CASCADE,
    position    bigint NOT NULL,                    -- sparse sort key (gaps of 2^20); renumbered when a gap closes
    added_at    timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (playlist_id, video_id),
    -- Deferrable so a renumbering UPDATE may pass through temporary duplicates inside one transaction.
    CONSTRAINT playlist_items_position UNIQUE (playlist_id, position) DEFERRABLE INITIALLY IMMEDIATE
);
CREATE INDEX playlist_items_video ON social.playlist_items (video_id);

CREATE FUNCTION social.playlist_item_counts() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        UPDATE social.playlists SET item_count = item_count + 1, updated_at = now() WHERE id = NEW.playlist_id;
    ELSIF TG_OP = 'DELETE' THEN
        -- On a playlist delete the parent row is already gone: the UPDATE matches nothing, which is fine.
        UPDATE social.playlists SET item_count = item_count - 1, updated_at = now() WHERE id = OLD.playlist_id;
    ELSE
        UPDATE social.playlists SET updated_at = now() WHERE id = NEW.playlist_id;
    END IF;
    RETURN NULL;
END
$$;

CREATE TRIGGER playlist_items_counts
    AFTER INSERT OR DELETE OR UPDATE OF position ON social.playlist_items
    FOR EACH ROW EXECUTE FUNCTION social.playlist_item_counts();

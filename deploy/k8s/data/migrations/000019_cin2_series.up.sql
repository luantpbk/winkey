-- Task CIN2 (ADR-035): a REGULAR playlist can be marked as a series ("Bộ phim"). Episodes are the playlist items in
-- position order; social-svc decides which ones are playable from its own social.videos projection (READY, PUBLIC,
-- not hidden), so no cross-schema read and no new projection (ADR-007).
ALTER TABLE social.playlists
    ADD COLUMN is_series boolean NOT NULL DEFAULT false,
    ADD CONSTRAINT playlists_series_regular CHECK (NOT is_series OR kind = 'REGULAR');

-- listCinemaCatalog: public series, newest first.
CREATE INDEX playlists_public_series ON social.playlists (updated_at DESC, id DESC)
    WHERE is_series AND visibility = 'PUBLIC';
-- listCinemaCatalog: public standalone videos, newest first.
CREATE INDEX videos_catalog ON social.videos (created_at DESC, id DESC)
    WHERE visibility = 'PUBLIC' AND NOT hidden;

-- A series only holds videos of the playlist owner. Enforced here as well as in social-svc (409 SERIES_FOREIGN_ITEM),
-- so a race between "mark as series" and "add item" cannot leave a foreign video inside a series.
CREATE FUNCTION social.series_owner_check() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    IF TG_TABLE_NAME = 'playlist_items' THEN
        IF EXISTS (SELECT 1
                     FROM social.playlists p
                     JOIN social.videos v ON v.id = NEW.video_id
                    WHERE p.id = NEW.playlist_id AND p.is_series AND v.owner_id <> p.owner_id) THEN
            RAISE EXCEPTION 'SERIES_FOREIGN_ITEM' USING ERRCODE = '23514';
        END IF;
    ELSIF NEW.is_series AND NOT OLD.is_series THEN
        IF EXISTS (SELECT 1
                     FROM social.playlist_items i
                     JOIN social.videos v ON v.id = i.video_id
                    WHERE i.playlist_id = NEW.id AND v.owner_id <> NEW.owner_id) THEN
            RAISE EXCEPTION 'SERIES_FOREIGN_ITEM' USING ERRCODE = '23514';
        END IF;
    END IF;
    RETURN NEW;
END
$$;

CREATE TRIGGER playlist_items_series_owner
    BEFORE INSERT ON social.playlist_items
    FOR EACH ROW EXECUTE FUNCTION social.series_owner_check();

CREATE TRIGGER playlists_series_owner
    BEFORE UPDATE OF is_series ON social.playlists
    FOR EACH ROW EXECUTE FUNCTION social.series_owner_check();

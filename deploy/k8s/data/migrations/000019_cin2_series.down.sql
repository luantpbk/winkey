DROP TRIGGER IF EXISTS playlists_series_owner ON social.playlists;
DROP TRIGGER IF EXISTS playlist_items_series_owner ON social.playlist_items;
DROP FUNCTION IF EXISTS social.series_owner_check();
DROP INDEX IF EXISTS social.videos_catalog;
DROP INDEX IF EXISTS social.playlists_public_series;
ALTER TABLE social.playlists
    DROP CONSTRAINT IF EXISTS playlists_series_regular,
    DROP COLUMN IF EXISTS is_series;

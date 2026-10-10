DROP INDEX IF EXISTS media.videos_search_fts;
ALTER TABLE media.videos DROP COLUMN IF EXISTS search_vector;
ALTER TABLE media.videos
    ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', public.winkey_fold(title)), 'A')
        || setweight(to_tsvector('simple', public.winkey_fold(left(description, 2000))), 'B')
    ) STORED;
CREATE INDEX videos_search_fts ON media.videos USING gin (search_vector)
    WHERE status = 'READY' AND visibility = 'PUBLIC' AND moderation_state = 'VISIBLE';
ALTER TABLE media.videos
    DROP CONSTRAINT IF EXISTS videos_tags_max,
    DROP COLUMN IF EXISTS tags;
DROP FUNCTION IF EXISTS public.winkey_tags_text(text[]);

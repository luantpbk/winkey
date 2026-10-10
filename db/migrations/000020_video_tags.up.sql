-- Task TAG1 (ADR-036): up to 10 owner-chosen tags per video. They feed in-app search (same weight as the title)
-- and related videos; Google ignores meta keywords, so tags are not an SEO feature.
ALTER TABLE media.videos
    ADD COLUMN tags text[] NOT NULL DEFAULT '{}',
    ADD CONSTRAINT videos_tags_max CHECK (cardinality(tags) <= 10);

-- array_to_string is STABLE in general (it calls element output functions), but for text[] it is pure, so this
-- wrapper may be IMMUTABLE and used in the generated column below.
CREATE FUNCTION public.winkey_tags_text(tags text[]) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
RETURN array_to_string(tags, ' ');

-- Rebuild the search vector with the tags (weight A, like the title). A generated column's expression cannot be
-- changed in place on PostgreSQL 16, so drop and re-add it; the partial GIN index goes with it and is recreated.
DROP INDEX media.videos_search_fts;
ALTER TABLE media.videos DROP COLUMN search_vector;
ALTER TABLE media.videos
    ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', public.winkey_fold(title)), 'A')
        || setweight(to_tsvector('simple', public.winkey_fold(public.winkey_tags_text(tags))), 'A')
        || setweight(to_tsvector('simple', public.winkey_fold(left(description, 2000))), 'B')
    ) STORED;
CREATE INDEX videos_search_fts ON media.videos USING gin (search_vector)
    WHERE status = 'READY' AND visibility = 'PUBLIC' AND moderation_state = 'VISIBLE';

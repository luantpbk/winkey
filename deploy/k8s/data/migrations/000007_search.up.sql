-- Task SR1: video search with PostgreSQL FTS + unaccent + pg_trgm (DECISIONS: "OpenSearch → PostgreSQL FTS").
-- Vietnamese has no stemmer in PostgreSQL, so text is folded (lower + unaccent) and indexed with the
-- `simple` configuration: "Hà Nội" and "ha noi" match each other. pg_trgm covers typos and prefixes.

-- unaccent() is STABLE (it reads its dictionary through search_path), so it cannot be used in a generated
-- column or an index directly. This wrapper pins the dictionary and schema, which makes it safe to mark
-- IMMUTABLE. Owned by the migration role; no superuser needed (unaccent is a trusted extension).
CREATE FUNCTION public.winkey_fold(input text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
RETURN lower(public.unaccent('public.unaccent'::regdictionary, input));

ALTER TABLE media.videos
    ADD COLUMN search_vector tsvector GENERATED ALWAYS AS (
        setweight(to_tsvector('simple', public.winkey_fold(title)), 'A')
        || setweight(to_tsvector('simple', public.winkey_fold(left(description, 2000))), 'B')
    ) STORED;

-- Only what search can return: PUBLIC + READY + not hidden by a moderator.
CREATE INDEX videos_search_fts ON media.videos USING gin (search_vector)
    WHERE status = 'READY' AND visibility = 'PUBLIC' AND moderation_state = 'VISIBLE';
CREATE INDEX videos_search_title_trgm ON media.videos USING gin (public.winkey_fold(title) gin_trgm_ops)
    WHERE status = 'READY' AND visibility = 'PUBLIC' AND moderation_state = 'VISIBLE';

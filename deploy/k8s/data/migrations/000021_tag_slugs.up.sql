-- Task SEO2 (ADR-037): tag landing pages /tag/<slug>. The slug is derived here, once, from the stored tag text, so
-- video-svc and the web never re-implement the Vietnamese folding. Slug = winkey_fold (lower-case, unaccent, đ → d),
-- every run of characters other than a-z0-9 replaced by '-', leading/trailing '-' trimmed. A tag with no Latin
-- letter or digit gets the empty slug '' (kept, so tag_slugs[i] always belongs to tags[i]).
CREATE FUNCTION public.winkey_tag_slug(tag text) RETURNS text
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
RETURN btrim(regexp_replace(public.winkey_fold(tag), '[^a-z0-9]+', '-', 'g'), '-');

CREATE FUNCTION public.winkey_tag_slugs(tags text[]) RETURNS text[]
LANGUAGE sql IMMUTABLE PARALLEL SAFE STRICT
RETURN ARRAY(SELECT public.winkey_tag_slug(t) FROM unnest(tags) WITH ORDINALITY AS u(t, i) ORDER BY i);

ALTER TABLE media.videos
    ADD COLUMN tag_slugs text[] GENERATED ALWAYS AS (public.winkey_tag_slugs(tags)) STORED;

-- Only what a tag page can list: the same predicate as the public feed and search indexes.
CREATE INDEX videos_tag_slugs_gin ON media.videos USING gin (tag_slugs)
    WHERE status = 'READY' AND visibility = 'PUBLIC' AND moderation_state = 'VISIBLE';

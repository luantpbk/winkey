DROP INDEX IF EXISTS media.videos_tag_slugs_gin;
ALTER TABLE media.videos DROP COLUMN IF EXISTS tag_slugs;
DROP FUNCTION IF EXISTS public.winkey_tag_slugs(text[]);
DROP FUNCTION IF EXISTS public.winkey_tag_slug(text);

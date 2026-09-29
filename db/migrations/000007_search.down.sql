DROP INDEX IF EXISTS media.videos_search_title_trgm;
DROP INDEX IF EXISTS media.videos_search_fts;
ALTER TABLE media.videos DROP COLUMN IF EXISTS search_vector;
DROP FUNCTION IF EXISTS public.winkey_fold(text);

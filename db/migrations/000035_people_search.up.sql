-- SOC-6a (ADR-049, task SOC-6a): find people by handle or display name (social-svc `searchPeople`).
-- social-svc reads auth.public_profiles (= auth.users WHERE status = 'ACTIVE'), so every index is partial on that
-- predicate and the planner uses it through the view. Handles match by prefix (case-insensitive); display names are
-- folded with public.winkey_fold (lower + unaccent, đ → d) and match by prefix, or by substring when the query has at
-- least 3 characters (pg_trgm). No search may sequentially scan auth.users (EXPLAIN test: db/tests/033).

CREATE INDEX users_search_handle_prefix ON auth.users (lower(handle::text) text_pattern_ops)
    WHERE status = 'ACTIVE';
CREATE INDEX users_search_name_prefix ON auth.users (public.winkey_fold(display_name) text_pattern_ops)
    WHERE status = 'ACTIVE';
CREATE INDEX users_search_name_trgm ON auth.users USING gin (public.winkey_fold(display_name) gin_trgm_ops)
    WHERE status = 'ACTIVE';

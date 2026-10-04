export interface paths {
    "/v1/videos": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Public feed, newest first (or trending with `sort=trending`). Optional auth.
         * @description Task R2-a (ADR-020) — `sort=trending` returns the current trending ranking (recomputed every 10 minutes
         *     from views of the last 72 h), best first, only videos the public feed would show. At most 200 videos in
         *     total; the cursor pages through that ranking. The ranking may be empty (no recent views): the client
         *     then shows the newest feed. `owner_id` together with `sort=trending` → `400` `INVALID_SORT`.
         *     Trending responses carry `Cache-Control: public, max-age=60`.
         */
        get: operations["listVideos"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/videos/batch": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Summaries of up to 50 videos by id, in request order (task PL1). Optional auth.
         * @description For playlist pages and other lists stored outside video-svc (ADR-024). Returns only the videos the caller
         *     could open with `getVideo` right now (READY, not hidden, `PRIVATE` only for the owner); unknown or unreadable
         *     ids are silently left out, so `items` can be shorter than `ids`. Duplicates in `ids` → `400`. Reuses the
         *     video cache. `Cache-Control: private, no-store` when authenticated, otherwise `public, max-age=30`.
         *     Static route: it must be matched before `/v1/videos/{video_id}`.
         */
        get: operations["batchGetVideos"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/videos/{video_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
            };
            cookie?: never;
        };
        /** Watch page data. Optional auth. */
        get: operations["getVideo"];
        put?: never;
        post?: never;
        /** Delete (owner, moderator or admin). Emits `video.deleted`; objects are removed asynchronously. */
        delete: operations["deleteVideo"];
        options?: never;
        head?: never;
        /**
         * Edit metadata (owner only).
         * @description Task C4: when `visibility` actually changes, `video.visibility_changed` is written to the outbox in the
         *     same transaction (not emitted for a no-op or for other fields).
         */
        patch: operations["updateVideo"];
        trace?: never;
    };
    "/v1/videos/{video_id}/related": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
            };
            cookie?: never;
        };
        /**
         * Videos to watch next, shown beside the player (task R2-c). No auth needed.
         * @description Recommendation v1 without personalisation (ADR-025). Candidates are only videos the public can watch
         *     (`PUBLIC`, `READY`, not hidden), never the video itself, each at most once. Built from three sources:
         *     1. up to 8 videos whose title/description match the source title (the search index of SR1);
         *     2. up to 4 newest videos of the same channel;
         *     3. the current trending ranking (R2-a) to fill up to `limit`.
         *     Order of `items`: the sources interleaved in the order 1, 1, 2, 1, 3, ... with duplicates skipped (see
         *     ADR-025). Same answer for every caller, so `Cache-Control: public, max-age=300`. The source video
         *     itself must be readable by the caller like `getVideo`, otherwise `404`.
         */
        get: operations["listRelatedVideos"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/videos/{video_id}/views": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Report one qualified playback (task C3). Optional auth.
         * @description The player calls this once per playback, after the viewer has watched at least
         *     `min(30 s, duration_ms / 2)` (sum of played time, seeking excluded). The server re-checks the
         *     threshold against `duration_ms` and ignores reports below it.
         *
         *     Counting rules (anti-inflation):
         *     - The video must be readable by the caller (same rules as `GET /v1/videos/{video_id}`) and `READY`.
         *     - One counted view per **viewer** per video per **30 minutes**. The viewer is the user id when
         *       authenticated, otherwise `sha256(client_ip + user_agent)`. `client_ip` is taken from
         *       `X-Forwarded-For` only when the peer is in `TRUST_PROXY_CIDRS`. Dedup key in Valkey:
         *       `views:seen:{video_id}:{viewer}` (`SET NX EX 1800`).
         *     - The same `playback_id` is counted at most once (retries are safe).
         *     - Rate limit per client IP: 60 reports per minute (`429`).
         *     - Counted views are buffered in Valkey and added to `media.videos.view_count` in batches at
         *       least every 30 s, so `view_count` in other responses is eventually consistent (≤ 30 s plus
         *       the cache TTL). A buffered view is never lost on a flush failure: it is retried.
         *
         *     The response does not reveal why a report was not counted beyond `counted: false`.
         */
        post: operations["recordView"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/playback/heartbeats": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Report player QoE and watch-time samples (task R1, ADR-022). Optional auth.
         * @description The player sends a batch of samples of the playbacks it is running: one `start` when the first frame is
         *     shown, one `heartbeat` about every 30 s while the page is open, and one `end` when the playback stops
         *     (`navigator.sendBeacon` on page hide). Each sample carries the **deltas since the previous sample of the
         *     same playback** (`watched_ms`, `rebuffer_ms`, `rebuffer_count`), so losing a sample loses only its own
         *     interval and nothing is counted twice.
         *
         *     video-svc validates the batch, drops samples of videos it does not know or the caller may not read, and
         *     publishes one `analytics.playback` event per accepted sample to JetStream (stream `ANALYTICS`). This is
         *     telemetry, not a domain event: it is published directly (no outbox) and a publish failure is not an error
         *     for the client (the samples are dropped and a metric is incremented). The data ends up in ClickHouse on
         *     gpu-01; nothing is stored in PostgreSQL and nothing in this response depends on it.
         *
         *     Privacy: the server never forwards the IP address or the user agent. The viewer is identified by
         *     `viewer_key` = HMAC-SHA256(`ANALYTICS_VIEWER_SALT`, user id or C3's anonymous viewer hash), so
         *     ClickHouse never holds a user id in clear.
         *
         *     Limits: at most 20 samples per request, body ≤ 16 KiB, rate limit 30 requests per minute per client IP
         *     (`429`). `view` counting stays with `recordView` (C3); this endpoint never changes `view_count`.
         */
        post: operations["recordPlaybackHeartbeats"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/studio/videos": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The caller's own videos in every status, newest first. */
        get: operations["listStudioVideos"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/studio/videos/{video_id}/stats": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
            };
            cookie?: never;
        };
        /**
         * Daily player statistics of one of the caller's videos (task R1-b). Owner or admin only.
         * @description Read from `analytics.video_daily` in PostgreSQL, which analytics-worker refreshes from ClickHouse every few
         *     minutes (ADR-022 addendum R1-b). While gpu-01 is off the numbers stop advancing; `refreshed_at` says how old
         *     they are. Days are calendar days in `Asia/Ho_Chi_Minh`. `days` holds EVERY day of the range in ascending
         *     order, with zeros (and null ratios/percentiles) for days without plays. `starts` counts player sessions,
         *     which is not the anti-fraud `view_count`; `view_count` is the lifetime counter of the video.
         *     Any other caller (also for a missing or deleted video) gets `404`, never `403`.
         *     `Cache-Control: private, no-store`. Rate limit 60 requests/min per user, shared with `getChannelStats`.
         */
        get: operations["getVideoStats"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/studio/stats": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Daily player statistics summed over all of the caller's videos, plus the top 10 videos (task R1-b).
         * @description Same source, timezone, day filling and freshness rules as `getVideoStats`. Only videos that still exist and
         *     belong to the caller count. `viewers` is NOT summed (unique viewers are not additive), so channel days have
         *     no `viewers` field. `top_videos` ranks the caller's videos by `watch_time_ms` over the range (ties by
         *     `starts` then `video_id`), at most 10, omitting videos with no plays. `Cache-Control: private, no-store`.
         */
        get: operations["getChannelStats"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/videos/{video_id}/moderation": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
            };
            cookie?: never;
        };
        get?: never;
        /**
         * Hide or restore a video (moderator or admin). Emits `video.moderated`.
         * @description Authorization from `X-User-Roles` only. `HIDDEN` needs a `reason`; `VISIBLE` clears it. Setting
         *     the current state again is a no-op (`200`, no event). The row update and the `video.moderated`
         *     outbox row are written in one transaction (ADR-008). Media objects are not deleted.
         *     Gateway: this path goes to video-svc like the rest of `/v1/videos/*`.
         */
        put: operations["moderateVideo"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/videos/{video_id}/subtitles/{lang}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
                /** @description BCP 47 language tag, lowercase language + optional uppercase region (`vi`, `en`, `en-US`). */
                lang: string;
            };
            cookie?: never;
        };
        get?: never;
        /**
         * Create or replace the subtitle track of one language (owner only).
         * @description Only the owner (moderators and admins included: `403` unless they own the video). Any status except
         *     `FAILED` (`409`); a track can be prepared while the video is processing.
         *
         *     `content` is validated server-side, otherwise `400` with `code`:
         *     - `SUBTITLE_TOO_LARGE`: more than 524288 bytes of UTF-8;
         *     - `INVALID_WEBVTT`: not valid UTF-8, contains NUL, the first line (after an optional BOM) is not
         *       `WEBVTT` optionally followed by a space or tab and text, no cue, a cue timing that is not
         *       `[HH:]MM:SS.mmm --> [HH:]MM:SS.mmm` or whose end is not after its start. `detail` names the line.
         *     The stored file is normalised (BOM removed, CRLF/CR → LF) and served as `text/vtt; charset=utf-8`
         *     with the same immutable Cache-Control as other media. Every upload gets a NEW object key
         *     (`v/{video_id}/subtitles/{lang}-{uuidv7}.vtt`); the previous object is removed after the commit,
         *     best effort. At most 20 tracks per video: a new language beyond that → `409` `TOO_MANY_SUBTITLES`.
         *     No event is emitted.
         */
        put: operations["putSubtitle"];
        post?: never;
        /** Remove the subtitle track of one language (owner only). The object is removed best effort. */
        delete: operations["deleteSubtitle"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/internal/media-access/{video_id}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * May the public fetch this video's media? Used by nginx `auth_request` (task SEC1).
         * @description `204` when the video is `READY`, `PUBLIC` or `UNLISTED`, `moderation_state = VISIBLE` and its owner is
         *     in `auth.public_profiles`; `403` otherwise, including unknown ids (never `404`, so the answer does not
         *     reveal whether a video exists). One primary-key lookup; no body; no auth headers are read.
         *     Both answers carry `Cache-Control: max-age=30`; nginx caches them per `video_id`.
         *     Traefik routes it only for the internal Host `media-auth.internal`; it is not reachable from the internet.
         */
        get: operations["mediaAccess"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/feed/subscriptions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Newest videos of the channels the caller follows (task R2-b, ADR-021).
         * @description Public-feed videos only (PUBLIC, READY, VISIBLE, owner active), newest first by `published_at`, of the
         *     channels in the caller's subscriptions. video-svc answers from its own projection of
         *     `social.subscription.changed`, so a new subscription shows up within seconds (eventual consistency).
         *     No subscriptions → empty page. `Cache-Control: private, no-store`.
         *     Gateway: `/v1/feed` goes to video-svc.
         */
        get: operations["getSubscriptionFeed"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/feed/recommended": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Home feed "Dành cho bạn", personalised for signed-in callers (task R2, ADR-028). Optional auth.
         * @description Public-feed videos only (PUBLIC, READY, VISIBLE, owner active), never the caller's own videos and never a
         *     video the caller has already watched (per the recommendation history). The ranking blends co-view neighbours
         *     of the caller's recent watches, fresh videos of the channels they follow and trending; the exact formula is
         *     ADR-028 and is NOT part of this contract. Channel diversity is best effort: the list avoids more than 2
         *     videos of one channel in any 10 consecutive items whenever another eligible video can take the slot, but it
         *     never drops an eligible video to enforce that (a catalogue dominated by one channel still returns all of
         *     it). The rule is applied once over the whole ranked list, so it holds across page boundaries.
         *     When personal signals are missing (anonymous caller, new account, gpu-01 has not computed anything yet) the
         *     feed degrades to trending, then newest, so it is empty only when no public video exists.
         *     Pagination: the first page fixes a ranked list of at most 200 videos for about 10 minutes; `cursor` walks
         *     that list. A cursor whose list has expired is still accepted and continues at the same position of a
         *     freshly computed list (a rare duplicate or gap is possible). After the 200th video `next_cursor` is null.
         *     Signed in: `Cache-Control: private, no-store`. Anonymous: `Cache-Control: public, max-age=60`.
         *     Gateway: `/v1/feed` goes to video-svc.
         */
        get: operations["getRecommendedFeed"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Search public videos by relevance. Optional auth (the result does not depend on it).
         * @description Matching: the query is folded (lower-case, diacritics removed) and matched against
         *     `media.videos.search_vector` (`plainto_tsquery('simple', …)`; title weight A, description B).
         *     When that finds nothing, fall back to trigram similarity on the folded title (`%`, threshold
         *     0.3). Ranking: `ts_rank_cd` (or `similarity` for the fallback), then `published_at` DESC, then
         *     `id` DESC. The `cursor` encodes the position in that order; at most 10 pages are served, after
         *     which `next_cursor` is null. Rate limit per client IP: 60 requests per minute (`429`).
         *     Responses may be cached publicly for 30 s (`Cache-Control: public, max-age=30`).
         */
        get: operations["searchVideos"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/search/suggest": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Up to 8 title suggestions for a search box. Optional auth.
         * @description Titles of public videos whose folded title starts with the folded query or is similar to it
         *     (trigram), best match first, duplicates removed. Rate limit per client IP: 120 requests per
         *     minute. `Cache-Control: public, max-age=60`.
         */
        get: operations["suggestSearch"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        Rendition: {
            /** @example 1080p */
            name: string;
            width: number;
            height: number;
            bitrate_kbps: number;
        };
        Playback: {
            /**
             * Format: uri
             * @description Signed (`/s/{expires}/{sig}/…`) when the video is not publicly watchable (task SEC1).
             */
            hls_url: string;
            /** Format: uri */
            thumbnail_url: string;
            /**
             * Format: uri
             * @description WebVTT seek-preview track (task V5a): cues point at sprite sheets with `#xywh=x,y,w,h`, relative to
             *     this URL. Null when the video has no storyboard. Signed like `hls_url` when the video is not
             *     publicly watchable (task SEC1).
             */
            storyboard_url?: string | null;
            /**
             * Format: date-time
             * @description Present only for signed URLs; when they stop working (task SEC1).
             */
            expires_at?: string;
            /**
             * @description Subtitle tracks (task V5b), sorted by `lang`. video-svc always sends it (empty when there is none);
             *     optional only so that older servers stay valid.
             */
            subtitles?: components["schemas"]["SubtitleTrack"][];
            renditions: components["schemas"]["Rendition"][];
        };
        Video: {
            id: components["schemas"]["Uuid"];
            title: string;
            description: string;
            owner: components["schemas"]["PublicProfile"];
            visibility: components["schemas"]["Visibility"];
            status: components["schemas"]["VideoStatus"];
            duration_ms: number | null;
            width: number | null;
            height: number | null;
            /** Format: int64 */
            view_count: number;
            /** Format: int64 */
            like_count: number;
            /** Format: date-time */
            published_at: string | null;
            /** Format: date-time */
            created_at: string;
            /** @description Null until the video is `READY`. */
            playback: components["schemas"]["Playback"] | null;
            moderation?: components["schemas"]["VideoModeration"];
        };
        VideoSummary: {
            id: components["schemas"]["Uuid"];
            title: string;
            owner: components["schemas"]["PublicProfile"];
            duration_ms: number;
            /** Format: int64 */
            view_count: number;
            /** Format: date-time */
            published_at: string;
            /** Format: uri */
            thumbnail_url: string;
        };
        StatsTotals: {
            /** @description Player sessions started in the range. */
            starts: number;
            watch_time_ms: number;
            /** @description watch_time_ms / starts, rounded down; null when starts is 0. */
            avg_watch_ms: number | null;
            /** @description rebuffer_ms / (watched_ms + rebuffer_ms); null when both are 0. */
            rebuffer_ratio: number | null;
            /** @description Sessions that ended with a player error. */
            errors: number;
        };
        VideoStatsDay: {
            /** Format: date */
            day: string;
            starts: number;
            watch_time_ms: number;
            /** @description Approximate unique viewers of that day. */
            viewers: number;
            rebuffer_ratio: number | null;
            startup_p50_ms: number | null;
            startup_p95_ms: number | null;
        };
        VideoStats: {
            video_id: components["schemas"]["Uuid"];
            /** Format: date */
            from: string;
            /** Format: date */
            to: string;
            /** @constant */
            timezone: "Asia/Ho_Chi_Minh";
            /** @description Lifetime counted views of the video (same as `Video.view_count`). */
            view_count: number;
            totals: components["schemas"]["StatsTotals"];
            days: components["schemas"]["VideoStatsDay"][];
            /**
             * Format: date-time
             * @description Latest refresh of any returned day; null when the range has no data at all.
             */
            refreshed_at: string | null;
        };
        ChannelStatsDay: {
            /** Format: date */
            day: string;
            starts: number;
            watch_time_ms: number;
            rebuffer_ratio: number | null;
        };
        ChannelStatsTopVideo: {
            video_id: components["schemas"]["Uuid"];
            title: string;
            starts: number;
            watch_time_ms: number;
        };
        ChannelStats: {
            /** Format: date */
            from: string;
            /** Format: date */
            to: string;
            /** @constant */
            timezone: "Asia/Ho_Chi_Minh";
            totals: components["schemas"]["StatsTotals"];
            days: components["schemas"]["ChannelStatsDay"][];
            top_videos: components["schemas"]["ChannelStatsTopVideo"][];
            /** Format: date-time */
            refreshed_at: string | null;
        };
        RelatedVideos: {
            items: components["schemas"]["VideoSummary"][];
        };
        VideoBatch: {
            items: components["schemas"]["VideoSummary"][];
        };
        VideoPage: {
            items: components["schemas"]["VideoSummary"][];
            next_cursor: string | null;
        };
        StudioVideo: {
            id: components["schemas"]["Uuid"];
            title: string;
            visibility: components["schemas"]["Visibility"];
            status: components["schemas"]["VideoStatus"];
            progress: number;
            error: string | null;
            duration_ms: number | null;
            /** Format: date-time */
            created_at: string;
            /** Format: uri */
            thumbnail_url: string | null;
            moderation?: components["schemas"]["VideoModeration"];
        };
        StudioVideoPage: {
            items: components["schemas"]["StudioVideo"][];
            next_cursor: string | null;
        };
        UpdateVideoRequest: {
            title?: string;
            description?: string;
            visibility?: components["schemas"]["Visibility"];
        };
        RecordViewRequest: {
            /** @description Generated by the player once per playback (UUIDv4 or v7); makes retries idempotent. */
            playback_id: components["schemas"]["Uuid"];
            /** @description Played time so far in milliseconds, seeking excluded. */
            watched_ms: number;
        };
        RecordViewResult: {
            /** @description `true` when this report added one view. */
            counted: boolean;
        };
        PlaybackHeartbeatBatch: {
            samples: components["schemas"]["PlaybackSample"][];
        };
        /** @description One sample of one playback (task R1). Counters are deltas since the previous sample of the same playback. */
        PlaybackSample: {
            /** @description Same id as `RecordViewRequest.playback_id`. */
            playback_id: components["schemas"]["Uuid"];
            video_id: components["schemas"]["Uuid"];
            /** @enum {string} */
            kind: "start" | "heartbeat" | "end";
            /** @description 0 for `start`, +1 for every later sample of the playback; (playback_id, seq) is unique. */
            seq: number;
            /**
             * Format: date-time
             * @description Client clock; the server stores its own receive time too and trusts that one for bucketing.
             */
            sent_at: string;
            position_ms: number;
            /** @description Played time since the previous sample, seeking and stalls excluded. */
            watched_ms: number;
            /** @description Stall time since the previous sample (buffer empty while playing; the initial load is not a stall). */
            rebuffer_ms: number;
            rebuffer_count: number;
            /** @description Only on `start`, time from play request to first frame. */
            startup_ms?: number;
            /** @description Current rendition label, e.g. `720p`; null when unknown. */
            rendition?: string | null;
            bitrate_kbps?: number | null;
            /** @description Only on `end` when the playback stopped because of an error (e.g. hls.js `fatal` details). */
            error_code?: string | null;
            /**
             * @default web
             * @enum {string}
             */
            client: "web" | "ios" | "android" | "other";
        };
        PlaybackHeartbeatResult: {
            /** @description Number of samples accepted from the batch. */
            accepted: number;
        };
        /** @description Present only for the owner, moderators and admins (task A2). */
        VideoModeration: {
            /** @enum {string} */
            state: "VISIBLE" | "HIDDEN";
            /** @description Shown to the owner so they know why the video is hidden. */
            reason: string | null;
            /** Format: date-time */
            moderated_at: string | null;
        };
        SubtitleTrack: {
            lang: string;
            /** @description Shown in the player menu, e.g. `Tiếng Việt`. */
            label: string;
            /**
             * @description `AUTO` is reserved for auto-captions (V5c); only `UPLOAD` exists today.
             * @enum {string}
             */
            source: "UPLOAD" | "AUTO";
            /**
             * Format: uri
             * @description The `.vtt` file. Signed like `Playback.hls_url` when the video is not publicly watchable (SEC1).
             */
            url: string;
            /** Format: date-time */
            updated_at: string;
        };
        PutSubtitleRequest: {
            label: string;
            /** @description The whole WebVTT file. The byte limit (524288 bytes of UTF-8) is checked server-side. */
            content: string;
        };
        ModerateVideoRequest: {
            /** @enum {string} */
            state: "VISIBLE" | "HIDDEN";
            /** @description Required when `state` is `HIDDEN` (missing → `400`); ignored for `VISIBLE`. */
            reason?: string;
        };
        SearchSuggestions: {
            items: string[];
        };
        /**
         * Format: uuid
         * @description UUIDv7 generated by the owning service.
         * @example 0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c0d
         */
        Uuid: string;
        PublicProfile: {
            id: components["schemas"]["Uuid"];
            handle: string;
            display_name: string;
            /** Format: uri */
            avatar_url: string | null;
        };
        /** @description RFC 9457 problem details. Content type `application/problem+json`. */
        Problem: {
            /**
             * Format: uri-reference
             * @description Stable identifier of the error kind, e.g. `/problems/validation`.
             */
            type: string;
            title: string;
            status: number;
            detail?: string;
            instance?: string;
            /** @description Machine-readable error code, SCREAMING_SNAKE_CASE (e.g. `UPLOAD_TOO_LARGE`). */
            code?: string;
            /** @description Field-level validation errors. */
            errors?: {
                field: string;
                message: string;
            }[];
        };
        /**
         * @description Until task SEC1 (signed cookies) ships, PRIVATE/UNLISTED only affect listings and API reads;
         *     media URLs are unguessable but not access-controlled.
         * @enum {string}
         */
        Visibility: "PUBLIC" | "UNLISTED" | "PRIVATE";
        /** @enum {string} */
        VideoStatus: "UPLOADING" | "UPLOADED" | "PROCESSING" | "READY" | "FAILED";
    };
    responses: {
        /** @description Validation failed. */
        BadRequest: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Resource does not exist or is not visible to the caller. */
        NotFound: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Missing or invalid credentials. */
        Unauthorized: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Authenticated but not allowed. */
        Forbidden: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Rate limit exceeded. See `Retry-After`. */
        TooManyRequests: {
            headers: {
                "Retry-After"?: number;
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Resource is in a state that does not allow this operation. */
        Conflict: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
    };
    parameters: {
        /**
         * @description First day (inclusive, `Asia/Ho_Chi_Minh`). Default `to` minus 27 days. Must not be after `to`, at most 89
         *     days before `to` (a range holds 1 to 90 days) and not more than 730 days before today, else `400`.
         */
        StatsFrom: string;
        /** @description Last day (inclusive, `Asia/Ho_Chi_Minh`). Default today; a later day is clamped to today. */
        StatsTo: string;
        /** @description Opaque cursor copied from `next_cursor` of the previous page. */
        Cursor: string;
        Limit: number;
        VideoId: components["schemas"]["Uuid"];
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    listVideos: {
        parameters: {
            query?: {
                /** @description Opaque cursor copied from `next_cursor` of the previous page. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
                /** @description Restrict to one creator (channel page). */
                owner_id?: components["schemas"]["Uuid"];
                /** @description `newest` (default) or `trending` (task R2-a). */
                sort?: "newest" | "trending";
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of videos. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VideoPage"];
                };
            };
            400: components["responses"]["BadRequest"];
        };
    };
    batchGetVideos: {
        parameters: {
            query: {
                /** @description Comma-separated video ids, 1 to 50, no duplicates. */
                ids: components["schemas"]["Uuid"][];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The readable videos, in the order of `ids`. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VideoBatch"];
                };
            };
            400: components["responses"]["BadRequest"];
        };
    };
    getVideo: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Video with playback info. */
            200: {
                headers: {
                    /** @description `public, max-age=30` for public READY videos, otherwise `private, no-store`. */
                    "Cache-Control"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Video"];
                };
            };
            404: components["responses"]["NotFound"];
        };
    };
    deleteVideo: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Deleted. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    updateVideo: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateVideoRequest"];
            };
        };
        responses: {
            /** @description Updated video. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Video"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    listRelatedVideos: {
        parameters: {
            query?: {
                /** @description 1 to 24, default 12. */
                limit?: number;
            };
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The related videos, best first. May be shorter than `limit` (even empty). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RelatedVideos"];
                };
            };
            400: components["responses"]["BadRequest"];
            404: components["responses"]["NotFound"];
        };
    };
    recordView: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RecordViewRequest"];
            };
        };
        responses: {
            /** @description Report accepted. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RecordViewResult"];
                };
            };
            400: components["responses"]["BadRequest"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    recordPlaybackHeartbeats: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PlaybackHeartbeatBatch"];
            };
        };
        responses: {
            /** @description Batch accepted (possibly partially; rejected samples are not reported back). */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlaybackHeartbeatResult"];
                };
            };
            400: components["responses"]["BadRequest"];
            /** @description Body larger than 16 KiB. */
            413: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
            429: components["responses"]["TooManyRequests"];
        };
    };
    listStudioVideos: {
        parameters: {
            query?: {
                /** @description Opaque cursor copied from `next_cursor` of the previous page. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
                status?: components["schemas"]["VideoStatus"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of the caller's videos. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StudioVideoPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
        };
    };
    getVideoStats: {
        parameters: {
            query?: {
                /**
                 * @description First day (inclusive, `Asia/Ho_Chi_Minh`). Default `to` minus 27 days. Must not be after `to`, at most 89
                 *     days before `to` (a range holds 1 to 90 days) and not more than 730 days before today, else `400`.
                 */
                from?: components["parameters"]["StatsFrom"];
                /** @description Last day (inclusive, `Asia/Ho_Chi_Minh`). Default today; a later day is clamped to today. */
                to?: components["parameters"]["StatsTo"];
            };
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The statistics of the range. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VideoStats"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    getChannelStats: {
        parameters: {
            query?: {
                /**
                 * @description First day (inclusive, `Asia/Ho_Chi_Minh`). Default `to` minus 27 days. Must not be after `to`, at most 89
                 *     days before `to` (a range holds 1 to 90 days) and not more than 730 days before today, else `400`.
                 */
                from?: components["parameters"]["StatsFrom"];
                /** @description Last day (inclusive, `Asia/Ho_Chi_Minh`). Default today; a later day is clamped to today. */
                to?: components["parameters"]["StatsTo"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The channel statistics of the range. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ChannelStats"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    moderateVideo: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ModerateVideoRequest"];
            };
        };
        responses: {
            /** @description Video after the change, with `moderation`. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Video"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    putSubtitle: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
                /** @description BCP 47 language tag, lowercase language + optional uppercase region (`vi`, `en`, `en-US`). */
                lang: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PutSubtitleRequest"];
            };
        };
        responses: {
            /** @description Track replaced. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SubtitleTrack"];
                };
            };
            /** @description Track created. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SubtitleTrack"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    deleteSubtitle: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
                /** @description BCP 47 language tag, lowercase language + optional uppercase region (`vi`, `en`, `en-US`). */
                lang: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Removed. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            /** @description Unknown video, video the caller may not see, or no track for this language. */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    mediaAccess: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                video_id: components["schemas"]["Uuid"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Public media; nginx serves the request. */
            204: {
                headers: {
                    "Cache-Control"?: string;
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
            /** @description Not public (or unknown); nginx answers `403`. */
            403: {
                headers: {
                    "Cache-Control"?: string;
                    [name: string]: unknown;
                };
                content?: never;
            };
        };
    };
    getSubscriptionFeed: {
        parameters: {
            query?: {
                /** @description Opaque cursor copied from `next_cursor` of the previous page. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of videos. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VideoPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
        };
    };
    getRecommendedFeed: {
        parameters: {
            query?: {
                /** @description Opaque cursor copied from `next_cursor` of the previous page. */
                cursor?: components["parameters"]["Cursor"];
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of recommended videos. */
            200: {
                headers: {
                    "Cache-Control"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VideoPage"];
                };
            };
            400: components["responses"]["BadRequest"];
        };
    };
    searchVideos: {
        parameters: {
            query: {
                /** @description Free text. Leading/trailing spaces are trimmed; empty after trimming → `400`. */
                q: string;
                /** @description Opaque cursor copied from `next_cursor` of the previous page. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of results (possibly empty). */
            200: {
                headers: {
                    "Cache-Control"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["VideoPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    suggestSearch: {
        parameters: {
            query: {
                q: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Suggestions. */
            200: {
                headers: {
                    "Cache-Control"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SearchSuggestions"];
                };
            };
            400: components["responses"]["BadRequest"];
            429: components["responses"]["TooManyRequests"];
        };
    };
}

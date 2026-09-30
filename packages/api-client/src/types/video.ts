export interface paths {
    "/v1/videos": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Public feed, newest first. Optional auth. */
        get: operations["listVideos"];
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
        /** Edit metadata (owner only). */
        patch: operations["updateVideo"];
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
             * Format: date-time
             * @description Present only for signed URLs; when they stop working (task SEC1).
             */
            expires_at?: string;
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
        /** @description Present only for the owner, moderators and admins (task A2). */
        VideoModeration: {
            /** @enum {string} */
            state: "VISIBLE" | "HIDDEN";
            /** @description Shown to the owner so they know why the video is hidden. */
            reason: string | null;
            /** Format: date-time */
            moderated_at: string | null;
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
    };
    parameters: {
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

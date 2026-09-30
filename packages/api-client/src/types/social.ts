export interface paths {
    "/v1/videos/{video_id}/comments": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
            };
            cookie?: never;
        };
        /** Top-level comments, newest first. Optional auth. */
        get: operations["listComments"];
        put?: never;
        /**
         * Post a comment or a reply. Emits `social.comment.created`.
         * @description `parent_id` must be a top-level, non-deleted comment on the same video (only two levels).
         *     Rate limit per user: 10 comments per minute (`429` with `Retry-After`).
         */
        post: operations["createComment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/comments/{comment_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                comment_id: components["parameters"]["CommentId"];
            };
            cookie?: never;
        };
        /** One comment (deep link). Optional auth. */
        get: operations["getComment"];
        put?: never;
        post?: never;
        /**
         * Delete (author, video owner, moderator or admin). Idempotent.
         * @description Sets `status = DELETED` and wipes the body. Deleting an already deleted comment returns `204`.
         */
        delete: operations["deleteComment"];
        options?: never;
        head?: never;
        /** Edit the body (author only). Sets `edited_at`. */
        patch: operations["editComment"];
        trace?: never;
    };
    "/v1/comments/{comment_id}/replies": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                comment_id: components["parameters"]["CommentId"];
            };
            cookie?: never;
        };
        /** Replies to a top-level comment, oldest first. Optional auth. */
        get: operations["listReplies"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/comments/{comment_id}/moderation": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                comment_id: components["parameters"]["CommentId"];
            };
            cookie?: never;
        };
        get?: never;
        /** Hide or restore a comment (moderator or admin). */
        put: operations["moderateComment"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/videos/{video_id}/like": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
            };
            cookie?: never;
        };
        /** Like count and whether the caller liked the video. Optional auth. */
        get: operations["getLike"];
        /** Like (idempotent). Emits `social.video.like_changed` when the state changes. */
        put: operations["likeVideo"];
        post?: never;
        /** Remove the like (idempotent). Emits `social.video.like_changed` when the state changes. */
        delete: operations["unlikeVideo"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/channels/{channel_id}/subscription": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description User id of the channel owner. */
                channel_id: components["parameters"]["ChannelId"];
            };
            cookie?: never;
        };
        /**
         * Subscriber count and whether the caller is subscribed. Optional auth.
         * @description Unknown channels return `subscriber_count` 0; social-svc does not validate that the user exists.
         */
        get: operations["getSubscription"];
        /**
         * Subscribe (idempotent). Emits `social.subscription.changed` when the state changes.
         * @description The channel must be an active profile in `auth.public_profiles`; subscribing to yourself is `400`.
         */
        put: operations["subscribe"];
        post?: never;
        /** Unsubscribe (idempotent). Emits `social.subscription.changed` when the state changes. */
        delete: operations["unsubscribe"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/subscriptions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Channels the caller subscribes to, most recent first. */
        get: operations["listMySubscriptions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/notifications": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The caller's notifications, newest first (task N1).
         * @description Ordered by (`created_at`, `id`) descending; the cursor encodes that position. Filtering rules in the tag
         *     description. `Cache-Control: private, no-store`.
         */
        get: operations["listNotifications"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/notifications/unread-count": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Number of unread notifications (capped at 100), for the badge (task N1).
         * @description Cheap enough to poll every 60 s (partial index on unread rows). Counts with the same filtering rules as
         *     `listNotifications`. `Cache-Control: private, no-store`.
         */
        get: operations["getUnreadNotificationCount"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/notifications/read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Mark notifications as read (task N1).
         * @description Either `ids` (at most 100 of the caller's notifications; unknown or foreign ids are ignored) or
         *     `up_to` (every notification of the caller created at or before that time). Exactly one of the two.
         *     Idempotent: already-read notifications keep their original `read_at`.
         */
        post: operations["markNotificationsRead"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/playlists": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create a playlist owned by the caller (task PL1).
         * @description At most 200 playlists per user (the watch-later list included) → `409` `PLAYLIST_LIMIT`. Rate limit
         *     30/min per user → `429`.
         */
        post: operations["createPlaylist"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/playlists/{playlist_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                playlist_id: components["parameters"]["PlaylistId"];
            };
            cookie?: never;
        };
        /**
         * One playlist. Optional auth.
         * @description `PRIVATE` playlists (and the watch-later list, always private) → `404` for everyone but the owner.
         *     `PUBLIC` and `UNLISTED` → anyone with the id. `Cache-Control: private, no-store`.
         */
        get: operations["getPlaylist"];
        put?: never;
        post?: never;
        /** Delete an own playlist and its items. The watch-later list cannot be deleted (`409`). */
        delete: operations["deletePlaylist"];
        options?: never;
        head?: never;
        /**
         * Rename, re-describe or change the visibility of an own playlist.
         * @description Owner only (others → `404`). The watch-later list cannot be changed → `409` `WATCH_LATER_IMMUTABLE`.
         */
        patch: operations["updatePlaylist"];
        trace?: never;
    };
    "/v1/playlists/{playlist_id}/items": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                playlist_id: components["parameters"]["PlaylistId"];
            };
            cookie?: never;
        };
        /**
         * Items in playlist order. Optional auth; same visibility rule as getPlaylist.
         * @description Ordered by `position` ascending. Items whose video is hidden, deleted, or `PRIVATE` (unless the caller
         *     owns that video) are not returned; `item_count` on the playlist counts all rows, so a page can hold fewer
         *     visible items than stored ones. Titles and thumbnails come from video-svc `batchGetVideos` (one call per
         *     page), never from social-svc.
         */
        get: operations["listPlaylistItems"];
        put?: never;
        /**
         * Append a video to an own playlist. Idempotent.
         * @description The video must be one the caller can currently read (known to social-svc, not hidden, not `PRIVATE` unless
         *     the caller owns it) → otherwise `404` `VIDEO_NOT_FOUND`. Already in the playlist → `200` with the existing
         *     item (position unchanged); new → `201`. At most 5 000 items per playlist → `409` `PLAYLIST_FULL`.
         *     Rate limit 120/min per user → `429`.
         */
        post: operations["addPlaylistItem"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/playlists/{playlist_id}/items/{video_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                playlist_id: components["parameters"]["PlaylistId"];
                video_id: components["parameters"]["VideoId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Remove a video from an own playlist. Idempotent (`204` also when it was not there). */
        delete: operations["removePlaylistItem"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/playlists/{playlist_id}/items/{video_id}/move": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                playlist_id: components["parameters"]["PlaylistId"];
                video_id: components["parameters"]["VideoId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Move an item before another one, or to the end (`before_video_id` null).
         * @description Owner only. Item or `before_video_id` not in the playlist → `404`. Moving before itself is a no-op.
         */
        post: operations["movePlaylistItem"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/channels/{channel_id}/playlists": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description User id of the channel owner. */
                channel_id: components["parameters"]["ChannelId"];
            };
            cookie?: never;
        };
        /**
         * Playlists of a channel, most recently updated first. Optional auth.
         * @description Others see only `PUBLIC` playlists (never `UNLISTED`, `PRIVATE` or watch-later). The owner sees all of
         *     theirs, the watch-later list first.
         */
        get: operations["listChannelPlaylists"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/videos/{video_id}/playlist-membership": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
            };
            cookie?: never;
        };
        /**
         * Which of the caller's playlists contain this video (for the "Save" dialog).
         * @description Ids of the caller's own playlists (watch-later included) that contain `video_id`; empty when none or when
         *     the video is unknown. `Cache-Control: private, no-store`.
         */
        get: operations["getPlaylistMembership"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/watch-later": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The caller's watch-later playlist, created on first use.
         * @description Returns the `WATCH_LATER` playlist (always `PRIVATE`, one per user), creating it if needed. Add and remove
         *     videos with the normal item endpoints using its `id`.
         */
        get: operations["getWatchLater"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/reports": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Report a video, a comment or a user (any signed-in user).
         * @description The target must exist and be visible to the reporter (otherwise `404`); reporting yourself or
         *     your own content → `400`. A second report by the same user on the same target while the first
         *     is still `OPEN` returns the existing report with `200`. Rate limit per user: 20 reports per hour
         *     (`429`). The reporter never learns the outcome through this API.
         */
        post: operations["createReport"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/moderation/reports": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Moderation queue (moderator or admin).
         * @description Reports grouped by target: one item per (target_type, target_id) with its open report count and
         *     the most recent reports. `status=OPEN` (default) sorts by the oldest open report first, so the
         *     longest-waiting target is on top; other statuses sort by `resolved_at` descending.
         */
        get: operations["listReports"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/moderation/cases/{target_type}/{target_id}/resolution": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                target_type: components["schemas"]["ReportTargetType"];
                target_id: components["schemas"]["Uuid"];
            };
            cookie?: never;
        };
        get?: never;
        /**
         * Close every OPEN report on one target (moderator or admin).
         * @description Sets `status`, `resolved_by`, `resolution_note` and `resolved_at` on all OPEN reports of the
         *     target in one statement and returns how many changed. No OPEN report → `404`.
         */
        put: operations["resolveModerationCase"];
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
        /** @enum {string} */
        CommentStatus: "VISIBLE" | "DELETED" | "HIDDEN";
        Comment: {
            id: components["schemas"]["Uuid"];
            video_id: components["schemas"]["Uuid"];
            /** @description `null` for a top-level comment. */
            parent_id: components["schemas"]["Uuid"] | null;
            /** @description `null` when the author no longer has an active profile. */
            author: components["schemas"]["PublicProfile"] | null;
            /** @description Empty for `DELETED` tombstones. */
            body: string;
            status: components["schemas"]["CommentStatus"];
            /** @description Visible replies; always 0 for a reply. */
            reply_count: number;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            edited_at: string | null;
            /** @description The caller is the author and the comment is VISIBLE. */
            can_edit: boolean;
            /** @description The caller is the author, the video owner, a moderator or an admin. */
            can_delete: boolean;
        };
        CommentPage: {
            items: components["schemas"]["Comment"][];
            next_cursor: string | null;
        };
        CreateCommentRequest: {
            /** @description Plain text. Leading/trailing whitespace is trimmed; the trimmed body must not be empty. */
            body: string;
            parent_id?: components["schemas"]["Uuid"];
        };
        EditCommentRequest: {
            body: string;
        };
        ModerateCommentRequest: {
            /**
             * @description `409` if the comment is `DELETED`.
             * @enum {string}
             */
            status: "HIDDEN" | "VISIBLE";
        };
        LikeState: {
            video_id: components["schemas"]["Uuid"];
            liked: boolean;
            like_count: number;
        };
        SubscriptionState: {
            channel_id: components["schemas"]["Uuid"];
            subscribed: boolean;
            subscriber_count: number;
        };
        Subscription: {
            channel: components["schemas"]["PublicProfile"];
            /** Format: date-time */
            subscribed_at: string;
        };
        SubscriptionPage: {
            items: components["schemas"]["Subscription"][];
            next_cursor: string | null;
        };
        /**
         * @description `VIDEO_PUBLISHED` — a channel you subscribe to published a video (actor = channel, `video_id` set); sent
         *     once, when the video first becomes `PUBLIC` (`UNLISTED` never notifies).
         *     `VIDEO_COMMENT` — someone left a top-level comment on your video (`video_id`, `comment_id`).
         *     `COMMENT_REPLY` — someone replied to your comment (`video_id`, `comment_id` = the reply).
         *     `NEW_SUBSCRIBER` — someone subscribed to your channel (only the first time per subscriber).
         * @enum {string}
         */
        NotificationKind: "VIDEO_PUBLISHED" | "VIDEO_COMMENT" | "COMMENT_REPLY" | "NEW_SUBSCRIBER";
        Notification: {
            id: components["schemas"]["Uuid"];
            kind: components["schemas"]["NotificationKind"];
            actor: components["schemas"]["PublicProfile"];
            /** Format: uuid */
            video_id: string | null;
            /** Format: uuid */
            comment_id: string | null;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            read_at: string | null;
        };
        NotificationPage: {
            items: components["schemas"]["Notification"][];
            next_cursor: string | null;
        };
        UnreadCount: {
            count: number;
            /** @description `true` when there are more than 100 unread notifications (show "99+"). */
            capped: boolean;
        };
        MarkNotificationsReadRequest: {
            ids?: components["schemas"]["Uuid"][];
            /** Format: date-time */
            up_to?: string;
        };
        /** @enum {string} */
        PlaylistKind: "REGULAR" | "WATCH_LATER";
        Playlist: {
            id: components["schemas"]["Uuid"];
            owner: components["schemas"]["PublicProfile"];
            kind: components["schemas"]["PlaylistKind"];
            /** @description "Xem sau" for the watch-later list (the client localises by `kind`). */
            title: string;
            description: string;
            visibility: components["schemas"]["Visibility"];
            item_count: number;
            /** Format: date-time */
            created_at: string;
            /**
             * Format: date-time
             * @description Last change to the playlist or its items.
             */
            updated_at: string;
        };
        PlaylistPage: {
            items: components["schemas"]["Playlist"][];
            next_cursor: string | null;
        };
        CreatePlaylistRequest: {
            title: string;
            /** @default  */
            description: string;
            /** @description Defaults to `PRIVATE`. */
            visibility?: components["schemas"]["Visibility"];
        };
        UpdatePlaylistRequest: {
            title?: string;
            description?: string;
            visibility?: components["schemas"]["Visibility"];
        };
        PlaylistItem: {
            video_id: components["schemas"]["Uuid"];
            /** @description Opaque sort key (ascending). Not contiguous; do not show it to users. */
            position: number;
            /** Format: date-time */
            added_at: string;
        };
        PlaylistItemPage: {
            items: components["schemas"]["PlaylistItem"][];
            next_cursor: string | null;
        };
        AddPlaylistItemRequest: {
            video_id: components["schemas"]["Uuid"];
        };
        MovePlaylistItemRequest: {
            /**
             * Format: uuid
             * @description Place the item right before this one; `null` moves it to the end.
             */
            before_video_id: string | null;
        };
        PlaylistMembership: {
            playlist_ids: components["schemas"]["Uuid"][];
        };
        /** @enum {string} */
        ReportTargetType: "VIDEO" | "COMMENT" | "USER";
        /** @enum {string} */
        ReportReason: "SPAM" | "HARASSMENT" | "HATE" | "SEXUAL" | "VIOLENCE" | "COPYRIGHT" | "MISINFORMATION" | "OTHER";
        /** @enum {string} */
        ReportStatus: "OPEN" | "ACTIONED" | "DISMISSED";
        CreateReportRequest: {
            target_type: components["schemas"]["ReportTargetType"];
            target_id: components["schemas"]["Uuid"];
            reason: components["schemas"]["ReportReason"];
            /** @default  */
            note: string;
        };
        ReportReceipt: {
            id: components["schemas"]["Uuid"];
            /** Format: date-time */
            created_at: string;
        };
        Report: {
            id: components["schemas"]["Uuid"];
            reporter: components["schemas"]["PublicProfile"] | null;
            reason: components["schemas"]["ReportReason"];
            note: string;
            status: components["schemas"]["ReportStatus"];
            /** Format: date-time */
            created_at: string;
        };
        ModerationCase: {
            target_type: components["schemas"]["ReportTargetType"];
            target_id: components["schemas"]["Uuid"];
            status: components["schemas"]["ReportStatus"];
            open_count: number;
            /** Format: date-time */
            first_reported_at: string;
            /** @description Count of reports per reason, e.g. `{"SPAM": 3, "HATE": 1}`. */
            reasons: {
                [key: string]: number;
            };
            /** @description The five most recent reports of this case. */
            reports: components["schemas"]["Report"][];
            /** @description Null while OPEN. */
            resolution: null | {
                resolved_by: components["schemas"]["Uuid"];
                note: string | null;
                /** Format: date-time */
                resolved_at: string;
            };
        };
        ModerationCasePage: {
            items: components["schemas"]["ModerationCase"][];
            next_cursor: string | null;
        };
        ResolveCaseRequest: {
            /** @enum {string} */
            status: "ACTIONED" | "DISMISSED";
            note?: string;
        };
        ResolveCaseResult: {
            resolved_count: number;
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
        /** @description Resource is in a state that does not allow this operation. */
        Conflict: {
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
        /** @description Authenticated but not allowed. */
        Forbidden: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
    };
    parameters: {
        CommentId: components["schemas"]["Uuid"];
        /** @description User id of the channel owner. */
        ChannelId: components["schemas"]["Uuid"];
        PlaylistId: components["schemas"]["Uuid"];
        VideoId: components["schemas"]["Uuid"];
        /** @description Opaque cursor copied from `next_cursor` of the previous page. */
        Cursor: string;
        Limit: number;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    listComments: {
        parameters: {
            query?: {
                /** @description Opaque cursor copied from `next_cursor` of the previous page. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of top-level comments. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CommentPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            404: components["responses"]["NotFound"];
        };
    };
    createComment: {
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
                "application/json": components["schemas"]["CreateCommentRequest"];
            };
        };
        responses: {
            /** @description Created. */
            201: {
                headers: {
                    /** @description `/v1/comments/{comment_id}` */
                    Location?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Comment"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    getComment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                comment_id: components["parameters"]["CommentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The comment. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Comment"];
                };
            };
            404: components["responses"]["NotFound"];
        };
    };
    deleteComment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                comment_id: components["parameters"]["CommentId"];
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
    editComment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                comment_id: components["parameters"]["CommentId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EditCommentRequest"];
            };
        };
        responses: {
            /** @description Updated comment. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Comment"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    listReplies: {
        parameters: {
            query?: {
                /** @description Opaque cursor copied from `next_cursor` of the previous page. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path: {
                comment_id: components["parameters"]["CommentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of replies. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CommentPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            404: components["responses"]["NotFound"];
        };
    };
    moderateComment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                comment_id: components["parameters"]["CommentId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ModerateCommentRequest"];
            };
        };
        responses: {
            /** @description Comment after moderation. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Comment"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    getLike: {
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
            /** @description Like state. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LikeState"];
                };
            };
            404: components["responses"]["NotFound"];
        };
    };
    likeVideo: {
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
            /** @description Like state after the call. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LikeState"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    unlikeVideo: {
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
            /** @description Like state after the call. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["LikeState"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    getSubscription: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description User id of the channel owner. */
                channel_id: components["parameters"]["ChannelId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Subscription state. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SubscriptionState"];
                };
            };
            400: components["responses"]["BadRequest"];
        };
    };
    subscribe: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description User id of the channel owner. */
                channel_id: components["parameters"]["ChannelId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Subscription state after the call. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SubscriptionState"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    unsubscribe: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description User id of the channel owner. */
                channel_id: components["parameters"]["ChannelId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Subscription state after the call. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SubscriptionState"];
                };
            };
            401: components["responses"]["Unauthorized"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    listMySubscriptions: {
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
            /** @description One page of subscriptions. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SubscriptionPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
        };
    };
    listNotifications: {
        parameters: {
            query?: {
                /** @description Opaque cursor copied from `next_cursor` of the previous page. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
                /** @description `true` returns only unread notifications. */
                unread?: boolean;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of notifications. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["NotificationPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
        };
    };
    getUnreadNotificationCount: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Unread count. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UnreadCount"];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    markNotificationsRead: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MarkNotificationsReadRequest"];
            };
        };
        responses: {
            /** @description Marked. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
        };
    };
    createPlaylist: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreatePlaylistRequest"];
            };
        };
        responses: {
            /** @description Created. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Playlist"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    getPlaylist: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                playlist_id: components["parameters"]["PlaylistId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The playlist. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Playlist"];
                };
            };
            404: components["responses"]["NotFound"];
        };
    };
    deletePlaylist: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                playlist_id: components["parameters"]["PlaylistId"];
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
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    updatePlaylist: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                playlist_id: components["parameters"]["PlaylistId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdatePlaylistRequest"];
            };
        };
        responses: {
            /** @description Updated. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Playlist"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    listPlaylistItems: {
        parameters: {
            query?: {
                /** @description Opaque cursor copied from `next_cursor` of the previous page. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path: {
                playlist_id: components["parameters"]["PlaylistId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of items. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlaylistItemPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            404: components["responses"]["NotFound"];
        };
    };
    addPlaylistItem: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                playlist_id: components["parameters"]["PlaylistId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AddPlaylistItemRequest"];
            };
        };
        responses: {
            /** @description Already present. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlaylistItem"];
                };
            };
            /** @description Added at the end. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlaylistItem"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    removePlaylistItem: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                playlist_id: components["parameters"]["PlaylistId"];
                video_id: components["parameters"]["VideoId"];
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
            404: components["responses"]["NotFound"];
        };
    };
    movePlaylistItem: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                playlist_id: components["parameters"]["PlaylistId"];
                video_id: components["parameters"]["VideoId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MovePlaylistItemRequest"];
            };
        };
        responses: {
            /** @description The moved item with its new position. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlaylistItem"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    listChannelPlaylists: {
        parameters: {
            query?: {
                /** @description Opaque cursor copied from `next_cursor` of the previous page. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path: {
                /** @description User id of the channel owner. */
                channel_id: components["parameters"]["ChannelId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of playlists. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlaylistPage"];
                };
            };
            400: components["responses"]["BadRequest"];
        };
    };
    getPlaylistMembership: {
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
            /** @description Playlist ids. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PlaylistMembership"];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    getWatchLater: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The watch-later playlist. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Playlist"];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    createReport: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateReportRequest"];
            };
        };
        responses: {
            /** @description An open report by the same user on the same target already exists. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReportReceipt"];
                };
            };
            /** @description Report created. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReportReceipt"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    listReports: {
        parameters: {
            query?: {
                status?: components["schemas"]["ReportStatus"];
                target_type?: components["schemas"]["ReportTargetType"];
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
            /** @description One page of moderation cases. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ModerationCasePage"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
        };
    };
    resolveModerationCase: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                target_type: components["schemas"]["ReportTargetType"];
                target_id: components["schemas"]["Uuid"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ResolveCaseRequest"];
            };
        };
        responses: {
            /** @description Reports closed. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ResolveCaseResult"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
}

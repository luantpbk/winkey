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

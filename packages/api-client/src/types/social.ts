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
         *     SOC-1b: a block between the caller and the video owner, or (for a reply) the parent comment's author, in
         *     either direction → `403` code `INTERACTION_BLOCKED`.
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
         *
         *     SOC-1b: a block between the caller and the channel (either direction) → `404`. A **private** channel the
         *     caller does not follow yet: a follow request is created instead (idempotent), the channel gets a
         *     `FOLLOW_REQUEST` notification, the response has `subscribed = false, requested = true`, and no event is
         *     emitted. At most 200 pending outgoing requests per user (`409` code `LIMIT_REACHED`).
         */
        put: operations["subscribe"];
        post?: never;
        /**
         * Unsubscribe (idempotent). Emits `social.subscription.changed` when the state changes.
         * @description Also cancels the caller's pending follow request to this channel (SOC-1b).
         */
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
    "/v1/channels/{channel_id}/followers": {
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
         * Users who follow the channel, newest first (task SOC-1b). Optional auth.
         * @description A private channel: only the owner and its approved followers may read it; anyone else → `403` code
         *     `PRIVATE_ACCOUNT`. Users without an active profile and users in a block relation with the caller are left
         *     out. Unknown channel → empty page.
         */
        get: operations["listFollowers"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/channels/{channel_id}/following": {
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
         * Channels the user follows, newest first (task SOC-1b). Optional auth.
         * @description Same visibility and filtering rules as `listFollowers`.
         */
        get: operations["listFollowing"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/channels/{channel_id}/relationship": {
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
         * The caller's relationship to another user (task SOC-1b).
         * @description Never reveals whether the other user blocks the caller. Asking about yourself → `400`.
         */
        get: operations["getRelationship"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/follow-requests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Pending follow requests to the caller, newest first (task SOC-1b).
         * @description Requesters without an active profile or in a block relation are left out.
         */
        get: operations["listFollowRequests"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/follow-requests/{requester_id}/decision": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                requester_id: components["schemas"]["Uuid"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Approve or reject a follow request (task SOC-1b).
         * @description No pending request from that user → `404`. `APPROVE`: in one transaction the request becomes a
         *     subscription (`social.subscription.changed` through the outbox, `NEW_SUBSCRIBER` notification to the
         *     caller as for a normal subscription) and the requester gets `FOLLOW_REQUEST_APPROVED`. `REJECT`: the
         *     request is deleted; the requester is not notified and may ask again.
         */
        post: operations["decideFollowRequest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/blocks": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Users the caller blocks, newest first (task SOC-1b). */
        get: operations["listMyBlocks"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/blocks/{user_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description User id of the other user. */
                user_id: components["parameters"]["RelationUserId"];
            };
            cookie?: never;
        };
        get?: never;
        /**
         * Block a user (idempotent, task SOC-1b).
         * @description The target must be an active profile (`404` otherwise); yourself → `400`. Effects are in the tag
         *     description; everything happens in one transaction.
         */
        put: operations["blockUser"];
        post?: never;
        /** Unblock a user (idempotent, task SOC-1b). Removed subscriptions are not restored. */
        delete: operations["unblockUser"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/mutes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Users the caller mutes, newest first (task SOC-1b). */
        get: operations["listMyMutes"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/mutes/{user_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description User id of the other user. */
                user_id: components["parameters"]["RelationUserId"];
            };
            cookie?: never;
        };
        get?: never;
        /**
         * Mute a user (idempotent, task SOC-1b).
         * @description The target must be an active profile (`404` otherwise); yourself → `400`.
         */
        put: operations["muteUser"];
        post?: never;
        /** Unmute a user (idempotent, task SOC-1b). */
        delete: operations["unmuteUser"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/people/search": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Find people by handle or display name (task SOC-6a). Optional auth.
         * @description Searches active profiles (`auth.public_profiles`). `q` is trimmed and a leading `@` is removed; what is left
         *     must be 1–64 characters (`400` code `INVALID_QUERY` otherwise). Matching folds case and Vietnamese diacritics
         *     (`đ` → `d`), so `tuan` finds "Tuấn":
         *     - the handle starts with `q`, or
         *     - the folded display name starts with `q`, or (when `q` has at least 3 characters) contains it.
         *     `%`, `_` and `\` in `q` are literal characters.
         *
         *     **Excluded:** the caller, and users in a block relation with the caller (either direction). Private accounts
         *     are found (their profile header is public, as in `getUserByHandle`).
         *
         *     **Order:**
         *     1. signed in only: mutual follows first, then users the caller follows, then everyone else;
         *     2. exact handle match, then handle prefix, then display-name prefix, then display-name substring;
         *     3. handle, ascending.
         *
         *     Results stop after 100 matches: search is for picking a person, not for browsing. `next_cursor` is `null` on
         *     the last page. Rate limit: 60 requests per minute per user, or per IP when anonymous (`429`).
         */
        get: operations["searchPeople"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/friends": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The caller's friends (mutual follows), newest friendship first (task SOC-6b).
         * @description `friends_since` is when the pair became mutual, i.e. the later of the two follows. Users without an active
         *     profile and users in a block relation with the caller are left out (a block removes both follows anyway).
         */
        get: operations["listMyFriends"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/friend-requests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * People who follow the caller but whom the caller does not follow, newest follow first (task SOC-6b).
         * @description Leaves out dismissed requests (`dismissFriendRequest`), users without an active profile and users in a block
         *     relation with the caller. Accepting is `subscribe` to the requester, which also clears a dismissal. A private
         *     account's pending follow requests are a different list (`listFollowRequests`): those users do not follow the
         *     caller yet. `pending_count` counts the whole list, not the page.
         */
        get: operations["listFriendRequests"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/me/friend-requests/{user_id}/dismiss": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description User id of the other user. */
                user_id: components["parameters"]["RelationUserId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Hide a friend request without unfollowing or telling anyone (task SOC-6b). Idempotent.
         * @description `user_id` must follow the caller and not be followed back by the caller, else `404`. The dismissal stays until
         *     the caller follows them back (`subscribe` deletes it) or a block between the two deletes it. The other user is
         *     not told and keeps following. Counts toward the 60 relationship changes per hour of blocks and mutes (`429`).
         */
        post: operations["dismissFriendRequest"];
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
         *     Setting `is_series: true` while the playlist holds a video of another channel → `409` `SERIES_FOREIGN_ITEM`
         *     (nothing is removed silently). Setting it back to `false` always works.
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
         *     A series (`is_series`) only accepts the owner's own videos → `409` `SERIES_FOREIGN_ITEM`.
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
    "/v1/cinema/catalog": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Public cinema catalogue (series and standalone videos), newest first. Optional auth.
         * @description Same answer for every caller (personal state is never included), `Cache-Control: public, max-age=60`.
         *     - `SERIES`: a `PUBLIC` playlist with `is_series` and at least one playable episode. Ordered by the time its
         *       newest playable episode was added (`updated_at`).
         *     - `VIDEO`: a playable video that is not an episode of any `PUBLIC` series. Ordered by `added_at` (when
         *       social-svc saw `video.ready`).
         *     - `kind=all` interleaves both by that timestamp, newest first; ties break on id descending.
         *     The cursor is opaque and stable under inserts (keyset on timestamp + id). A video in several public series
         *     is hidden as a standalone item and appears under each series.
         */
        get: operations["listCinemaCatalog"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/series": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Public series that contain a video as a playable episode (task CIN3, ADR-045). Optional auth.
         * @description Lets the watch page show the episode list when the link has no `?playlist=` (search, history, Google, a
         *     shared link). Returns at most 5 series, newest `updated_at` first; clients use the first one and then call
         *     `getSeriesEpisode`. Same rules as `listSeriesEpisodes`: only `PUBLIC` playlists with `is_series` whose
         *     episode list contains `video_id` as a **playable** episode. An unknown, non-playable or non-episode video
         *     is an empty list (never 404). `Cache-Control: public, max-age=60`.
         *     Gateway: `/v1/series` already goes to social-svc.
         */
        get: operations["listSeriesForVideo"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/series/{playlist_id}/episodes": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                playlist_id: components["parameters"]["PlaylistId"];
            };
            cookie?: never;
        };
        /**
         * Playable episodes of a public series, in playlist order. Optional auth.
         * @description `404` `SERIES_NOT_FOUND` unless the playlist exists, is `PUBLIC`, has `is_series` and at least one playable
         *     episode (the owner gets the same answer: owners manage their lists through the playlist endpoints).
         *     `episode_number` is 1-based over playable episodes only, so it has no gaps. `Cache-Control: public, max-age=60`.
         */
        get: operations["listSeriesEpisodes"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/series/{playlist_id}/episodes/{video_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                playlist_id: components["parameters"]["PlaylistId"];
                video_id: components["parameters"]["VideoId"];
            };
            cookie?: never;
        };
        /**
         * Context of one episode for the watch page (number, previous, next). Optional auth.
         * @description Used by the watch page when the link carries `?playlist=<id>`. `404` `SERIES_NOT_FOUND` as in
         *     `listSeriesEpisodes`; `404` `EPISODE_NOT_FOUND` when the video is not a playable episode of that series (the
         *     client then plays the video without series context, never guessing another series). `previous_video_id` /
         *     `next_video_id` are the neighbouring playable episodes, null at the ends; `page_cursor` is the
         *     `listSeriesEpisodes` cursor of the page (default limit) that contains this episode, null for the first page.
         *     `Cache-Control: public, max-age=60`.
         */
        get: operations["getSeriesEpisode"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/posts": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Publish a post (text, images, an embedded video, or a reshare). */
        post: operations["createPost"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/posts/{post_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                post_id: components["parameters"]["PostId"];
            };
            cookie?: never;
        };
        /** One post (deep link). Optional auth. */
        get: operations["getPost"];
        put?: never;
        post?: never;
        /**
         * Delete (author, moderator or admin). Idempotent.
         * @description Sets `status = DELETED`, wipes the body and removes its images, reactions, hashtags and mentions; comments stay
         *     for moderation history but are no longer reachable. Reshares remain and show the original as unavailable.
         *     The post's images become unreferenced and are removed by storage-gc after 48 hours.
         */
        delete: operations["deletePost"];
        options?: never;
        head?: never;
        /**
         * Edit the body and/or visibility (author only). Sets `edited_at` when the body changes.
         * @description Mentions and hashtags are re-parsed from the new body; only users mentioned for the first time are notified.
         *     A reshare cannot become `FOLLOWERS` (`409` code `RESHARE_VISIBILITY`); a post that has reshares may become
         *     `FOLLOWERS`, and its reshares then show it as unavailable to non-followers. Editing a reshare to an empty body is
         *     allowed only when it is not the user's second plain reshare of that post (`409` code `ALREADY_RESHARED`).
         */
        patch: operations["editPost"];
        trace?: never;
    };
    "/v1/posts/{post_id}/moderation": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                post_id: components["parameters"]["PostId"];
            };
            cookie?: never;
        };
        get?: never;
        /** Hide or restore a post (moderator or admin). */
        put: operations["moderatePost"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/posts/{post_id}/reaction": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                post_id: components["parameters"]["PostId"];
            };
            cookie?: never;
        };
        get?: never;
        /** Set or replace the caller's reaction. Idempotent. */
        put: operations["setPostReaction"];
        post?: never;
        /** Remove the caller's reaction. Idempotent. */
        delete: operations["removePostReaction"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/posts/{post_id}/reactions": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                post_id: components["parameters"]["PostId"];
            };
            cookie?: never;
        };
        /**
         * Who reacted, newest first, optionally one kind. Optional auth.
         * @description Users in a block relation with the caller are left out.
         */
        get: operations["listPostReactions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/posts/{post_id}/comments": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                post_id: components["parameters"]["PostId"];
            };
            cookie?: never;
        };
        /** Top-level comments on a post, newest first. Optional auth. */
        get: operations["listPostComments"];
        put?: never;
        /** Comment on a post or reply to a top-level comment. */
        post: operations["createPostComment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/post-comments/{comment_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                comment_id: components["parameters"]["CommentId"];
            };
            cookie?: never;
        };
        /** One post comment (deep link). Optional auth. */
        get: operations["getPostComment"];
        put?: never;
        post?: never;
        /** Delete (comment author, post author, moderator or admin). Idempotent. */
        delete: operations["deletePostComment"];
        options?: never;
        head?: never;
        /** Edit the body (author only). Sets `edited_at`. */
        patch: operations["editPostComment"];
        trace?: never;
    };
    "/v1/post-comments/{comment_id}/replies": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                comment_id: components["parameters"]["CommentId"];
            };
            cookie?: never;
        };
        /** Replies to a top-level post comment, oldest first. Optional auth. */
        get: operations["listPostCommentReplies"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/post-comments/{comment_id}/moderation": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                comment_id: components["parameters"]["CommentId"];
            };
            cookie?: never;
        };
        get?: never;
        /** Hide or restore a post comment (moderator or admin). */
        put: operations["moderatePostComment"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/feed/following": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** "Đang theo dõi": own posts and posts of followed accounts, newest first. */
        get: operations["getFollowingFeed"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/feed/explore": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * "Khám phá": ranked public posts of the last 7 days. Optional auth.
         * @description The cursor pins the ranking snapshot it was issued from; a cursor older than the current snapshot returns
         *     `400` code `CURSOR_EXPIRED` and the client restarts from the first page.
         */
        get: operations["getExploreFeed"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/hashtags/{tag}/posts": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description A hashtag slug (`hanoi`) or its text (`HàNội`); social-svc derives the slug. */
                tag: string;
            };
            cookie?: never;
        };
        /** Posts with a hashtag, newest first. Optional auth. */
        get: operations["listHashtagPosts"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/hashtags/trending": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Top hashtags of the last 24 hours. Optional auth.
         * @description Ranked by the number of visible public posts of public accounts carrying the hashtag in the last 24 hours,
         *     then by slug. A top-N list with no cursor. `Cache-Control: public, max-age=60`.
         */
        get: operations["listTrendingHashtags"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/channels/{channel_id}/posts": {
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
         * A user's posts, newest first. Optional auth.
         * @description Only the posts the caller may see; a private account's timeline is empty for non-followers.
         */
        get: operations["listChannelPosts"];
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
            /**
             * @description The caller has a pending follow request to this private channel (SOC-1b). Sent by every SOC-1b server;
             *     clients treat a missing value as false.
             */
            requested?: boolean;
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
         *     `FOLLOW_REQUEST` — someone asked to follow your private account (SOC-1b; only the first time per requester).
         *     `FOLLOW_REQUEST_APPROVED` — your follow request was approved (actor = the account you now follow).
         *     `POST_COMMENT` — someone commented on your post (SOC-2a; `post_id`, `post_comment_id`).
         *     `POST_COMMENT_REPLY` — someone replied to your post comment (`post_id`, `post_comment_id` = the reply).
         *     `POST_MENTION` — someone mentioned you in a post (`post_id`; once per post).
         *     `POST_RESHARE` — someone reshared your post (`post_id` = the reshare).
         *     `POST_REACTION` — someone reacted to your post (`post_id`; once per reacting user and post).
         *     `FRIEND_ACCEPTED` — someone you follow followed you back, so you are now friends (SOC-6b; actor = the new
         *     friend; once per pair). Created in the same transaction as the `subscribe` that makes the pair mutual, for the
         *     user who followed first. A follow-request approval that makes a pair mutual creates only
         *     `FOLLOW_REQUEST_APPROVED`.
         *     No notification is created between users in a block relation, or for a muter from a muted actor. A post
         *     notification whose post or comment is gone, hidden or no longer visible to the recipient is not returned.
         *     Clients ignore kinds they do not know.
         * @enum {string}
         */
        NotificationKind: "VIDEO_PUBLISHED" | "VIDEO_COMMENT" | "COMMENT_REPLY" | "NEW_SUBSCRIBER" | "FOLLOW_REQUEST" | "FOLLOW_REQUEST_APPROVED" | "POST_COMMENT" | "POST_COMMENT_REPLY" | "POST_MENTION" | "POST_RESHARE" | "POST_REACTION" | "FRIEND_ACCEPTED";
        Notification: {
            id: components["schemas"]["Uuid"];
            kind: components["schemas"]["NotificationKind"];
            actor: components["schemas"]["PublicProfile"];
            /** Format: uuid */
            video_id: string | null;
            /** Format: uuid */
            comment_id: string | null;
            /**
             * Format: uuid
             * @description Set for `POST_*` kinds (SOC-2a). Sent by every SOC-2a server; a missing value means `null`.
             */
            post_id?: string | null;
            /**
             * Format: uuid
             * @description Set for `POST_COMMENT` and `POST_COMMENT_REPLY`. A missing value means `null`.
             */
            post_comment_id?: string | null;
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
            /**
             * @description Marked by the owner as a series ("Bộ phim", task CIN2). Always false for the watch-later list. social-svc
             *     always sends it; it is optional in the schema only so clients built before CIN2 stay valid (absent = false).
             */
            is_series?: boolean;
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
            /** @description Mark as a series ("Bộ phim", task CIN2); absent = false. A new playlist is empty, so this never conflicts. */
            is_series?: boolean;
        };
        UpdatePlaylistRequest: {
            title?: string;
            description?: string;
            visibility?: components["schemas"]["Visibility"];
            /** @description See `updatePlaylist` for `409` `SERIES_FOREIGN_ITEM`. */
            is_series?: boolean;
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
        /**
         * @description `POST` and `POST_COMMENT` since SOC-2a; `target_id` is the post or post comment id.
         * @enum {string}
         */
        ReportTargetType: "VIDEO" | "COMMENT" | "USER" | "POST" | "POST_COMMENT";
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
        SeriesSummary: {
            playlist_id: components["schemas"]["Uuid"];
            title: string;
            description: string;
            owner: components["schemas"]["PublicProfile"];
            /** @description Playable episodes only (never PL1 `item_count`). */
            episode_count: number;
            /** @description First playable episode; its thumbnail is the series cover and "Xem ngay" starts here. */
            first_video_id: components["schemas"]["Uuid"];
            /** Format: date-time */
            updated_at: string;
        };
        SeriesForVideo: {
            items: components["schemas"]["SeriesSummary"][];
        };
        CinemaCatalogItem: components["schemas"]["CinemaCatalogSeries"] | components["schemas"]["CinemaCatalogVideo"];
        CinemaCatalogSeries: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "SERIES";
            series: components["schemas"]["SeriesSummary"];
        };
        CinemaCatalogVideo: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            kind: "VIDEO";
            video_id: components["schemas"]["Uuid"];
            /** Format: date-time */
            added_at: string;
        };
        CinemaCatalogPage: {
            items: components["schemas"]["CinemaCatalogItem"][];
            next_cursor: string | null;
        };
        SeriesEpisode: {
            video_id: components["schemas"]["Uuid"];
            episode_number: number;
        };
        SeriesEpisodePage: {
            series: components["schemas"]["SeriesSummary"];
            items: components["schemas"]["SeriesEpisode"][];
            next_cursor: string | null;
        };
        SeriesEpisodeContext: {
            series: components["schemas"]["SeriesSummary"];
            episode_number: number;
            previous_video_id: components["schemas"]["Uuid"] | null;
            next_video_id: components["schemas"]["Uuid"] | null;
            page_cursor: string | null;
        };
        FollowItem: {
            user: components["schemas"]["PublicProfile"];
            /** Format: date-time */
            followed_at: string;
        };
        FollowPage: {
            items: components["schemas"]["FollowItem"][];
            next_cursor: string | null;
        };
        FollowRequest: {
            requester: components["schemas"]["PublicProfile"];
            /** Format: date-time */
            requested_at: string;
        };
        FollowRequestPage: {
            items: components["schemas"]["FollowRequest"][];
            next_cursor: string | null;
            pending_count: number;
        };
        FollowRequestDecision: {
            /** @enum {string} */
            decision: "APPROVE" | "REJECT";
        };
        Relationship: {
            user_id: components["schemas"]["Uuid"];
            following: boolean;
            /** @description The caller has a pending request to this user. */
            follow_requested: boolean;
            followed_by: boolean;
            /** @description The caller blocks this user. */
            blocking: boolean;
            muting: boolean;
        };
        RelationItem: {
            user: components["schemas"]["PublicProfile"];
            /** Format: date-time */
            since: string;
        };
        RelationPage: {
            items: components["schemas"]["RelationItem"][];
            next_cursor: string | null;
        };
        PeoplePage: {
            items: components["schemas"]["PublicProfile"][];
            next_cursor: string | null;
        };
        FriendItem: {
            user: components["schemas"]["PublicProfile"];
            /**
             * Format: date-time
             * @description When the pair became mutual (the later of the two follows).
             */
            friends_since: string;
        };
        FriendPage: {
            items: components["schemas"]["FriendItem"][];
            next_cursor: string | null;
        };
        FriendRequest: {
            user: components["schemas"]["PublicProfile"];
            /**
             * Format: date-time
             * @description When they started following the caller.
             */
            followed_at: string;
        };
        FriendRequestPage: {
            items: components["schemas"]["FriendRequest"][];
            next_cursor: string | null;
            pending_count: number;
        };
        /**
         * @description A private account's posts are followers-only whatever this value says.
         * @enum {string}
         */
        PostVisibility: "PUBLIC" | "FOLLOWERS";
        /** @enum {string} */
        PostStatus: "VISIBLE" | "DELETED" | "HIDDEN";
        /** @enum {string} */
        ReactionKind: "LIKE" | "LOVE" | "HAHA" | "WOW" | "SAD" | "ANGRY";
        PostImage: {
            id: components["schemas"]["Uuid"];
            /**
             * Format: uri
             * @description WebP, long edge ≤ 1600 px (`MEDIA_BASE_URL` + image key).
             */
            url: string;
            /**
             * Format: uri
             * @description WebP, long edge ≤ 400 px.
             */
            thumb_url: string;
            width: number;
            height: number;
        };
        PostMention: {
            user_id: components["schemas"]["Uuid"];
            /** @description Current handle; the body keeps the handle as written. */
            handle: string;
        };
        PostHashtag: {
            /** @description As first written in the body, without `#`. */
            tag: string;
            slug: string;
        };
        ReactionCount: {
            reaction: components["schemas"]["ReactionKind"];
            count: number;
        };
        Post: {
            id: components["schemas"]["Uuid"];
            /** @description `null` when the author no longer has an active profile. */
            author: components["schemas"]["PublicProfile"] | null;
            body: string;
            visibility: components["schemas"]["PostVisibility"];
            status: components["schemas"]["PostStatus"];
            images: components["schemas"]["PostImage"][];
            /** @description Embedded Winkey video, or `null` (none, or the caller cannot play it). Hydrate with video-svc `batchGetVideos`. */
            video_id: components["schemas"]["Uuid"] | null;
            /** @description Id of the reshared original, or `null`. */
            reshare_of: components["schemas"]["Uuid"] | null;
            /**
             * @description The original, one level deep (its own `reshared_post` is always `null`), or `null` when this is not a reshare
             *     or the caller cannot see the original.
             */
            reshared_post: components["schemas"]["Post"] | null;
            /** @description This is a reshare whose original is deleted, hidden, or not visible to the caller. */
            reshare_unavailable: boolean;
            mentions: components["schemas"]["PostMention"][];
            hashtags: components["schemas"]["PostHashtag"][];
            reaction_count: number;
            /** @description The most used reaction kinds on this post, most used first. */
            top_reactions: components["schemas"]["ReactionCount"][];
            /** @description The caller's reaction; `null` when none or anonymous. */
            my_reaction: components["schemas"]["ReactionKind"] | null;
            comment_count: number;
            reshare_count: number;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            edited_at: string | null;
            /** @description The caller is the author and the post is VISIBLE. */
            can_edit: boolean;
            /** @description The caller is the author, a moderator or an admin. */
            can_delete: boolean;
        };
        PostPage: {
            items: components["schemas"]["Post"][];
            next_cursor: string | null;
        };
        CreatePostRequest: {
            /**
             * @description Plain text, trimmed. Required (non-empty after trimming) unless an attachment is given.
             * @default
             */
            body: string;
            /** @description Defaults to `PUBLIC`. A reshare must be `PUBLIC`. */
            visibility?: components["schemas"]["PostVisibility"];
            /**
             * @description `POST` images, `READY`, owned by the caller and not used by another post; otherwise `400` code
             *     `IMAGE_INVALID`. Exclusive with `video_id` and `reshare_of`.
             */
            image_ids?: components["schemas"]["Uuid"][];
            /** @description A Winkey video the caller can play (`PUBLIC` or `UNLISTED`, or the caller's own); otherwise `404`. */
            video_id?: components["schemas"]["Uuid"];
            /**
             * @description A post the caller can see, `PUBLIC`, by a public account; otherwise `404` (cannot see) or `409` code
             *     `NOT_RESHAREABLE`. A reshare of a reshare points at its original.
             */
            reshare_of?: components["schemas"]["Uuid"];
        };
        EditPostRequest: {
            /** @description The trimmed body may be empty only if the post has an attachment. */
            body?: string;
            visibility?: components["schemas"]["PostVisibility"];
        };
        SetReactionRequest: {
            reaction: components["schemas"]["ReactionKind"];
        };
        ReactionState: {
            post_id: components["schemas"]["Uuid"];
            my_reaction: components["schemas"]["ReactionKind"] | null;
            reaction_count: number;
            top_reactions: components["schemas"]["ReactionCount"][];
        };
        ReactionItem: {
            user: components["schemas"]["PublicProfile"];
            reaction: components["schemas"]["ReactionKind"];
            /** Format: date-time */
            created_at: string;
        };
        ReactionPage: {
            items: components["schemas"]["ReactionItem"][];
            next_cursor: string | null;
        };
        PostComment: {
            id: components["schemas"]["Uuid"];
            post_id: components["schemas"]["Uuid"];
            /** @description `null` for a top-level comment. */
            parent_id: components["schemas"]["Uuid"] | null;
            /** @description `null` when the author no longer has an active profile. */
            author: components["schemas"]["PublicProfile"] | null;
            /** @description Empty for `DELETED` tombstones. */
            body: string;
            status: components["schemas"]["CommentStatus"];
            reply_count: number;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            edited_at: string | null;
            /** @description The caller is the author and the comment is VISIBLE. */
            can_edit: boolean;
            /** @description The caller is the comment author, the post author, a moderator or an admin. */
            can_delete: boolean;
        };
        PostCommentPage: {
            items: components["schemas"]["PostComment"][];
            next_cursor: string | null;
        };
        TrendingHashtag: {
            /** @description The most used spelling in the window. */
            tag: string;
            slug: string;
            post_count: number;
        };
        TrendingHashtags: {
            items: components["schemas"]["TrendingHashtag"][];
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
        /** @description Authenticated but not allowed. */
        Forbidden: {
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
    };
    parameters: {
        CommentId: components["schemas"]["Uuid"];
        /** @description User id of the channel owner. */
        ChannelId: components["schemas"]["Uuid"];
        /** @description User id of the other user. */
        RelationUserId: components["schemas"]["Uuid"];
        PlaylistId: components["schemas"]["Uuid"];
        PostId: components["schemas"]["Uuid"];
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
            403: components["responses"]["Forbidden"];
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
    listFollowers: {
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
            /** @description One page. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FollowPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            403: components["responses"]["Forbidden"];
        };
    };
    listFollowing: {
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
            /** @description One page. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FollowPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            403: components["responses"]["Forbidden"];
        };
    };
    getRelationship: {
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
            /** @description Relationship flags. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Relationship"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
        };
    };
    listFollowRequests: {
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
            /** @description One page. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FollowRequestPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
        };
    };
    decideFollowRequest: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                requester_id: components["schemas"]["Uuid"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["FollowRequestDecision"];
            };
        };
        responses: {
            /** @description Decided. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    listMyBlocks: {
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
            /** @description One page. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RelationPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
        };
    };
    blockUser: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description User id of the other user. */
                user_id: components["parameters"]["RelationUserId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Blocked. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    unblockUser: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description User id of the other user. */
                user_id: components["parameters"]["RelationUserId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Not blocked. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    listMyMutes: {
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
            /** @description One page. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RelationPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
        };
    };
    muteUser: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description User id of the other user. */
                user_id: components["parameters"]["RelationUserId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Muted. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    unmuteUser: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description User id of the other user. */
                user_id: components["parameters"]["RelationUserId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Not muted. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    searchPeople: {
        parameters: {
            query: {
                /** @description Handle or display name; a leading `@` is ignored. */
                q: string;
                limit?: number;
                /** @description Opaque cursor copied from `next_cursor` of the previous page. */
                cursor?: components["parameters"]["Cursor"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of people. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PeoplePage"];
                };
            };
            400: components["responses"]["BadRequest"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    listMyFriends: {
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
            /** @description One page of friends. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FriendPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
        };
    };
    listFriendRequests: {
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
            /** @description One page of friend requests. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["FriendRequestPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
        };
    };
    dismissFriendRequest: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                /** @description User id of the other user. */
                user_id: components["parameters"]["RelationUserId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Dismissed. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
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
    listCinemaCatalog: {
        parameters: {
            query?: {
                kind?: "all" | "series" | "video";
                /** @description Opaque cursor copied from `next_cursor` of the previous page. */
                cursor?: components["parameters"]["Cursor"];
                /** @description At most 48, so one `batchGetVideos` call (50 ids) can hydrate a page. */
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of catalogue items. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CinemaCatalogPage"];
                };
            };
            400: components["responses"]["BadRequest"];
        };
    };
    listSeriesForVideo: {
        parameters: {
            query: {
                video_id: components["schemas"]["Uuid"];
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The series containing the video (possibly empty). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SeriesForVideo"];
                };
            };
            400: components["responses"]["BadRequest"];
        };
    };
    listSeriesEpisodes: {
        parameters: {
            query?: {
                /** @description Opaque cursor copied from `next_cursor` of the previous page. */
                cursor?: components["parameters"]["Cursor"];
                limit?: number;
            };
            header?: never;
            path: {
                playlist_id: components["parameters"]["PlaylistId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The series and one page of episodes. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SeriesEpisodePage"];
                };
            };
            400: components["responses"]["BadRequest"];
            404: components["responses"]["NotFound"];
        };
    };
    getSeriesEpisode: {
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
            /** @description Episode context. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SeriesEpisodeContext"];
                };
            };
            404: components["responses"]["NotFound"];
        };
    };
    createPost: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreatePostRequest"];
            };
        };
        responses: {
            /** @description Created. */
            201: {
                headers: {
                    /** @description `/v1/posts/{post_id}` */
                    Location?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Post"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    getPost: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                post_id: components["parameters"]["PostId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The post. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Post"];
                };
            };
            404: components["responses"]["NotFound"];
        };
    };
    deletePost: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                post_id: components["parameters"]["PostId"];
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
    editPost: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                post_id: components["parameters"]["PostId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["EditPostRequest"];
            };
        };
        responses: {
            /** @description Updated post. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Post"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    moderatePost: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                post_id: components["parameters"]["PostId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ModerateCommentRequest"];
            };
        };
        responses: {
            /** @description Post after moderation. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Post"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    setPostReaction: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                post_id: components["parameters"]["PostId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SetReactionRequest"];
            };
        };
        responses: {
            /** @description Reaction state after the change. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReactionState"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    removePostReaction: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                post_id: components["parameters"]["PostId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Reaction state after the change. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReactionState"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    listPostReactions: {
        parameters: {
            query?: {
                reaction?: components["schemas"]["ReactionKind"];
                /** @description Opaque cursor copied from `next_cursor` of the previous page. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path: {
                post_id: components["parameters"]["PostId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of reactions. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["ReactionPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            404: components["responses"]["NotFound"];
        };
    };
    listPostComments: {
        parameters: {
            query?: {
                /** @description Opaque cursor copied from `next_cursor` of the previous page. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path: {
                post_id: components["parameters"]["PostId"];
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
                    "application/json": components["schemas"]["PostCommentPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            404: components["responses"]["NotFound"];
        };
    };
    createPostComment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                post_id: components["parameters"]["PostId"];
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
                    /** @description `/v1/post-comments/{comment_id}` */
                    Location?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostComment"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    getPostComment: {
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
                    "application/json": components["schemas"]["PostComment"];
                };
            };
            404: components["responses"]["NotFound"];
        };
    };
    deletePostComment: {
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
    editPostComment: {
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
                    "application/json": components["schemas"]["PostComment"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    listPostCommentReplies: {
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
                    "application/json": components["schemas"]["PostCommentPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            404: components["responses"]["NotFound"];
        };
    };
    moderatePostComment: {
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
                    "application/json": components["schemas"]["PostComment"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    getFollowingFeed: {
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
            /** @description One page of posts. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
        };
    };
    getExploreFeed: {
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
            /** @description One page of posts. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostPage"];
                };
            };
            400: components["responses"]["BadRequest"];
        };
    };
    listHashtagPosts: {
        parameters: {
            query?: {
                /** @description Opaque cursor copied from `next_cursor` of the previous page. */
                cursor?: components["parameters"]["Cursor"];
                limit?: components["parameters"]["Limit"];
            };
            header?: never;
            path: {
                /** @description A hashtag slug (`hanoi`) or its text (`HàNội`); social-svc derives the slug. */
                tag: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page of posts. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostPage"];
                };
            };
            400: components["responses"]["BadRequest"];
        };
    };
    listTrendingHashtags: {
        parameters: {
            query?: {
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Trending hashtags. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TrendingHashtags"];
                };
            };
            400: components["responses"]["BadRequest"];
        };
    };
    listChannelPosts: {
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
            /** @description One page of posts. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PostPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            404: components["responses"]["NotFound"];
        };
    };
}

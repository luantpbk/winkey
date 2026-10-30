export interface paths {
    "/v1/chat/devices": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** The caller's active devices (for settings), newest first. */
        get: operations["listMyDevices"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/chat/devices/{device_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                device_id: components["parameters"]["DeviceId"];
            };
            cookie?: never;
        };
        get?: never;
        /**
         * Register a device, or update its display name and fallback key.
         * @description First call registers the device (`201`): the signature must verify with `ed25519_key` over the canonical
         *     device-keys JSON with this `device_id` and the caller's user id. Later calls (`200`) may change
         *     `display_name` and `fallback_key` only; different identity keys → `409 DEVICE_KEYS_IMMUTABLE`. A device id
         *     owned by another user, or removed → `409 DEVICE_ID_IN_USE`. An identity key already used by any device →
         *     `409 IDENTITY_KEY_IN_USE`. An 11th active device → `409 TOO_MANY_DEVICES`. Registration and removal send a
         *     `chat.hint` `DEVICES` to every user sharing a conversation with the caller.
         */
        put: operations["putMyDevice"];
        post?: never;
        /**
         * Remove one of the caller's devices (logout of E2EE on that browser). Idempotent.
         * @description Sets `deleted_at`, deletes its one-time keys and pending to-device messages. Messages it sent stay readable
         *     by devices that already hold the Megolm keys. Unknown or another user's device → `404`.
         */
        delete: operations["deleteMyDevice"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/chat/devices/{device_id}/one-time-keys": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                device_id: components["parameters"]["DeviceId"];
            };
            cookie?: never;
        };
        /** How many one-time keys the device still has on the server. */
        get: operations["countOneTimeKeys"];
        put?: never;
        /**
         * Upload signed one-time keys for one of the caller's devices.
         * @description Each key's signature must verify (canonical one-time key JSON, `fallback: false`). A `key_id` already stored
         *     for the device is ignored (idempotent retry). More than 100 stored keys after the upload →
         *     `409 TOO_MANY_ONE_TIME_KEYS` and nothing is stored. Clients top up when `count` falls below 20.
         */
        post: operations["uploadOneTimeKeys"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/chat/devices/query": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Active device keys of up to 50 users.
         * @description Users without an active profile, and users in a block relation with the caller, are returned with an empty
         *     list. The caller's own devices may be queried too.
         */
        post: operations["queryDevices"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/chat/keys/claim": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Claim one one-time key per target device to start Olm sessions.
         * @description For each device: one stored one-time key is removed and returned (concurrent claims never get the same key);
         *     when none is left, the device's fallback key is returned (`fallback: true`, not removed). Devices that are
         *     removed, unknown, without any key, or whose owner is in a block relation with the caller are left out.
         */
        post: operations["claimKeys"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/chat/to-device": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Send Olm-encrypted messages to specific devices.
         * @description `sender_device_id` must be one of the caller's active devices (`403 DEVICE_NOT_YOURS`). A recipient device is
         *     accepted when it is one of the caller's own active devices, or belongs to a user who shares a conversation
         *     with the caller (both memberships `ACTIVE` or `REQUESTED`) and is not in a block relation with them; other
         *     recipients are skipped silently and listed in `skipped_device_ids`. One `chat.hint` `TO_DEVICE` is sent per
         *     recipient user.
         */
        post: operations["sendToDevice"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/chat/devices/{device_id}/to-device": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                device_id: components["parameters"]["DeviceId"];
            };
            cookie?: never;
        };
        /**
         * Pending to-device messages of one of the caller's devices, oldest first.
         * @description Also sets the device's `last_seen_at` (at most once a minute).
         */
        get: operations["listToDevice"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/chat/devices/{device_id}/to-device/ack": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                device_id: components["parameters"]["DeviceId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Delete the device's to-device messages up to and including `up_to`. Idempotent. */
        post: operations["ackToDevice"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/chat/conversations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The caller's conversations, most recent activity first.
         * @description `state=ACTIVE` (default) lists conversations the caller is in; `state=REQUESTED` lists message requests.
         *     Ordered by `last_message_at` (then `created_at`) descending, then `id`.
         */
        get: operations["listConversations"];
        put?: never;
        /**
         * Start a direct conversation or create a group.
         * @description - `DIRECT`: `user_ids` holds exactly one other user. If a `DIRECT` conversation with them exists, it is returned
         *       with `200`; if the caller had left it, the caller becomes `ACTIVE` again (`joined_seq` = `last_seq` + 1) and
         *       the other side is unchanged. Otherwise `201`; the other user is `ACTIVE` when they follow the caller, else
         *       `REQUESTED`.
         *     - `GROUP`: `title` required; `user_ids` 1–49 other users; the caller is `OWNER`; each other member is `ACTIVE`
         *       or `REQUESTED` as above.
         *     - A user without an active profile → `404 USER_NOT_FOUND`; a block relation with any of them →
         *       `403 INTERACTION_BLOCKED`; the caller in `user_ids` → `400`.
         *     - Writes a `SYSTEM` message `conversation_created` and sends `chat.hint` `CONVERSATION` to every member.
         */
        post: operations["createConversation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/chat/conversations/{conversation_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                conversation_id: components["parameters"]["ConversationId"];
            };
            cookie?: never;
        };
        /** One conversation the caller is or was a member of (otherwise `404`). */
        get: operations["getConversation"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        /**
         * Rename a group (`OWNER` or `ADMIN`).
         * @description `DIRECT` → `409 NOT_A_GROUP`; a `MEMBER` → `403`. Writes a `SYSTEM` message `title_changed`.
         */
        patch: operations["updateConversation"];
        trace?: never;
    };
    "/v1/chat/conversations/{conversation_id}/members": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                conversation_id: components["parameters"]["ConversationId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Add users to a group (`OWNER` or `ADMIN`).
         * @description Same `ACTIVE`/`REQUESTED`, block and profile rules as `createConversation`. Users already `ACTIVE` or
         *     `REQUESTED` are ignored; `LEFT` users rejoin with `joined_seq` = `last_seq` + 1 (they never get history).
         *     More than 50 members → `409 TOO_MANY_MEMBERS`. `DIRECT` → `409 NOT_A_GROUP`. One `SYSTEM` message
         *     `member_added` per added user.
         */
        post: operations["addMembers"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/chat/conversations/{conversation_id}/members/{user_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                conversation_id: components["parameters"]["ConversationId"];
                user_id: components["schemas"]["Uuid"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Leave (yourself) or remove a member from a group (`OWNER`, or `ADMIN` for `MEMBER`s).
         * @description Sets `state = LEFT` and `left_seq` = `last_seq`. Leaving also declines a request. When the `OWNER` leaves a
         *     group, the oldest `ADMIN` (else the oldest `ACTIVE` member) becomes `OWNER`. Removing someone else from a
         *     `DIRECT` conversation → `403`. Writes a `SYSTEM` message `member_left` or `member_removed`. Idempotent.
         */
        delete: operations["removeMember"];
        options?: never;
        head?: never;
        /**
         * Change a member's role (`OWNER` only) or the caller's own mute.
         * @description `role` (`ADMIN` or `MEMBER`, groups only) may be set by the `OWNER` on another member. `muted_until` (a future
         *     time, or `null` to unmute) may be set only on the caller's own membership. Anything else → `403`.
         */
        patch: operations["updateMember"];
        trace?: never;
    };
    "/v1/chat/conversations/{conversation_id}/accept": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                conversation_id: components["parameters"]["ConversationId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Accept a message request (`REQUESTED` → `ACTIVE`). Idempotent for `ACTIVE`.
         * @description `LEFT` → `409 CONVERSATION_CLOSED`. Writes a `SYSTEM` message `request_accepted` (clients share their Megolm
         *     keys with the new active member's devices).
         */
        post: operations["acceptConversation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/chat/conversations/{conversation_id}/read": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                conversation_id: components["parameters"]["ConversationId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Move the caller's read marker forward (never backwards). Idempotent. */
        post: operations["markRead"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/chat/conversations/{conversation_id}/messages": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                conversation_id: components["parameters"]["ConversationId"];
            };
            cookie?: never;
        };
        /**
         * Messages in `seq` order, within the caller's readable range.
         * @description The readable range is `joined_seq` through `last_seq` (or `left_seq` once `LEFT`). With `after_seq`: the next
         *     messages after it; with `before_seq`: the messages just before it (still returned in ascending order);
         *     neither: the newest page. Both → `400`.
         */
        get: operations["listMessages"];
        put?: never;
        /**
         * Send a Megolm-encrypted message.
         * @description - The caller must be `ACTIVE` (`REQUESTED` → `403 REQUEST_PENDING`, `LEFT` → `404`), and `sender_device_id` one
         *       of their active devices (`403 DEVICE_NOT_YOURS`).
         *     - `DIRECT`: the other member `LEFT` → `409 CONVERSATION_CLOSED`; a block relation → `403 INTERACTION_BLOCKED`.
         *     - The same `client_msg_id` from the same user returns the stored message with `200` (safe retry).
         *     - Assigns `seq` = `last_seq` + 1 and sends `chat.hint` `MESSAGE` to every `ACTIVE` and `REQUESTED` member.
         */
        post: operations["sendMessage"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/chat/conversations/{conversation_id}/messages/{seq}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                conversation_id: components["parameters"]["ConversationId"];
                seq: number;
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Delete one of the caller's own messages for everyone (tombstone). Idempotent.
         * @description Removes the ciphertext and sets `deleted`; the `seq` stays. Someone else's or a `SYSTEM` message → `403`.
         *     Sends `chat.hint` `MESSAGE` so clients refetch.
         */
        delete: operations["deleteMessage"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        /** @description Curve25519 or ed25519 public key, unpadded base64. */
        Base64Key: string;
        /** @description ed25519 signature, unpadded base64. */
        Base64Signature: string;
        SignedKey: {
            key_id: string;
            public_key: components["schemas"]["Base64Key"];
            signature: components["schemas"]["Base64Signature"];
        };
        DeviceRegistration: {
            display_name: string;
            curve25519_key: components["schemas"]["Base64Key"];
            ed25519_key: components["schemas"]["Base64Key"];
            signature: components["schemas"]["Base64Signature"];
            fallback_key?: components["schemas"]["SignedKey"];
        };
        OwnDevice: {
            id: components["schemas"]["Uuid"];
            display_name: string;
            curve25519_key: components["schemas"]["Base64Key"];
            ed25519_key: components["schemas"]["Base64Key"];
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            last_seen_at: string;
        };
        /** @description What other users see of a device (no display name, no activity times). */
        PublicDevice: {
            id: components["schemas"]["Uuid"];
            user_id: components["schemas"]["Uuid"];
            curve25519_key: components["schemas"]["Base64Key"];
            ed25519_key: components["schemas"]["Base64Key"];
            signature: components["schemas"]["Base64Signature"];
            /** Format: date-time */
            created_at: string;
        };
        OneTimeKeyCount: {
            count: number;
            fallback_key_id: string | null;
        };
        ClaimedKey: {
            device_id: components["schemas"]["Uuid"];
            user_id: components["schemas"]["Uuid"];
            curve25519_key: components["schemas"]["Base64Key"];
            ed25519_key: components["schemas"]["Base64Key"];
            key_id: string;
            public_key: components["schemas"]["Base64Key"];
            signature: components["schemas"]["Base64Signature"];
            fallback: boolean;
        };
        ToDeviceMessage: {
            /** @description Increasing per server; pass the last processed one as `after` and to `ack`. */
            id: string;
            sender_id: components["schemas"]["Uuid"];
            sender_device_id: components["schemas"]["Uuid"];
            ciphertext: string;
            /** Format: date-time */
            created_at: string;
        };
        /** @enum {string} */
        MemberRole: "OWNER" | "ADMIN" | "MEMBER";
        /** @enum {string} */
        MemberState: "ACTIVE" | "REQUESTED" | "LEFT";
        Member: {
            user_id: components["schemas"]["Uuid"];
            /** @description `null` when the user no longer has an active profile. */
            user: components["schemas"]["PublicProfile"] | null;
            role: components["schemas"]["MemberRole"];
            state: components["schemas"]["MemberState"];
        };
        Conversation: {
            id: components["schemas"]["Uuid"];
            /** @enum {string} */
            kind: "DIRECT" | "GROUP";
            /** @description Groups only. Clients name a `DIRECT` conversation after the other member. */
            title: string | null;
            /** @description `ACTIVE` and `REQUESTED` members (never `LEFT` ones), owner first, then by join time. */
            members: components["schemas"]["Member"][];
            my_role: components["schemas"]["MemberRole"];
            my_state: components["schemas"]["MemberState"];
            /** Format: int64 */
            last_seq: number;
            /** Format: date-time */
            last_message_at: string | null;
            /** @description Messages after `max(last_read_seq, joined_seq - 1)` not sent by the caller, capped at 99. */
            unread_count: number;
            /** Format: date-time */
            muted_until: string | null;
            /** Format: date-time */
            created_at: string;
        };
        ConversationPage: {
            items: components["schemas"]["Conversation"][];
            next_cursor: string | null;
        };
        CreateConversationRequest: {
            /** @enum {string} */
            kind: "DIRECT" | "GROUP";
            /** @description Required for `GROUP`, forbidden for `DIRECT`. */
            title?: string;
            user_ids: components["schemas"]["Uuid"][];
        };
        SendMessageRequest: {
            client_msg_id: components["schemas"]["Uuid"];
            sender_device_id: components["schemas"]["Uuid"];
            megolm_session_id: string;
            /** @description Megolm message, base64, ≤ 64 KiB decoded. Its plaintext is a JSON event chosen by the client. */
            ciphertext: string;
        };
        /** @description Written by chat-svc; plaintext. */
        SystemBody: {
            /** @enum {string} */
            type: "conversation_created" | "member_added" | "member_left" | "member_removed" | "request_accepted" | "title_changed" | "owner_changed";
            /** @description The member concerned, when any. */
            user_id?: components["schemas"]["Uuid"] | null;
            /** @description Who did it, when not the member themselves. */
            by?: components["schemas"]["Uuid"] | null;
            title?: string | null;
        };
        Message: {
            conversation_id: components["schemas"]["Uuid"];
            /** Format: int64 */
            seq: number;
            id: components["schemas"]["Uuid"];
            /** @enum {string} */
            kind: "ENCRYPTED" | "SYSTEM";
            sender_id: components["schemas"]["Uuid"] | null;
            sender_device_id: components["schemas"]["Uuid"] | null;
            megolm_session_id: string | null;
            /** @description `null` for `SYSTEM` messages and deleted messages. */
            ciphertext: string | null;
            system: components["schemas"]["SystemBody"] | null;
            deleted: boolean;
            /** Format: date-time */
            created_at: string;
        };
        /**
         * Format: uuid
         * @description UUIDv7 generated by the owning service.
         * @example 0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c0d
         */
        Uuid: string;
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
        PublicProfile: {
            id: components["schemas"]["Uuid"];
            handle: string;
            display_name: string;
            /** Format: uri */
            avatar_url: string | null;
        };
    };
    responses: {
        /** @description Missing or invalid credentials. */
        Unauthorized: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Validation failed. */
        BadRequest: {
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
        /** @description Resource does not exist or is not visible to the caller. */
        NotFound: {
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
        DeviceId: components["schemas"]["Uuid"];
        ConversationId: components["schemas"]["Uuid"];
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
    listMyDevices: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Devices. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["OwnDevice"][];
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    putMyDevice: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                device_id: components["parameters"]["DeviceId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DeviceRegistration"];
            };
        };
        responses: {
            /** @description Updated. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OwnDevice"];
                };
            };
            /** @description Registered. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OwnDevice"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Conflict"];
        };
    };
    deleteMyDevice: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                device_id: components["parameters"]["DeviceId"];
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
    countOneTimeKeys: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                device_id: components["parameters"]["DeviceId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Count. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OneTimeKeyCount"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    uploadOneTimeKeys: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                device_id: components["parameters"]["DeviceId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    keys: components["schemas"]["SignedKey"][];
                };
            };
        };
        responses: {
            /** @description Stored. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["OneTimeKeyCount"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    queryDevices: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    user_ids: components["schemas"]["Uuid"][];
                };
            };
        };
        responses: {
            /** @description Devices per user. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        users: {
                            user_id: components["schemas"]["Uuid"];
                            devices: components["schemas"]["PublicDevice"][];
                        }[];
                    };
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
        };
    };
    claimKeys: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    device_ids: components["schemas"]["Uuid"][];
                };
            };
        };
        responses: {
            /** @description Claimed keys. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        keys: components["schemas"]["ClaimedKey"][];
                    };
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    sendToDevice: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    sender_device_id: components["schemas"]["Uuid"];
                    messages: {
                        device_id: components["schemas"]["Uuid"];
                        /** @description Olm message (JSON `{type, body}` serialised, then base64), ≤ 16 KiB decoded. */
                        ciphertext: string;
                    }[];
                };
            };
        };
        responses: {
            /** @description Accepted. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        accepted: number;
                        skipped_device_ids: components["schemas"]["Uuid"][];
                    };
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    listToDevice: {
        parameters: {
            query?: {
                /** @description Return messages with an id greater than this (the last id the client processed). */
                after?: string;
                limit?: number;
            };
            header?: never;
            path: {
                device_id: components["parameters"]["DeviceId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Pending messages. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["ToDeviceMessage"][];
                        has_more: boolean;
                    };
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    ackToDevice: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                device_id: components["parameters"]["DeviceId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    up_to: string;
                };
            };
        };
        responses: {
            /** @description Deleted. */
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
    listConversations: {
        parameters: {
            query?: {
                state?: "ACTIVE" | "REQUESTED";
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
                    "application/json": components["schemas"]["ConversationPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
        };
    };
    createConversation: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateConversationRequest"];
            };
        };
        responses: {
            /** @description Existing direct conversation. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Conversation"];
                };
            };
            /** @description Created. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Conversation"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    getConversation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                conversation_id: components["parameters"]["ConversationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The conversation. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Conversation"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    updateConversation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                conversation_id: components["parameters"]["ConversationId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    title: string;
                };
            };
        };
        responses: {
            /** @description Updated. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Conversation"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    addMembers: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                conversation_id: components["parameters"]["ConversationId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    user_ids: components["schemas"]["Uuid"][];
                };
            };
        };
        responses: {
            /** @description Updated. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Conversation"];
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
    removeMember: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                conversation_id: components["parameters"]["ConversationId"];
                user_id: components["schemas"]["Uuid"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Done. */
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
    updateMember: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                conversation_id: components["parameters"]["ConversationId"];
                user_id: components["schemas"]["Uuid"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** @enum {string} */
                    role?: "ADMIN" | "MEMBER";
                    /** Format: date-time */
                    muted_until?: string | null;
                };
            };
        };
        responses: {
            /** @description Updated. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Conversation"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    acceptConversation: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                conversation_id: components["parameters"]["ConversationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Accepted. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Conversation"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    markRead: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                conversation_id: components["parameters"]["ConversationId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: int64 */
                    seq: number;
                };
            };
        };
        responses: {
            /** @description Saved (`seq` above `last_seq` is clamped to `last_seq`). */
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
    listMessages: {
        parameters: {
            query?: {
                after_seq?: number;
                before_seq?: number;
                limit?: number;
            };
            header?: never;
            path: {
                conversation_id: components["parameters"]["ConversationId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page, ascending by `seq`. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["Message"][];
                        /** @description More messages exist in the requested direction. */
                        has_more: boolean;
                    };
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    sendMessage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                conversation_id: components["parameters"]["ConversationId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SendMessageRequest"];
            };
        };
        responses: {
            /** @description Already stored (retry). */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Message"];
                };
            };
            /** @description Stored. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Message"];
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
    deleteMessage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                conversation_id: components["parameters"]["ConversationId"];
                seq: number;
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
}

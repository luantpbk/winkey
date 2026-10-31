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
    "/v1/chat/calls/turn-credentials": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Short-lived TURN credentials for a WebRTC call.
         * @description Time-limited credentials in the coturn REST API scheme (`use-auth-secret`): `username` is
         *     `<expiry unix seconds>:<caller user id>` and `credential` is base64(HMAC-SHA1(TURN_SECRET, username)).
         *     Valid for `ttl_seconds` (600). The server never returns `TURN_SECRET`. Not configured → `503`.
         *     Rate limit 30/hour per user (`429`).
         */
        post: operations["getTurnCredentials"];
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
        /**
         * Move the caller's read marker forward (never backwards). Idempotent.
         * @description When the marker of an `ACTIVE` member moves forward, chat-svc sends `chat.hint` `READ` (conversation, reader,
         *     new marker) to the other `ACTIVE` members, so their "đã xem" updates live. A `REQUESTED` member's marker is
         *     saved but never announced, and not returned in `Member.last_read_seq`, until they accept.
         */
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
    "/v1/chat/conversations/{conversation_id}/attachments": {
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
         * Reserve an attachment and get a presigned PUT URL for its ciphertext.
         * @description - The caller must be `ACTIVE` in the conversation (`REQUESTED` → `403 REQUEST_PENDING`, `LEFT` → `404`), and
         *       `sender_device_id` one of their active devices (`403 DEVICE_NOT_YOURS`).
         *     - Over 1 GiB of the caller's live attachments (`PENDING` + `UPLOADED`, not expired) → `409 ATTACHMENT_QUOTA`.
         *     - The URL accepts exactly one `PUT` of exactly `size_bytes` bytes with the returned `upload_headers`, for
         *       15 minutes. The object key is chosen by chat-svc and never reveals the file name.
         *     - An attachment not referenced by a message within 24 hours is deleted with its object.
         */
        post: operations["createAttachment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/chat/conversations/{conversation_id}/attachments/{attachment_id}/complete": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                conversation_id: components["parameters"]["ConversationId"];
                attachment_id: components["parameters"]["AttachmentId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Confirm the upload. Idempotent.
         * @description Only the uploader. chat-svc checks the object exists with exactly `size_bytes` bytes (HEAD) and sets
         *     `UPLOADED`. Missing or wrong size → `409 UPLOAD_INCOMPLETE` (a wrong-size object is deleted; reserve again).
         */
        post: operations["completeAttachment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/chat/conversations/{conversation_id}/attachments/{attachment_id}/download": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                conversation_id: components["parameters"]["ConversationId"];
                attachment_id: components["parameters"]["AttachmentId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Get a short-lived presigned GET URL for the ciphertext.
         * @description - The uploader may download their own attachment at any time before it expires.
         *     - Anyone else must be a member whose readable range (`joined_seq` through `last_seq`, or `left_seq`)
         *       includes the message that references it; otherwise `404`. Deleted message → `404`.
         *     - Expired → `410` code `ATTACHMENT_EXPIRED`. The URL is valid for 5 minutes.
         *     - `POST` so that the URL never lands in caches or browser history.
         */
        post: operations["downloadAttachment"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/chat/key-backup": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * The caller's key backup parameters.
         * @description No backup → `404`. Rate limit 30/hour per user.
         */
        get: operations["getKeyBackup"];
        /**
         * Create the key backup, or replace it (new passphrase, or reset after a forgotten one).
         * @description - No backup yet → creates version 1, `201`.
         *     - A backup exists → only with `replace: true` (else `409 BACKUP_EXISTS`): bumps `version`, replaces
         *       `auth_data` and **deletes every stored session** (the old backup key can no longer be unwrapped), `200`.
         *       Clients re-upload the sessions they hold.
         *     - Rate limit 10/day per user. A stolen session could replace or delete the backup but never read it.
         */
        put: operations["putKeyBackup"];
        post?: never;
        /** Delete the backup and all its sessions. Idempotent. */
        delete: operations["deleteKeyBackup"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/chat/key-backup/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Page through the backed-up session keys. */
        get: operations["listKeyBackupSessions"];
        /**
         * Upload or update up to 100 encrypted session keys.
         * @description - `version` must equal the current backup version (`409 BACKUP_VERSION_MISMATCH`); no backup → `404`.
         *     - Per `(conversation_id, session_id)`, the stored row is replaced only when the new
         *       `first_message_index` is lower or equal (a key that decrypts more history wins; equal → newer wins).
         *     - At most 50 000 sessions per backup (`409 BACKUP_FULL`). Rate limit 600 sessions/min per user.
         */
        put: operations["putKeyBackupSessions"];
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
            /**
             * Format: int64
             * @description The member's read marker (`markRead`), for "đã xem" (task B3). `null` for a `REQUESTED` member: a message
             *     request promises that the sender does not learn it was read until it is accepted. Sent by every 1.3.0
             *     server; a missing value means `null`.
             */
            last_read_seq?: number | null;
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
            /**
             * @description Attachments this message carries (their keys are inside `ciphertext`). Each must be `UPLOADED`, in this
             *     conversation, uploaded by the caller, not expired and not yet referenced by another message; otherwise
             *     `409 ATTACHMENT_UNAVAILABLE`. A retry with the same `client_msg_id` ignores this field.
             */
            attachment_ids?: components["schemas"]["Uuid"][];
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
            /**
             * @description Attachments referenced by this message; empty for `SYSTEM` and deleted messages. chat-svc sends it on
             *     every message from SOC-3b on; clients treat a missing field as empty.
             */
            attachments?: components["schemas"]["Attachment"][];
            /** Format: date-time */
            created_at: string;
        };
        CreateAttachmentRequest: {
            sender_device_id: components["schemas"]["Uuid"];
            /**
             * Format: int64
             * @description Exact ciphertext size in bytes (≤ 25 MiB).
             */
            size_bytes: number;
        };
        Attachment: {
            id: components["schemas"]["Uuid"];
            conversation_id: components["schemas"]["Uuid"];
            /** Format: int64 */
            size_bytes: number;
            /** @enum {string} */
            state: "PENDING" | "UPLOADED";
            /** Format: date-time */
            expires_at: string;
            /** Format: date-time */
            created_at: string;
        };
        AttachmentUpload: {
            attachment: components["schemas"]["Attachment"];
            /**
             * Format: uri
             * @description Presigned `PUT` URL. Never log it.
             */
            upload_url: string;
            /** @description Headers the PUT must send exactly: Content-Type application/octet-stream and Content-Length. */
            upload_headers: {
                [key: string]: string;
            };
            /** Format: date-time */
            upload_expires_at: string;
        };
        AttachmentDownload: {
            /**
             * Format: uri
             * @description Presigned `GET` URL, valid 5 minutes. Never log it.
             */
            url: string;
            /** Format: date-time */
            expires_at: string;
            /** Format: int64 */
            size_bytes: number;
        };
        /**
         * @description Opaque to chat-svc, ≤ 4 KiB serialized. The web client writes (all binary values unpadded base64):
         *     `{"kdf":"argon2id","salt":S,"m_kib":65536,"t":3,"p":1,"wrapped_key":W,"iv":IV,"key_check":C}`, where
         *     `wrapped_key` is the 32-byte backup key encrypted with AES-256-GCM under the Argon2id output and `key_check`
         *     lets the client tell a wrong passphrase from corrupt data. chat-svc only checks it is an object within size.
         */
        KeyBackupAuthData: {
            [key: string]: unknown;
        };
        KeyBackup: {
            /** Format: int64 */
            version: number;
            /** @enum {string} */
            algorithm: "winkey.backup.v1";
            auth_data: components["schemas"]["KeyBackupAuthData"];
            session_count: number;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            updated_at: string;
        };
        PutKeyBackupRequest: {
            /** @enum {string} */
            algorithm: "winkey.backup.v1";
            auth_data: components["schemas"]["KeyBackupAuthData"];
            /** @default false */
            replace: boolean;
        };
        TurnCredentials: {
            /** @description `turn:` / `turns:` URLs (and optionally `stun:`), passed to `RTCPeerConnection` `iceServers`. */
            urls: string[];
            username: string;
            /** @description Never log it. */
            credential: string;
            ttl_seconds: number;
            /** Format: date-time */
            expires_at: string;
        };
        BackedUpSession: {
            conversation_id: components["schemas"]["Uuid"];
            session_id: string;
            /** @description The first Megolm message index this exported key can decrypt. */
            first_message_index: number;
            /** @description The exported inbound session key, AES-256-GCM under the backup key, base64, ≤ 8 KiB decoded. */
            ciphertext: string;
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
        AttachmentId: components["schemas"]["Uuid"];
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
    getTurnCredentials: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Credentials. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TurnCredentials"];
                };
            };
            401: components["responses"]["Unauthorized"];
            429: components["responses"]["TooManyRequests"];
            /** @description TURN is not configured. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
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
    createAttachment: {
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
                "application/json": components["schemas"]["CreateAttachmentRequest"];
            };
        };
        responses: {
            /** @description Reserved. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AttachmentUpload"];
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
    completeAttachment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                conversation_id: components["parameters"]["ConversationId"];
                attachment_id: components["parameters"]["AttachmentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Uploaded. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Attachment"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    downloadAttachment: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                conversation_id: components["parameters"]["ConversationId"];
                attachment_id: components["parameters"]["AttachmentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Download URL. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AttachmentDownload"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            /** @description The attachment expired. */
            410: {
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
    getKeyBackup: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The backup. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["KeyBackup"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    putKeyBackup: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PutKeyBackupRequest"];
            };
        };
        responses: {
            /** @description Replaced. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["KeyBackup"];
                };
            };
            /** @description Created. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["KeyBackup"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    deleteKeyBackup: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
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
        };
    };
    listKeyBackupSessions: {
        parameters: {
            query: {
                /** @description Must equal the current backup version, else `409 BACKUP_VERSION_MISMATCH`. */
                version: number;
                conversation_id?: components["schemas"]["Uuid"];
                cursor?: string;
                limit?: number;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description One page, ordered by `(conversation_id, session_id)`. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        items: components["schemas"]["BackedUpSession"][];
                        next_cursor: string | null;
                    };
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    putKeyBackupSessions: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": {
                    /** Format: int64 */
                    version: number;
                    sessions: components["schemas"]["BackedUpSession"][];
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
                    "application/json": {
                        /** @description Sessions inserted or replaced. */
                        stored: number;
                        /** @description Sessions skipped because the stored key was better. */
                        kept: number;
                    };
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["TooManyRequests"];
        };
    };
}

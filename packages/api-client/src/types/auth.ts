export interface paths {
    "/v1/auth/register": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Create an account with email and password.
         * @description Also queues a `VERIFY_EMAIL` mail in the same transaction (task A6, see `resendEmailVerification`).
         *     An unverified email blocks nothing yet; the user sees a reminder in the web app.
         */
        post: operations["register"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Sign in with email and password. */
        post: operations["login"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/refresh": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Rotate the refresh cookie and issue a new access token.
         * @description Requires the `wk_rt` cookie. The server also rejects requests whose `Origin` is not the site origin.
         */
        post: operations["refresh"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/logout": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Revoke the current refresh family and clear the cookie. */
        post: operations["logout"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Current user. */
        get: operations["getMe"];
        put?: never;
        post?: never;
        /**
         * Delete your own account (task A3).
         * @description Confirmation: `confirm_handle` must equal your current handle (case-insensitive), and accounts with a
         *     password must also send the correct `password`; otherwise `400` (`CONFIRMATION_MISMATCH`) or `403`
         *     (`INVALID_CREDENTIALS`). Rate limited like `login` → `429`.
         *
         *     In one transaction: `status = DELETED`; `email` → `deleted+<id>@invalid.winkey.vn`; `handle` →
         *     `d_` + the first 28 hex digits of the id without dashes; `display_name` → `Deleted user`;
         *     `password_hash`, `email_verified_at`, `avatar_key` → NULL; every `oauth_identities` row and every
         *     refresh-token family of the user is removed / revoked. The email and handle become free for new
         *     accounts. The response clears `wk_rt`. Already-issued access tokens keep working until they expire
         *     (≤ 15 min), exactly as for suspension; every service already hides content of non-ACTIVE owners
         *     through `auth.public_profiles`. Admins cannot delete themselves while they are the last admin
         *     (`409` `LAST_ADMIN`).
         */
        delete: operations["deleteMe"];
        options?: never;
        head?: never;
        /**
         * Edit your own display name and/or handle (task A3).
         * @description At least one field. A handle that another account uses (case-insensitive) → `409` `HANDLE_TAKEN`.
         *     Sending the current value again is a no-op (`200`). Rate limited per user: 10 changes / hour → `429`.
         *     The new handle takes effect immediately in `auth.public_profiles`; old `/@handle` URLs stop resolving.
         */
        patch: operations["updateMe"];
        trace?: never;
    };
    "/v1/auth/me/password": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        /**
         * Set or change your password (task A3).
         * @description - Account with a password: `current_password` is required and must match, else `403`
         *       `INVALID_CREDENTIALS`.
         *     - OAuth-only account (`has_password = false`): `current_password` must be omitted; this sets a first
         *       password so the account can also sign in with email + password.
         *
         *     On success every refresh-token family of the user is revoked **except** the one in the request's
         *     `wk_rt` cookie (other devices are signed out; this one stays). Rate limited like `login` → `429`.
         */
        put: operations["changePassword"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/password/forgot": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Email a password-reset link (task A6, ADR-026).
         * @description Always answers `202` with an empty body, whether or not the email belongs to an account, so the
         *     endpoint cannot be used to find accounts. When the email belongs to an `ACTIVE` user, auth-svc stores
         *     a one-time token (SHA-256 only, valid 1 hour) and queues a `RESET_PASSWORD` mail with the link
         *     `{PUBLIC_ORIGIN}/{locale}/reset-password?token={token}`. Earlier unused reset tokens of that user
         *     stay valid until they expire or one of them is used. At most 3 reset mails per user per hour: extra
         *     requests still answer `202` and send nothing. Rate limited per IP like `login` → `429`.
         */
        post: operations["requestPasswordReset"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/password/reset": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Set a new password with a reset token (task A6, ADR-026).
         * @description The token must exist, be a `RESET_PASSWORD` token, be unused, not expired, belong to an `ACTIVE` user
         *     and have been sent to the user's current email; otherwise `400` with code `INVALID_TOKEN` (one code for
         *     every case). On success, in one transaction:
         *     - set the new password (also works for an OAuth-only account, which then gets a password);
         *     - mark this token and every other unused reset token of the user as used;
         *     - set `email_verified_at` if it was NULL (the user proved they read the mailbox);
         *     - revoke every refresh-token family of the user and record the revocation mark (ADR-019), so every
         *       device is signed out, including access tokens within seconds;
         *     - queue a `PASSWORD_CHANGED` mail (no link).
         *     Does not sign the caller in and sets no cookie. Rate limited per IP like `login` → `429`.
         */
        post: operations["resetPassword"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/email/verification": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Send the email-verification link again (task A6, ADR-026).
         * @description Queues a `VERIFY_EMAIL` mail for the caller's current email with a new token (valid 48 hours) and the
         *     link `{PUBLIC_ORIGIN}/{locale}/verify-email?token={token}`. `409` with code `EMAIL_ALREADY_VERIFIED`
         *     when `email_verified` is already true. At most 3 per user per hour, else `429`. `register` sends the
         *     first one automatically. Mail language for this call and for `register`: `Accept-Language` starting
         *     with `en` → English, anything else → Vietnamese.
         */
        post: operations["resendEmailVerification"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/email/verify": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Confirm an email address with a verification token (task A6, ADR-026).
         * @description No authentication: the link may be opened on another device. The token must be a `VERIFY_EMAIL` token,
         *     unused, not expired, of an `ACTIVE` user, and its email must still equal the user's current email;
         *     otherwise `400` with code `INVALID_TOKEN`. On success the token is marked used and `email_verified_at`
         *     is set (kept if already set). Using a token twice gives `400 INVALID_TOKEN`; the web page should then
         *     tell the user to sign in and check the settings page. Rate limited per IP like `login` → `429`.
         */
        post: operations["verifyEmail"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/oauth/google": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Start Google OAuth (authorization code + PKCE). */
        get: operations["googleStart"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/oauth/google/callback": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Google OAuth callback. Links or creates the account, sets `wk_rt`, redirects to `return_to`. */
        get: operations["googleCallback"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/verify": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Gateway forwardAuth endpoint. Not routed publicly.
         * @description - No `Authorization` header → `204` without identity headers (anonymous request).
         *     - Valid bearer token → `204` with `X-User-Id` and `X-User-Roles`.
         *     - Invalid or expired token → `401`.
         *
         *     Signature and claims are checked in memory, no database access. Task A4 (ADR-019): then ONE Valkey
         *     round trip checks the revocation keys; a token whose session (`sid`) was revoked, or whose `iat` is not
         *     after the user's revocation cutoff (suspension, role change, account deletion), → `401`. If Valkey does
         *     not answer within 50 ms the check is skipped (fail-open, counted in a metric).
         *     The gateway MUST strip client-supplied `X-User-Id` / `X-User-Roles` before calling upstreams.
         */
        get: operations["verify"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/.well-known/jwks.json": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Public signing keys (JWKS). Keep the previous key published for at least 24h after rotation. */
        get: operations["jwks"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/users/{handle}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Public profile (channel header). */
        get: operations["getUserByHandle"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/users": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Search users (moderator or admin). Newest first. */
        get: operations["adminListUsers"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/users/{user_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: components["parameters"]["UserId"];
            };
            cookie?: never;
        };
        /** One user with moderation details (moderator or admin). */
        get: operations["adminGetUser"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/users/{user_id}/roles": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: components["parameters"]["UserId"];
            };
            cookie?: never;
        };
        get?: never;
        /**
         * Replace a user's roles (admin only). Audited as `USER_ROLES_CHANGED`.
         * @description The set must contain `viewer`. Setting the same roles again is a no-op (`200`, no audit row).
         *     Changing your own roles → `403` `CANNOT_MODERATE_TARGET`. An admin may change another admin's
         *     roles. A `DELETED` user → `409`; removing `admin` from the last non-deleted admin → `409`
         *     `LAST_ADMIN`.
         */
        put: operations["adminSetUserRoles"];
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/users/{user_id}/suspension": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: components["parameters"]["UserId"];
            };
            cookie?: never;
        };
        get?: never;
        /**
         * Suspend a user, or change an existing suspension. Audited as `USER_SUSPENDED`.
         * @description Sets `status = SUSPENDED`, stores `reason` and `until` (omitted or null = indefinite) and revokes
         *     every refresh-token family of the user (so `refresh` answers `401`). While suspended, `login`
         *     answers `403` with code `ACCOUNT_SUSPENDED` (the problem `detail` may include `until`, never the
         *     internal reason) and the Google callback redirects to `/login?error=ACCOUNT_SUSPENDED` without
         *     setting `wk_rt`. `verify` keeps accepting already-issued access tokens until they expire
         *     (≤ 15 min). A `DELETED` user → `409`.
         */
        put: operations["adminSuspendUser"];
        post?: never;
        /**
         * Lift a suspension. Audited as `USER_UNSUSPENDED`. Idempotent.
         * @description An `ACTIVE` user → `200` without an audit row. A `DELETED` user → `409`.
         */
        delete: operations["adminUnsuspendUser"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/audit-log": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Admin actions, newest first (admin only). */
        get: operations["adminListAuditLog"];
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
        RegisterRequest: {
            /** Format: email */
            email: string;
            password: string;
            handle: string;
            display_name: string;
        };
        LoginRequest: {
            /** Format: email */
            email: string;
            password: string;
        };
        User: {
            id: components["schemas"]["Uuid"];
            /** Format: email */
            email: string;
            email_verified: boolean;
            handle: string;
            display_name: string;
            /** Format: uri */
            avatar_url: string | null;
            roles: components["schemas"]["Role"][];
            /**
             * @description Whether the account can sign in with email + password. Returned by `getMe` and `updateMe`
             *     (task A3) so the settings page knows whether `changePassword` and `deleteMe` need the current
             *     password.
             */
            has_password?: boolean;
            /** Format: date-time */
            created_at: string;
        };
        UpdateMeRequest: {
            display_name?: string;
            handle?: string;
        };
        ChangePasswordRequest: {
            current_password?: string;
            new_password: string;
        };
        PasswordResetRequest: {
            /** Format: email */
            email: string;
            /**
             * @description Language of the mail and of the link.
             * @default vi
             * @enum {string}
             */
            locale: "vi" | "en";
        };
        ResetPasswordRequest: {
            /** @description The value of `token` in the link (256-bit random value, base64url without padding). */
            token: string;
            new_password: string;
        };
        VerifyEmailRequest: {
            token: string;
        };
        DeleteMeRequest: {
            confirm_handle: string;
            /** @description Required when the account has a password. */
            password?: string;
        };
        TokenResponse: {
            access_token: string;
            /** @constant */
            token_type: "Bearer";
            /**
             * @description Seconds until the access token expires.
             * @example 900
             */
            expires_in: number;
            user: components["schemas"]["User"];
        };
        /** @enum {string} */
        UserStatus: "ACTIVE" | "SUSPENDED" | "DELETED";
        AdminUser: {
            id: components["schemas"]["Uuid"];
            /** Format: email */
            email: string;
            email_verified: boolean;
            handle: string;
            display_name: string;
            /** Format: uri */
            avatar_url: string | null;
            roles: components["schemas"]["Role"][];
            status: components["schemas"]["UserStatus"];
            /**
             * Format: date-time
             * @description Null when not suspended or suspended indefinitely.
             */
            suspended_until: string | null;
            /** @description Internal note, shown only to moderators and admins. */
            suspension_reason: string | null;
            /** Format: date-time */
            created_at: string;
        };
        AdminUserPage: {
            items: components["schemas"]["AdminUser"][];
            next_cursor: string | null;
        };
        SetRolesRequest: {
            roles: components["schemas"]["Role"][];
        };
        SuspendUserRequest: {
            reason: string;
            /**
             * Format: date-time
             * @description Must be in the future; omitted or null = indefinite.
             */
            until?: string | null;
        };
        AuditEntry: {
            id: components["schemas"]["Uuid"];
            actor: components["schemas"]["PublicProfile"];
            /** @enum {string} */
            action: "USER_ROLES_CHANGED" | "USER_SUSPENDED" | "USER_UNSUSPENDED";
            target_user_id: components["schemas"]["Uuid"];
            /** @description `{from, to}` for roles; `{reason, until}` for suspensions. */
            details: {
                [key: string]: unknown;
            };
            /** Format: date-time */
            created_at: string;
        };
        AuditEntryPage: {
            items: components["schemas"]["AuditEntry"][];
            next_cursor: string | null;
        };
        /**
         * Format: uuid
         * @description UUIDv7 generated by the owning service.
         * @example 0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c0d
         */
        Uuid: string;
        /** @enum {string} */
        Role: "viewer" | "creator" | "moderator" | "admin";
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
        /** @description Resource does not exist or is not visible to the caller. */
        NotFound: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
    };
    parameters: {
        UserId: components["schemas"]["Uuid"];
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
    register: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RegisterRequest"];
            };
        };
        responses: {
            /** @description Account created and signed in. Sets the `wk_rt` cookie. */
            201: {
                headers: {
                    "Set-Cookie"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TokenResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    login: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["LoginRequest"];
            };
        };
        responses: {
            /** @description Signed in. Sets the `wk_rt` cookie. */
            200: {
                headers: {
                    "Set-Cookie"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TokenResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            /**
             * @description Correct credentials but the account is suspended (code `ACCOUNT_SUSPENDED`, task A2). Checked
             *     only after the password verifies, so it does not reveal whether an email exists.
             */
            403: {
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
    refresh: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description New access token; `wk_rt` rotated. */
            200: {
                headers: {
                    "Set-Cookie"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TokenResponse"];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    logout: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Signed out. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    getMe: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The signed-in user. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["User"];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    deleteMe: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["DeleteMeRequest"];
            };
        };
        responses: {
            /** @description Account deleted; `wk_rt` cleared. */
            204: {
                headers: {
                    "Set-Cookie"?: string;
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    updateMe: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["UpdateMeRequest"];
            };
        };
        responses: {
            /** @description The user after the change. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["User"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    changePassword: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ChangePasswordRequest"];
            };
        };
        responses: {
            /** @description Password changed. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    requestPasswordReset: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PasswordResetRequest"];
            };
        };
        responses: {
            /** @description Accepted. A mail is sent only if the account exists and is active. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    resetPassword: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["ResetPasswordRequest"];
            };
        };
        responses: {
            /** @description Password changed; sign in again. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    resendEmailVerification: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Mail queued. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            409: components["responses"]["Conflict"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    verifyEmail: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["VerifyEmailRequest"];
            };
        };
        responses: {
            /** @description Email verified. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    googleStart: {
        parameters: {
            query?: {
                /** @description Relative path to return to after sign-in. Absolute URLs are rejected. */
                return_to?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Redirect to Google. */
            302: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
        };
    };
    googleCallback: {
        parameters: {
            query: {
                code: string;
                state: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Redirect back to the web app. The web app then calls `/v1/auth/refresh` to get an access token. */
            302: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
        };
    };
    verify: {
        parameters: {
            query?: never;
            header?: {
                Authorization?: string;
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Request may proceed. */
            204: {
                headers: {
                    /** @description Present only for authenticated requests. */
                    "X-User-Id"?: string;
                    /** @description Comma-separated roles, e.g. `viewer,creator`. Present only for authenticated requests. */
                    "X-User-Roles"?: string;
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    jwks: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description JSON Web Key Set. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        keys: {
                            [key: string]: unknown;
                        }[];
                    };
                };
            };
            404: components["responses"]["NotFound"];
        };
    };
    getUserByHandle: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                handle: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Public profile. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PublicProfile"];
                };
            };
            404: components["responses"]["NotFound"];
        };
    };
    adminListUsers: {
        parameters: {
            query?: {
                /** @description Case-insensitive match on email or handle prefix, or on display name (trigram). */
                q?: string;
                role?: components["schemas"]["Role"];
                status?: components["schemas"]["UserStatus"];
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
            /** @description One page of users. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminUserPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
        };
    };
    adminGetUser: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: components["parameters"]["UserId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The user. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminUser"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    adminSetUserRoles: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: components["parameters"]["UserId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SetRolesRequest"];
            };
        };
        responses: {
            /** @description The user after the change. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminUser"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    adminSuspendUser: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: components["parameters"]["UserId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["SuspendUserRequest"];
            };
        };
        responses: {
            /** @description The user after the change. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminUser"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    adminUnsuspendUser: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                user_id: components["parameters"]["UserId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The user after the change. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminUser"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    adminListAuditLog: {
        parameters: {
            query?: {
                target_user_id?: components["schemas"]["Uuid"];
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
            /** @description One page of audit entries. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AuditEntryPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
        };
    };
}

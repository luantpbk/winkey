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
        /** Create an account with email and password. */
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
         *     Stateless: signature and claims are checked in memory, no database access.
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
            /** Format: date-time */
            created_at: string;
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
        /** @description Resource does not exist or is not visible to the caller. */
        NotFound: {
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

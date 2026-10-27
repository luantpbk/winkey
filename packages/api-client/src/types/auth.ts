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
         *
         *     Closed beta (task BETA1, ADR-034): when auth-svc runs with `REGISTRATION_MODE=invite`, a new account
         *     needs a valid `invite_code`. Missing → `403` code `INVITE_REQUIRED`; not one of the configured codes →
         *     `403` code `INVITE_INVALID`. Both are checked before any other conflict, so the response never reveals
         *     whether an email or handle exists. With `REGISTRATION_MODE=open` (default) `invite_code` is accepted
         *     and ignored. Existing accounts sign in normally in both modes.
         *
         *     Roles (task ROLE1, ADR-046): a new account — password or Google — gets `roles = [viewer]` only. Uploading and
         *     managing videos need `creator`, granted by an admin through `createCreatorRequest` /
         *     `adminDecideCreatorRequest` or `adminSetUserRoles`.
         *     Local dev and test stacks (compose, systest, CI simulation) may run auth-svc with
         *     `SIGNUP_ROLES=viewer,creator` so their seed accounts can upload; production never sets it (default `viewer`).
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
        /**
         * Sign in with email and password.
         * @description When the account has a second factor (SOC-1a) the response is an `MfaChallenge`: no cookie is set and the
         *     client calls `completeMfaLogin` with its `mfa_token`. Otherwise it is a `TokenResponse` and `wk_rt` is set.
         */
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
         * Edit your own profile (tasks A3, SOC-1b).
         * @description At least one field. A handle that another account uses (case-insensitive) → `409` `HANDLE_TAKEN`.
         *     Sending the current value again is a no-op (`200`). Rate limited per user: 10 changes / hour → `429`.
         *     The new handle takes effect immediately in `auth.public_profiles`; old `/@handle` URLs stop resolving.
         *
         *     Profile fields (SOC-1b, ADR-049):
         *     - `bio`: trimmed; empty string or `null` clears it. Rendered as plain text only.
         *     - `links`: replaces the whole list (≤ 5). Each `url` must be `https://`, ≤ 200 chars, without credentials
         *       (`user:pass@`); otherwise `400` code `LINK_INVALID`. Labels are trimmed.
         *     - `avatar_image_id` / `banner_image_id`: an image from `media.ready_images` owned by the caller with purpose
         *       `AVATAR` / `BANNER` (upload-svc `createImageUpload`); otherwise `400` code `IMAGE_INVALID`. auth-svc copies
         *       its `image_key` into `avatar_key` / `banner_key`. `null` removes the avatar / banner.
         *     - `is_private`: see social-svc `subscribe` for what a private account changes. Turning it off does not
         *       approve pending follow requests; they stay until the owner decides.
         */
        patch: operations["updateMe"];
        trace?: never;
    };
    "/v1/auth/me/creator-request": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Your latest creator-upgrade request (task ROLE1, ADR-046).
         * @description The most recent request of the signed-in user, whatever its status. None yet → `404`. The web client
         *     polls this on the upgrade page; when it turns `APPROVED` while the access token still lacks `creator`,
         *     it calls `refresh` once to get a token with the new role (approval never revokes sessions).
         */
        get: operations["getMyCreatorRequest"];
        put?: never;
        /**
         * Ask an admin to grant the `creator` role (task ROLE1, ADR-046).
         * @description Creates a `PENDING` request. Conflicts (`409`), checked in this order:
         *     - the user already has `creator` → `ALREADY_CREATOR`;
         *     - the user already has a `PENDING` request → `REQUEST_PENDING`;
         *     - the latest request was `REJECTED` less than 24 h ago → `REQUEST_COOLDOWN` (the problem `detail`
         *       says when a new request is possible).
         *     Rate limited per user: 5 requests / day → `429`. Logs carry the request id and user id, never `message`.
         */
        post: operations["createCreatorRequest"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
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
    "/v1/auth/login/mfa": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Finish a sign-in that needs a second factor (task SOC-1a).
         * @description The `mfa_token` comes from `login` (body) or from the `wk_mfa` cookie set by the Google callback; the body
         *     value wins when both are present. A token lives 5 minutes and allows 5 attempts; after that, or once used,
         *     → `401` code `MFA_TOKEN_INVALID` and the user signs in again. A wrong code → `401` code `MFA_CODE_INVALID`
         *     (and a `MFA_FAILED` security event). A TOTP code is accepted once (`users.totp_last_step`). A recovery code
         *     is spent on use (`RECOVERY_CODE_USED` event; the response's `user` shows how many remain through
         *     `getMySecurity`). For `method = passkey`, `flow_id` comes from `passkeyAssertionOptions` with
         *     `purpose = mfa`. On success: the session gets `amr = [pwd|google, otp|rcode|passkey]`, `wk_rt` is set and
         *     `wk_mfa` cleared.
         */
        post: operations["completeMfaLogin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/passkeys/assertion-options": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * WebAuthn request options for signing in, finishing a sign-in, or re-authenticating (task SOC-1a).
         * @description - `purpose = login`: no authentication; `allowCredentials` is empty (discoverable credentials only), so the
         *       response never reveals whether an account exists.
         *     - `purpose = mfa`: needs `mfa_token` (body or `wk_mfa` cookie); `allowCredentials` lists that user's passkeys.
         *     - `purpose = step_up`: needs a bearer token; `allowCredentials` lists the caller's passkeys.
         *
         *     `userVerification = required`, `rpId = WEBAUTHN_RP_ID` (production `winkey.vn`), timeout 120 s. The
         *     challenge is single-use and lives 2 minutes (Valkey), bound to `flow_id` and the purpose.
         */
        post: operations["passkeyAssertionOptions"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/passkeys/login": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Sign in with a passkey (task SOC-1a).
         * @description `flow_id` from `passkeyAssertionOptions` (`purpose = login`). The credential must belong to an ACTIVE
         *     account and pass WebAuthn verification (origin, rpIdHash, user verification flag, signature, sign counter:
         *     a counter that goes backwards is rejected and logged). Any failure → `401` code `INVALID_CREDENTIALS`.
         *     A suspended account → `403` `ACCOUNT_SUSPENDED` after verification. A passkey is both factors: the session
         *     gets `amr = [passkey]` and staff roles are kept.
         */
        post: operations["passkeyLogin"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/me/step-up": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Re-authenticate the current session for 10 minutes (task SOC-1a).
         * @description Methods: `password` (accounts with a password), `totp`, `passkey` (`flow_id` from
         *     `passkeyAssertionOptions` with `purpose = step_up`) or `email_code` (6 digits sent by
         *     `sendStepUpEmailCode`; for accounts with neither a password nor a second factor, e.g. Google-only).
         *     Recovery codes are not accepted here. A method the account does not have → `400` code `METHOD_UNAVAILABLE`;
         *     a wrong secret → `403` code `INVALID_CREDENTIALS`. Rate limited like `login`. Sets
         *     `auth.sessions.step_up_at` for the caller's `sid` and writes a `STEP_UP` security event.
         */
        post: operations["stepUp"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/me/step-up/email-code": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Email a 6-digit re-authentication code (task SOC-1a).
         * @description Queues a mail with a 6-digit code valid 10 minutes, bound to the caller's session (only its hash is kept,
         *     in Valkey). Issuing a new code invalidates the previous one. At most 3 per session per 10 minutes → `429`.
         */
        post: operations["sendStepUpEmailCode"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/me/security": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Second factors and step-up state of the signed-in user (task SOC-1a). */
        get: operations["getMySecurity"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/me/totp": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Start enabling TOTP — returns a new secret (task SOC-1a). Needs step-up.
         * @description Generates a 160-bit secret, kept encrypted in Valkey for 10 minutes under `setup_id` until
         *     `confirmTotpSetup`. TOTP already enabled → `409` code `TOTP_ALREADY_ENABLED`. The secret is shown once;
         *     it is never returned again.
         */
        post: operations["startTotpSetup"];
        /**
         * Turn TOTP off (task SOC-1a). Needs step-up.
         * @description Removes the secret. When the account then has no passkey either, its recovery codes are deleted,
         *     `mfa_enabled` becomes false and every session except the caller's is revoked (`MFA_DISABLED`).
         *     TOTP not enabled → `404`. Writes `TOTP_DISABLED`.
         */
        delete: operations["disableTotp"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/me/totp/confirm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Finish enabling TOTP with a first code (task SOC-1a).
         * @description `setup_id` unknown or expired → `404`. Wrong code → `400` code `MFA_CODE_INVALID` (5 tries per setup).
         *     On success the encrypted secret is stored in `auth.users`, and when the account had no recovery codes yet
         *     10 new ones are generated and returned once. Writes `TOTP_ENABLED` (and `RECOVERY_CODES_GENERATED`).
         */
        post: operations["confirmTotpSetup"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/me/recovery-codes": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Replace all recovery codes with 10 new ones (task SOC-1a). Needs step-up.
         * @description Only for accounts with `mfa_enabled` (otherwise `409` code `MFA_NOT_ENABLED`). Old codes stop working
         *     immediately. Codes are 10 characters from `[a-z2-9]` shown as `xxxxx-xxxxx`; matching ignores case, spaces
         *     and dashes. Writes `RECOVERY_CODES_GENERATED`.
         */
        post: operations["regenerateRecoveryCodes"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/me/passkeys": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Passkeys of the signed-in user (task SOC-1a). */
        get: operations["listMyPasskeys"];
        put?: never;
        /**
         * Register a passkey (task SOC-1a). Needs step-up.
         * @description `flow_id` from `passkeyRegistrationOptions`. Attestation `none` is accepted (no attestation required);
         *     user verification must be set. 10 passkeys already → `409` code `PASSKEY_LIMIT`; a credential id already
         *     registered (any account) → `409` code `PASSKEY_EXISTS`. The first passkey of an account without TOTP also
         *     generates 10 recovery codes (returned in `recovery_codes`, else null). Writes `PASSKEY_ADDED`.
         */
        post: operations["addPasskey"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/me/passkeys/registration-options": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * WebAuthn creation options for a new passkey (task SOC-1a). Needs step-up.
         * @description `residentKey = required`, `userVerification = required`, `attestation = none`, `excludeCredentials` = the
         *     caller's passkeys, `user.id` (the WebAuthn user handle) = HMAC-SHA256(WEBAUTHN_USER_HANDLE_KEY, user id), never the
         *     user id itself, `user.name` = handle.
         *     The challenge is single-use and lives 2 minutes.
         */
        post: operations["passkeyRegistrationOptions"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/me/passkeys/{passkey_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                passkey_id: components["schemas"]["Uuid"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Remove a passkey (task SOC-1a). Needs step-up.
         * @description Not the caller's → `404`. Removing the last second factor (no TOTP, no other passkey) behaves like
         *     `disableTotp`: recovery codes deleted, other sessions revoked. Writes `PASSKEY_REMOVED`.
         */
        delete: operations["deletePasskey"];
        options?: never;
        head?: never;
        /** Rename a passkey (task SOC-1a). */
        patch: operations["renamePasskey"];
        trace?: never;
    };
    "/v1/auth/me/sessions": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Active sessions (signed-in devices) of the user (task SOC-1a).
         * @description Non-revoked, non-expired sessions, most recently used first, at most 50. `current` marks the caller's `sid`.
         */
        get: operations["listMySessions"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/me/sessions/{session_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_id: components["schemas"]["Uuid"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * Sign out one device (task SOC-1a).
         * @description Revokes the session and its refresh family (`USER_REVOKED`). Not the caller's or already revoked → `404`.
         *     Revoking the caller's own session works like `logout` and clears `wk_rt`. Its access tokens keep working
         *     until they expire (≤ 15 min), as for every revocation. Writes `SESSION_REVOKED`.
         */
        delete: operations["revokeMySession"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/me/sessions/revoke-others": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Sign out every other device (task SOC-1a).
         * @description Revokes every session of the user except the caller's (`REVOKE_OTHERS`). Writes `OTHER_SESSIONS_REVOKED`.
         */
        post: operations["revokeOtherSessions"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/sessions/report": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * "This wasn't me" from a new-sign-in mail: revoke that session (task SOC-1a).
         * @description A `NEW_SIGN_IN` mail is queued when a sign-in comes from a device the account has not used before (no
         *     session of the user with the same `ip_hash` and device label in the last 90 days). It carries a
         *     `SESSION_REPORT` email token (single use, 7 days) bound to that session. Using it revokes the session
         *     (`REPORTED`), writes `SESSION_REPORTED`, and the web app then suggests changing the password and enabling
         *     2FA. Unknown, used or expired token → `400` code `TOKEN_INVALID`. No authentication: the token is the proof.
         */
        post: operations["reportSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/auth/me/security-events": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Security log of the signed-in user, newest first (task SOC-1a).
         * @description Kept 1 year. Never contains secrets, codes or IP addresses.
         */
        get: operations["listMySecurityEvents"];
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
        /**
         * Google OAuth callback. Links or creates the account, sets `wk_rt`, redirects to `return_to`.
         * @description Second factor (SOC-1a): when the account has `mfa_enabled`, `wk_rt` is NOT set. auth-svc sets cookie
         *     `wk_mfa` (the `mfa_token`; `HttpOnly; Secure; SameSite=Lax; Path=/v1/auth/login; Max-Age=300`) and redirects
         *     to `/login/2fa?return_to=<return_to>`, where the web app calls `completeMfaLogin` without `mfa_token` in the
         *     body. The token never appears in a URL.
         *
         *     With `REGISTRATION_MODE=invite` (ADR-034), creating a NEW account needs the `invite_code` given to
         *     `googleStart`. Missing → redirect to `/register?error=INVITE_REQUIRED`; invalid → redirect to
         *     `/register?error=INVITE_INVALID`. In both cases no user is created and `wk_rt` is not set. Linking to an
         *     existing account (same verified email) and signing in an already linked account never need a code.
         */
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
        /**
         * Public profile (channel header).
         * @description SOC-1b: also returns the profile fields. Follower counts, the caller's relationship and blocks come from
         *     social-svc (`getSubscription`, `getRelationship`). A private account's profile header is still public.
         */
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
    "/v1/admin/creator-requests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Creator-upgrade requests (admin only, task ROLE1, ADR-046).
         * @description `status=PENDING` (default) is the review queue, oldest first. `APPROVED` / `REJECTED` list decided
         *     requests, most recently decided first. `pending_count` is the total number of `PENDING` requests
         *     whatever `status` is asked for (the admin tab badge). Moderators get `403`.
         */
        get: operations["adminListCreatorRequests"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/admin/creator-requests/{request_id}/decision": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                request_id: components["schemas"]["Uuid"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Approve or reject a creator-upgrade request (admin only, task ROLE1, ADR-046).
         * @description Only a `PENDING` request can be decided; otherwise `409` `REQUEST_ALREADY_DECIDED` (two admins racing:
         *     exactly one wins). `REJECT` needs a `note` (shown to the user); `APPROVE` may have one.
         *
         *     `APPROVE`, in one transaction: the request becomes `APPROVED`; `creator` is added to the user's roles
         *     (kept if already there); one `auth.audit_log` row `USER_ROLES_CHANGED` with details
         *     `{from, to, creator_request_id}` is written when the roles actually change. Approval does **not**
         *     revoke sessions: adding a role is safe to reach other services on the next refresh (≤ 15 min), and the
         *     web client refreshes at once when it sees the approval. The user is not `ACTIVE` (suspended or
         *     deleted) → `409` `USER_NOT_ACTIVE`, nothing changes.
         *
         *     `REJECT`: the request becomes `REJECTED` with the note; roles are untouched; no audit row (the request
         *     row itself records who decided and when). Deciding your own request → `403` `CANNOT_MODERATE_TARGET`.
         */
        post: operations["adminDecideCreatorRequest"];
        delete?: never;
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
            /** @description Closed-beta invite (ADR-034). Required only when auth-svc runs with `REGISTRATION_MODE=invite`. */
            invite_code?: string;
            turnstile_token?: components["schemas"]["TurnstileToken"];
        };
        LoginRequest: {
            /** Format: email */
            email: string;
            password: string;
            turnstile_token?: components["schemas"]["TurnstileToken"];
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
            /** @description The account has TOTP or at least one passkey (task SOC-1a). */
            mfa_enabled?: boolean;
            /** @description SOC-1b. */
            bio?: string | null;
            links?: components["schemas"]["ProfileLink"][];
            /** Format: uri */
            banner_url?: string | null;
            is_private?: boolean;
            /**
             * @description Roles the account holds but that are left out of its access tokens until it enables a second factor
             *     (`STAFF_MFA_REQUIRED`, SOC-1a). Empty for most users. `roles` lists only the effective roles.
             */
            staff_roles_pending_mfa?: components["schemas"]["Role"][];
            /** Format: date-time */
            created_at: string;
        };
        UpdateMeRequest: {
            display_name?: string;
            handle?: string;
            bio?: string | null;
            links?: components["schemas"]["ProfileLink"][];
            avatar_image_id?: components["schemas"]["Uuid"] | null;
            banner_image_id?: components["schemas"]["Uuid"] | null;
            is_private?: boolean;
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
        /** @enum {string} */
        CreatorRequestStatus: "PENDING" | "APPROVED" | "REJECTED";
        CreateCreatorRequestRequest: {
            /** @description What the user wants to publish (shown to admins only). Trimmed before the length check. */
            message: string;
        };
        CreatorRequest: {
            id: components["schemas"]["Uuid"];
            status: components["schemas"]["CreatorRequestStatus"];
            message: string;
            /** @description The admin's note; always present on `REJECTED`. */
            decision_note: string | null;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            decided_at: string | null;
        };
        AdminCreatorRequest: components["schemas"]["CreatorRequest"] & {
            user: components["schemas"]["AdminUser"];
            decided_by: components["schemas"]["PublicProfile"] | null;
        };
        AdminCreatorRequestPage: {
            items: components["schemas"]["AdminCreatorRequest"][];
            next_cursor: string | null;
            pending_count: number;
        };
        CreatorRequestDecision: {
            /** @enum {string} */
            decision: "APPROVE" | "REJECT";
            /** @description Required for `REJECT`; trimmed. */
            note?: string;
        };
        AuditEntryPage: {
            items: components["schemas"]["AuditEntry"][];
            next_cursor: string | null;
        };
        /** @description Cloudflare Turnstile response token (SOC-1a). See the captcha rules in the API description. */
        TurnstileToken: string;
        /** @enum {string} */
        MfaMethod: "totp" | "recovery_code" | "passkey";
        MfaChallenge: {
            /** @constant */
            mfa_required: true;
            /** @description Opaque, single-use, 5 minutes, 5 attempts. Send it to `completeMfaLogin`. */
            mfa_token: string;
            /** @description Second factors the account has; `recovery_code` is present whenever unused codes remain. */
            methods: components["schemas"]["MfaMethod"][];
            /** @example 300 */
            expires_in: number;
        };
        /**
         * @description The JSON form of a `PublicKeyCredential` (`credential.toJSON()`, WebAuthn Level 3): base64url fields. auth-svc
         *     validates it with a maintained WebAuthn library, never by hand.
         */
        WebAuthnCredential: {
            id: string;
            rawId: string;
            /** @constant */
            type: "public-key";
            response: Record<string, never>;
            authenticatorAttachment?: string | null;
            clientExtensionResults?: Record<string, never>;
        };
        MfaLoginRequest: {
            /** @description From `login`. Omit when the `wk_mfa` cookie carries it (Google sign-in). */
            mfa_token?: string;
            method: components["schemas"]["MfaMethod"];
            /** @description The 6-digit TOTP code, or a recovery code. Required unless `method = passkey`. */
            code?: string;
            /** @description Required when `method = passkey`. */
            flow_id?: string;
            credential?: components["schemas"]["WebAuthnCredential"];
        };
        PasskeyAssertionOptionsRequest: {
            /** @enum {string} */
            purpose: "login" | "mfa" | "step_up";
            /** @description For `purpose = mfa` when the `wk_mfa` cookie is not used. */
            mfa_token?: string;
        };
        PasskeyOptions: {
            flow_id: string;
            /**
             * @description `PublicKeyCredentialRequestOptionsJSON` (assertion) or `PublicKeyCredentialCreationOptionsJSON`
             *     (registration), base64url encoded, ready for `PublicKeyCredential.parse*OptionsFromJSON()`.
             */
            public_key: Record<string, never>;
        };
        PasskeyAssertionRequest: {
            flow_id: string;
            credential: components["schemas"]["WebAuthnCredential"];
        };
        StepUpRequest: {
            /** @enum {string} */
            method: "password" | "totp" | "passkey" | "email_code";
            password?: string;
            /** @description TOTP or email code. */
            code?: string;
            flow_id?: string;
            credential?: components["schemas"]["WebAuthnCredential"];
        };
        StepUpResult: {
            /** Format: date-time */
            step_up_until: string;
        };
        SecuritySummary: {
            mfa_enabled: boolean;
            totp_enabled: boolean;
            passkey_count: number;
            recovery_codes_remaining: number;
            has_password: boolean;
            /**
             * Format: date-time
             * @description When the current session's step-up expires; null when not stepped up.
             */
            step_up_until: string | null;
            staff_roles_pending_mfa: components["schemas"]["Role"][];
        };
        TotpSetup: {
            setup_id: string;
            /** @description Base32, no padding. */
            secret: string;
            /** @description `otpauth://totp/Winkey:<handle>?secret=…&issuer=Winkey&algorithm=SHA1&digits=6&period=30` */
            otpauth_uri: string;
            /** Format: date-time */
            expires_at: string;
        };
        TotpConfirmRequest: {
            setup_id: string;
            code: string;
        };
        RecoveryCodes: {
            recovery_codes: string[];
        };
        TotpConfirmResult: {
            /** @description 10 new codes when the account had none; null when it already had codes (from a passkey). */
            recovery_codes: string[] | null;
        };
        Passkey: {
            id: components["schemas"]["Uuid"];
            name: string;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            last_used_at: string | null;
            /** @description Synced passkey (backup state flag), e.g. iCloud Keychain or Google Password Manager. */
            backed_up: boolean;
        };
        PasskeyList: {
            items: components["schemas"]["Passkey"][];
        };
        AddPasskeyRequest: {
            flow_id: string;
            credential: components["schemas"]["WebAuthnCredential"];
            name: string;
        };
        AddPasskeyResult: {
            passkey: components["schemas"]["Passkey"];
            recovery_codes: string[] | null;
        };
        RenamePasskeyRequest: {
            name: string;
        };
        Session: {
            id: components["schemas"]["Uuid"];
            current: boolean;
            device_label: string | null;
            country: string | null;
            /** Format: date-time */
            created_at: string;
            /** Format: date-time */
            last_used_at: string;
            /** @description How the session signed in (`amr`). */
            methods: ("pwd" | "otp" | "rcode" | "passkey" | "google" | "email")[];
        };
        SessionList: {
            items: components["schemas"]["Session"][];
        };
        /** @enum {string} */
        SecurityEventKind: "SIGN_IN" | "SIGN_IN_NEW_DEVICE" | "MFA_FAILED" | "TOTP_ENABLED" | "TOTP_DISABLED" | "RECOVERY_CODES_GENERATED" | "RECOVERY_CODE_USED" | "PASSKEY_ADDED" | "PASSKEY_REMOVED" | "SESSION_REVOKED" | "OTHER_SESSIONS_REVOKED" | "SESSION_REPORTED" | "PASSWORD_CHANGED" | "PASSWORD_RESET" | "STEP_UP";
        SecurityEvent: {
            id: components["schemas"]["Uuid"];
            kind: components["schemas"]["SecurityEventKind"];
            session_id: components["schemas"]["Uuid"] | null;
            device_label: string | null;
            country: string | null;
            /** @description Kind-specific, e.g. `{"passkey_name":"iPhone"}`, `{"revoked":3}`. */
            details: Record<string, never>;
            /** Format: date-time */
            created_at: string;
        };
        SecurityEventPage: {
            items: components["schemas"]["SecurityEvent"][];
            next_cursor: string | null;
        };
        ProfileLink: {
            /** Format: uri */
            url: string;
            label: string;
        };
        /** @description A public profile with the SOC-1b fields (`getUserByHandle`). */
        UserProfile: components["schemas"]["PublicProfile"] & {
            bio?: string | null;
            links?: components["schemas"]["ProfileLink"][];
            /** Format: uri */
            banner_url?: string | null;
            is_private?: boolean;
            /** Format: date-time */
            created_at?: string;
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
            403: components["responses"]["Forbidden"];
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
            /** @description Signed in (sets `wk_rt`), or a second factor is needed (no cookie). */
            200: {
                headers: {
                    "Set-Cookie"?: string;
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TokenResponse"] | components["schemas"]["MfaChallenge"];
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
    getMyCreatorRequest: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The latest request. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreatorRequest"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    createCreatorRequest: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateCreatorRequestRequest"];
            };
        };
        responses: {
            /** @description The new request. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreatorRequest"];
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
    completeMfaLogin: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["MfaLoginRequest"];
            };
        };
        responses: {
            /** @description Signed in. Sets `wk_rt`, clears `wk_mfa`. */
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
            403: components["responses"]["Forbidden"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    passkeyAssertionOptions: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PasskeyAssertionOptionsRequest"];
            };
        };
        responses: {
            /** @description Options for `navigator.credentials.get()`. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PasskeyOptions"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    passkeyLogin: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PasskeyAssertionRequest"];
            };
        };
        responses: {
            /** @description Signed in. Sets `wk_rt`. */
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
            403: components["responses"]["Forbidden"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    stepUp: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["StepUpRequest"];
            };
        };
        responses: {
            /** @description The session is re-authenticated. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["StepUpResult"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    sendStepUpEmailCode: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Code queued. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    getMySecurity: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Summary for the security settings page. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SecuritySummary"];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    startTotpSetup: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Scan `otpauth_uri` (QR) or type `secret` into an authenticator app. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TotpSetup"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
        };
    };
    disableTotp: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description TOTP disabled. */
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
    confirmTotpSetup: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["TotpConfirmRequest"];
            };
        };
        responses: {
            /** @description TOTP enabled. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["TotpConfirmResult"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    regenerateRecoveryCodes: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The new codes, shown once. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RecoveryCodes"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
        };
    };
    listMyPasskeys: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Oldest first; at most 10. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PasskeyList"];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    addPasskey: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["AddPasskeyRequest"];
            };
        };
        responses: {
            /** @description Registered. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AddPasskeyResult"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            409: components["responses"]["Conflict"];
        };
    };
    passkeyRegistrationOptions: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Options for `navigator.credentials.create()`. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PasskeyOptions"];
                };
            };
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
        };
    };
    deletePasskey: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                passkey_id: components["schemas"]["Uuid"];
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
            404: components["responses"]["NotFound"];
        };
    };
    renamePasskey: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                passkey_id: components["schemas"]["Uuid"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["RenamePasskeyRequest"];
            };
        };
        responses: {
            /** @description The passkey after the change. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Passkey"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    listMySessions: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The sessions. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SessionList"];
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    revokeMySession: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                session_id: components["schemas"]["Uuid"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Revoked. */
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
    revokeOtherSessions: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description How many sessions were revoked. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": {
                        revoked: number;
                    };
                };
            };
            401: components["responses"]["Unauthorized"];
        };
    };
    reportSession: {
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
            /** @description The session was revoked (or was already revoked). */
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
    listMySecurityEvents: {
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
            /** @description A page of events. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["SecurityEventPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
        };
    };
    googleStart: {
        parameters: {
            query?: {
                /** @description Relative path to return to after sign-in. Absolute URLs are rejected. */
                return_to?: string;
                /**
                 * @description Closed beta (ADR-034). Carried in the signed, HttpOnly OAuth state cookie next to the PKCE verifier
                 *     (never sent to Google) and checked in the callback only when the Google account is not linked to an
                 *     existing user. Not validated here, so a
                 *     wrong code is reported after the Google round trip.
                 */
                invite_code?: string;
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
                    "application/json": components["schemas"]["UserProfile"];
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
    adminListCreatorRequests: {
        parameters: {
            query?: {
                status?: components["schemas"]["CreatorRequestStatus"];
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
            /** @description One page of requests. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminCreatorRequestPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
        };
    };
    adminDecideCreatorRequest: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                request_id: components["schemas"]["Uuid"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreatorRequestDecision"];
            };
        };
        responses: {
            /** @description The request after the decision. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AdminCreatorRequest"];
                };
            };
            400: components["responses"]["BadRequest"];
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

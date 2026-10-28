-- SOC-1a fixes (ADR-049 addendum 2026-10-28).
--   1. Mail template STEP_UP_CODE: the step-up e-mail code was queued as VERIFY_EMAIL, whose body only
--      renders params.link, so the code never reached the user.
--   2. Sessions for refresh-token families issued before auth-svc started writing auth.sessions
--      (sign-ins from before the SOC-1a deploy). Without a row, step-up updates nothing and every
--      step-up-protected call (TOTP setup, recovery codes, ...) answers STEP_UP_REQUIRED forever.
--      Only families with a live token get a row; device, country and amr stay unknown.

ALTER TYPE auth.mail_template ADD VALUE IF NOT EXISTS 'STEP_UP_CODE';

INSERT INTO auth.sessions (id, user_id, created_at, last_used_at)
SELECT rt.family_id, rt.user_id, min(rt.issued_at), max(rt.issued_at)
FROM auth.refresh_tokens rt
WHERE NOT EXISTS (SELECT 1 FROM auth.sessions s WHERE s.id = rt.family_id)
GROUP BY rt.family_id, rt.user_id
HAVING bool_or(rt.revoked_at IS NULL AND rt.expires_at > now())
ON CONFLICT (id) DO NOTHING;

#!/usr/bin/env bash
# Generates and applies Kubernetes Secrets for Winkey Application Plane (auth, upload, video, social, realtime)
# Idempotent: checks for existing secrets and never overwrites active credentials.
set -euo pipefail

export PATH="/usr/local/bin:$PATH"
if [ -f /etc/rancher/k3s/k3s.yaml ] && [ -z "${KUBECONFIG:-}" ]; then
    export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
fi

NAMESPACE="${1:-default}"

gen_secret() {
    openssl rand -hex "$1"
}

echo "==> [1/7] Fetching base infrastructure passwords from DATA & STORAGE secrets..."
PG_AUTH_PWD=$(kubectl get secret winkey-pg-auth-svc -n "$NAMESPACE" -o jsonpath='{.data.password}' | base64 -d)
PG_MEDIA_PWD=$(kubectl get secret winkey-pg-media-svc -n "$NAMESPACE" -o jsonpath='{.data.password}' | base64 -d)
PG_SOCIAL_PWD=$(kubectl get secret winkey-pg-social-svc -n "$NAMESPACE" -o jsonpath='{.data.password}' | base64 -d)
PG_CHAT_PWD=$(kubectl get secret winkey-pg-chat-svc -n "$NAMESPACE" -o jsonpath='{.data.password}' 2>/dev/null | base64 -d || true)

NATS_AUTH_PWD=$(kubectl get secret nats-auth -n "$NAMESPACE" -o jsonpath='{.data.auth_password}' | base64 -d)
NATS_UPLOAD_PWD=$(kubectl get secret nats-auth -n "$NAMESPACE" -o jsonpath='{.data.upload_password}' | base64 -d)
NATS_VIDEO_PWD=$(kubectl get secret nats-auth -n "$NAMESPACE" -o jsonpath='{.data.video_password}' | base64 -d)
NATS_SOCIAL_PWD=$(kubectl get secret nats-auth -n "$NAMESPACE" -o jsonpath='{.data.social_password}' | base64 -d)
NATS_REALTIME_PWD=$(kubectl get secret nats-auth -n "$NAMESPACE" -o jsonpath='{.data.realtime_password}' | base64 -d)
NATS_CHAT_PWD=$(kubectl get secret nats-auth -n "$NAMESPACE" -o jsonpath='{.data.chat_password}' 2>/dev/null | base64 -d || true)

VALKEY_PWD=$(kubectl get secret valkey-auth -n "$NAMESPACE" -o jsonpath='{.data.password}' | base64 -d)

echo "==> [2/7] Ensuring auth-secrets exists..."
if ! kubectl get secret auth-secrets -n "$NAMESPACE" >/dev/null 2>&1; then
    RSA_KEY=$(openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048)
    COOKIE_SECRET=$(gen_secret 32)
    DATABASE_URL="postgres://auth_svc:${PG_AUTH_PWD}@winkey-pg-rw:5432/winkey?sslmode=disable"
    NATS_URL="nats://auth:${NATS_AUTH_PWD}@nats.default.svc:4222"
    VALKEY_URL="redis://:${VALKEY_PWD}@valkey:6379"

    # SOC-1a (ADR-049): account security secrets
    TOTP_KEY=$(openssl rand -base64 32)
    TOTP_ENCRYPTION_KEYS="k1:${TOTP_KEY}"
    SESSION_IP_SALT=$(openssl rand -base64 32)
    WEBAUTHN_USER_HANDLE_KEY=$(openssl rand -base64 32)

    kubectl create secret generic auth-secrets -n "$NAMESPACE" \
      --from-literal=DATABASE_URL="$DATABASE_URL" \
      --from-literal=NATS_URL="$NATS_URL" \
      --from-literal=VALKEY_URL="$VALKEY_URL" \
      --from-literal=JWT_PRIVATE_KEY="$RSA_KEY" \
      --from-literal=JWT_KID="winkey-auth-key-1" \
      --from-literal=COOKIE_SECRET="$COOKIE_SECRET" \
      --from-literal=TOTP_ENCRYPTION_KEYS="$TOTP_ENCRYPTION_KEYS" \
      --from-literal=SESSION_IP_SALT="$SESSION_IP_SALT" \
      --from-literal=WEBAUTHN_USER_HANDLE_KEY="$WEBAUTHN_USER_HANDLE_KEY"
    echo "  Created secret auth-secrets." >&2
else
    echo "  Secret auth-secrets already exists." >&2

    # SOC-1a (ADR-049): check and add missing account security keys idempotently
    # Note: secrets are piped via stdin to prevent exposing key material in host process tables (ps)
    if ! kubectl get secret auth-secrets -n "$NAMESPACE" -o jsonpath='{.data.TOTP_ENCRYPTION_KEYS}' 2>/dev/null | grep -q .; then
        TOTP_KEY=$(openssl rand -base64 32)
        TOTP_ENCRYPTION_KEYS="k1:${TOTP_KEY}"
        printf '{"stringData":{"TOTP_ENCRYPTION_KEYS":"%s"}}' "$TOTP_ENCRYPTION_KEYS" | \
          kubectl patch secret auth-secrets -n "$NAMESPACE" --type merge --patch-file /dev/stdin
        echo "  Added TOTP_ENCRYPTION_KEYS to existing auth-secrets (IMPORTANT: back up this key to vault!)." >&2
    fi

    if ! kubectl get secret auth-secrets -n "$NAMESPACE" -o jsonpath='{.data.SESSION_IP_SALT}' 2>/dev/null | grep -q .; then
        SESSION_IP_SALT=$(openssl rand -base64 32)
        printf '{"stringData":{"SESSION_IP_SALT":"%s"}}' "$SESSION_IP_SALT" | \
          kubectl patch secret auth-secrets -n "$NAMESPACE" --type merge --patch-file /dev/stdin
        echo "  Added SESSION_IP_SALT to existing auth-secrets." >&2
    fi

    if ! kubectl get secret auth-secrets -n "$NAMESPACE" -o jsonpath='{.data.WEBAUTHN_USER_HANDLE_KEY}' 2>/dev/null | grep -q .; then
        WEBAUTHN_USER_HANDLE_KEY=$(openssl rand -base64 32)
        printf '{"stringData":{"WEBAUTHN_USER_HANDLE_KEY":"%s"}}' "$WEBAUTHN_USER_HANDLE_KEY" | \
          kubectl patch secret auth-secrets -n "$NAMESPACE" --type merge --patch-file /dev/stdin
        echo "  Added WEBAUTHN_USER_HANDLE_KEY to existing auth-secrets." >&2
    fi
fi

# Closed-beta invite codes (ADR-034, task BETA1)
EXISTING_INVITE_CODES=$(kubectl get secret auth-secrets -n "$NAMESPACE" -o jsonpath='{.data.INVITE_CODES}' 2>/dev/null || true)
if [ -z "$EXISTING_INVITE_CODES" ]; then
    echo -n "Enter INVITE_CODES (comma-separated, leave blank to skip): " >&2
    INVITE_CODES=""
    read -r -s INVITE_CODES || true
    echo >&2
    if [ -n "${INVITE_CODES:-}" ]; then
        printf '{"stringData":{"INVITE_CODES":"%s"}}' "$INVITE_CODES" | \
          kubectl patch secret auth-secrets -n "$NAMESPACE" --type merge --patch-file /dev/stdin
        echo "  Configured INVITE_CODES in auth-secrets." >&2
    fi
fi

echo "==> Ensuring auth-google secret exists..."
if kubectl get secret auth-google -n "$NAMESPACE" >/dev/null 2>&1; then
    echo "  Secret auth-google already exists." >&2
else
    echo -n "Enter GOOGLE_CLIENT_ID (leave blank to skip): " >&2
    GOOGLE_CLIENT_ID=""
    read -r -s GOOGLE_CLIENT_ID || true
    echo >&2
    if [ -z "${GOOGLE_CLIENT_ID:-}" ]; then
        echo "WARNING: GOOGLE_CLIENT_ID is empty; skipping creation of secret auth-google." >&2
    else
        echo -n "Enter GOOGLE_CLIENT_SECRET: " >&2
        GOOGLE_CLIENT_SECRET=""
        read -r -s GOOGLE_CLIENT_SECRET || true
        echo >&2
        if [ -z "${GOOGLE_CLIENT_SECRET:-}" ]; then
            echo "WARNING: GOOGLE_CLIENT_SECRET is empty; skipping creation of secret auth-google." >&2
        else
            kubectl create secret generic auth-google -n "$NAMESPACE" \
              --from-literal=GOOGLE_CLIENT_ID="$GOOGLE_CLIENT_ID" \
              --from-literal=GOOGLE_CLIENT_SECRET="$GOOGLE_CLIENT_SECRET"
            echo "  Created secret auth-google." >&2
        fi
    fi
fi

echo "==> Ensuring auth-smtp secret exists..."
if kubectl get secret auth-smtp -n "$NAMESPACE" >/dev/null 2>&1; then
    echo "  Secret auth-smtp already exists." >&2
else
    echo -n "Enter SMTP_URL (leave blank to skip): " >&2
    SMTP_URL=""
    read -r -s SMTP_URL || true
    echo >&2
    if [ -z "${SMTP_URL:-}" ]; then
        echo "WARNING: SMTP_URL is empty; skipping creation of secret auth-smtp." >&2
    else
        kubectl create secret generic auth-smtp -n "$NAMESPACE" \
          --from-literal=SMTP_URL="$SMTP_URL"
        echo "  Created secret auth-smtp." >&2
    fi
fi

echo "==> Ensuring auth-turnstile secret exists (SOC-1a)..."
if kubectl get secret auth-turnstile -n "$NAMESPACE" >/dev/null 2>&1; then
    echo "  Secret auth-turnstile already exists." >&2
else
    echo -n "Enter TURNSTILE_SECRET (leave blank to skip / disable captcha): " >&2
    TURNSTILE_SECRET=""
    read -r -s TURNSTILE_SECRET || true
    echo >&2
    if [ -n "${TURNSTILE_SECRET:-}" ]; then
        kubectl create secret generic auth-turnstile -n "$NAMESPACE" \
          --from-literal=TURNSTILE_SECRET="$TURNSTILE_SECRET"
        echo "  Created secret auth-turnstile." >&2
    else
        echo "  TURNSTILE_SECRET empty; skipping creation of secret auth-turnstile (optional)." >&2
    fi
fi

echo "==> [3/7] Ensuring upload-secrets exists..."
if ! kubectl get secret upload-secrets -n "$NAMESPACE" >/dev/null 2>&1; then
    DATABASE_URL="postgres://media_svc:${PG_MEDIA_PWD}@winkey-pg-rw:5432/winkey?sslmode=disable"
    NATS_URL="nats://upload:${NATS_UPLOAD_PWD}@nats.default.svc:4222"

    kubectl create secret generic upload-secrets -n "$NAMESPACE" \
      --from-literal=DATABASE_URL="$DATABASE_URL" \
      --from-literal=NATS_URL="$NATS_URL"
    echo "  Created secret upload-secrets." >&2
else
    echo "  Secret upload-secrets already exists." >&2
fi

echo "==> [4/7] Ensuring video-secrets exists..."
if ! kubectl get secret video-secrets -n "$NAMESPACE" >/dev/null 2>&1; then
    DATABASE_URL="postgres://media_svc:${PG_MEDIA_PWD}@winkey-pg-rw:5432/winkey?sslmode=disable"
    NATS_URL="nats://video:${NATS_VIDEO_PWD}@nats.default.svc:4222"
    VALKEY_URL="redis://:${VALKEY_PWD}@valkey:6379/0"
    MEDIA_LINK_SECRET=$(gen_secret 32)
    CURSOR_SECRET=$(gen_secret 16)
    ANALYTICS_VIEWER_SALT=$(gen_secret 32)

    kubectl create secret generic video-secrets -n "$NAMESPACE" \
      --from-literal=DATABASE_URL="$DATABASE_URL" \
      --from-literal=NATS_URL="$NATS_URL" \
      --from-literal=VALKEY_URL="$VALKEY_URL" \
      --from-literal=MEDIA_LINK_SECRET="$MEDIA_LINK_SECRET" \
      --from-literal=CURSOR_SECRET="$CURSOR_SECRET" \
      --from-literal=ANALYTICS_VIEWER_SALT="$ANALYTICS_VIEWER_SALT"
    echo "  Created secret video-secrets." >&2
else
    echo "  Secret video-secrets already exists." >&2
    if ! kubectl get secret video-secrets -n "$NAMESPACE" -o jsonpath='{.data.ANALYTICS_VIEWER_SALT}' 2>/dev/null | grep -q .; then
        ANALYTICS_VIEWER_SALT=$(gen_secret 32)
        printf '{"data":{"ANALYTICS_VIEWER_SALT":"%s"}}' "$(echo -n "$ANALYTICS_VIEWER_SALT" | base64 -w0)" | \
          kubectl patch secret video-secrets -n "$NAMESPACE" --type merge --patch-file /dev/stdin
        echo "  Added ANALYTICS_VIEWER_SALT to existing video-secrets." >&2
    fi
fi

# Export MEDIA_LINK_SECRET for SEC1-b nginx template
MEDIA_LINK_SEC_VAL=$(kubectl get secret video-secrets -n "$NAMESPACE" -o jsonpath='{.data.MEDIA_LINK_SECRET}' | base64 -d)
if [ -d /etc/nginx ]; then
    echo -n "$MEDIA_LINK_SEC_VAL" > /etc/nginx/winkey-media-link-secret
    chmod 0600 /etc/nginx/winkey-media-link-secret
    echo "  Exported MEDIA_LINK_SECRET to /etc/nginx/winkey-media-link-secret (0600)." >&2
fi
if [ -d /var/lib/rancher/k3s ]; then
    echo -n "$MEDIA_LINK_SEC_VAL" > /var/lib/rancher/k3s/media-link-secret
    chmod 0600 /var/lib/rancher/k3s/media-link-secret
    echo "  Exported MEDIA_LINK_SECRET to /var/lib/rancher/k3s/media-link-secret (0600)." >&2
fi

echo "==> [5/7] Ensuring social-secrets exists..."
if ! kubectl get secret social-secrets -n "$NAMESPACE" >/dev/null 2>&1; then
    DATABASE_URL="postgres://social_svc:${PG_SOCIAL_PWD}@winkey-pg-rw:5432/winkey?sslmode=disable"
    NATS_URL="nats://social:${NATS_SOCIAL_PWD}@nats.default.svc:4222"
    VALKEY_URL="redis://:${VALKEY_PWD}@valkey:6379"

    kubectl create secret generic social-secrets -n "$NAMESPACE" \
      --from-literal=DATABASE_URL="$DATABASE_URL" \
      --from-literal=NATS_URL="$NATS_URL" \
      --from-literal=VALKEY_URL="$VALKEY_URL"
    echo "  Created secret social-secrets." >&2
else
    echo "  Secret social-secrets already exists." >&2
fi

echo "==> [6/7] Ensuring realtime-secrets exists..."
if ! kubectl get secret realtime-secrets -n "$NAMESPACE" >/dev/null 2>&1; then
    NATS_URL="nats://realtime:${NATS_REALTIME_PWD}@nats.default.svc:4222"
    VALKEY_URL="redis://:${VALKEY_PWD}@valkey:6379"

    kubectl create secret generic realtime-secrets -n "$NAMESPACE" \
      --from-literal=NATS_URL="$NATS_URL" \
      --from-literal=VALKEY_URL="$VALKEY_URL"
    echo "  Created secret realtime-secrets." >&2
else
    echo "  Secret realtime-secrets already exists." >&2
fi

echo "==> [7/8] Ensuring chat-secrets exists..."
if ! kubectl get secret chat-secrets -n "$NAMESPACE" >/dev/null 2>&1; then
    DATABASE_URL="postgres://chat_svc:${PG_CHAT_PWD}@winkey-pg-rw:5432/winkey?sslmode=disable"
    NATS_URL="nats://chat:${NATS_CHAT_PWD}@nats.default.svc:4222"
    VALKEY_URL="redis://:${VALKEY_PWD}@valkey:6379"

    kubectl create secret generic chat-secrets -n "$NAMESPACE" \
      --from-literal=DATABASE_URL="$DATABASE_URL" \
      --from-literal=NATS_URL="$NATS_URL" \
      --from-literal=VALKEY_URL="$VALKEY_URL"
    echo "  Created secret chat-secrets." >&2
else
    echo "  Secret chat-secrets already exists." >&2
fi

# SOC-4a (ADR-049 addendum): Ensure TURN_SECRET and coturn-secrets exist
echo "==> [8/8] Ensuring coturn-secrets and TURN_SECRET exist..."
EXISTING_TURN_SEC=$(kubectl get secret coturn-secrets -n "$NAMESPACE" -o jsonpath='{.data.TURN_SECRET}' 2>/dev/null | base64 -d || true)
if [ -z "$EXISTING_TURN_SEC" ]; then
    EXISTING_TURN_SEC=$(kubectl get secret chat-secrets -n "$NAMESPACE" -o jsonpath='{.data.TURN_SECRET}' 2>/dev/null | base64 -d || true)
fi

if [ -z "$EXISTING_TURN_SEC" ]; then
    TURN_SECRET=$(openssl rand -base64 48)
else
    TURN_SECRET="$EXISTING_TURN_SEC"
fi

if ! kubectl get secret coturn-secrets -n "$NAMESPACE" >/dev/null 2>&1; then
    kubectl create secret generic coturn-secrets -n "$NAMESPACE" \
      --from-literal=TURN_SECRET="$TURN_SECRET"
    echo "  Created secret coturn-secrets." >&2
else
    printf '{"stringData":{"TURN_SECRET":"%s"}}' "$TURN_SECRET" | \
      kubectl patch secret coturn-secrets -n "$NAMESPACE" --type merge --patch-file /dev/stdin
    echo "  Updated secret coturn-secrets." >&2
fi

printf '{"stringData":{"TURN_SECRET":"%s"}}' "$TURN_SECRET" | \
  kubectl patch secret chat-secrets -n "$NAMESPACE" --type merge --patch-file /dev/stdin
echo "  Synced TURN_SECRET into chat-secrets." >&2

# Auto-detect or set public IP for coturn denied-peer-ip blacklist (SOC-4a)
EXISTING_PUBLIC_IP=$(kubectl get secret coturn-secrets -n "$NAMESPACE" -o jsonpath='{.data.EDGE_PUBLIC_IP}' 2>/dev/null | base64 -d || true)
if [ -z "$EXISTING_PUBLIC_IP" ]; then
    DETECTED_PUBLIC_IP=$(curl -sS https://api.ipify.org 2>/dev/null || curl -sS https://ifconfig.me 2>/dev/null || true)
    if [ -n "$DETECTED_PUBLIC_IP" ]; then
        printf '{"stringData":{"EDGE_PUBLIC_IP":"%s"}}' "$DETECTED_PUBLIC_IP" | \
          kubectl patch secret coturn-secrets -n "$NAMESPACE" --type merge --patch-file /dev/stdin
        echo "  Configured EDGE_PUBLIC_IP in coturn-secrets." >&2
    fi
fi

# SOC-3b (ADR-049 addendum): Scoped R2 token for bucket `winkey-chat`
EXISTING_CHAT_S3_KEY=$(kubectl get secret chat-secrets -n "$NAMESPACE" -o jsonpath='{.data.CHAT_S3_ACCESS_KEY_ID}' 2>/dev/null || true)
if [ -z "$EXISTING_CHAT_S3_KEY" ]; then
    echo -n "Enter CHAT_S3_ACCESS_KEY_ID (scoped R2 token for winkey-chat, leave blank to skip): " >&2
    CHAT_S3_KEY=""
    read -r -s CHAT_S3_KEY || true
    echo >&2
    if [ -n "${CHAT_S3_KEY:-}" ]; then
        echo -n "Enter CHAT_S3_SECRET_ACCESS_KEY: " >&2
        CHAT_S3_SEC=""
        read -r -s CHAT_S3_SEC || true
        echo >&2
        if [ -n "${CHAT_S3_SEC:-}" ]; then
            printf '{"stringData":{"CHAT_S3_ACCESS_KEY_ID":"%s","CHAT_S3_SECRET_ACCESS_KEY":"%s"}}' "$CHAT_S3_KEY" "$CHAT_S3_SEC" | \
              kubectl patch secret chat-secrets -n "$NAMESPACE" --type merge --patch-file /dev/stdin
            echo "  Configured CHAT_S3 credentials in chat-secrets." >&2
        fi
    fi
fi

echo "All Application Plane secrets successfully verified."

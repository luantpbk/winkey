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

echo "==> [1/6] Fetching base infrastructure passwords from DATA & STORAGE secrets..."
PG_AUTH_PWD=$(kubectl get secret winkey-pg-auth-svc -n "$NAMESPACE" -o jsonpath='{.data.password}' | base64 -d)
PG_MEDIA_PWD=$(kubectl get secret winkey-pg-media-svc -n "$NAMESPACE" -o jsonpath='{.data.password}' | base64 -d)
PG_SOCIAL_PWD=$(kubectl get secret winkey-pg-social-svc -n "$NAMESPACE" -o jsonpath='{.data.password}' | base64 -d)

NATS_AUTH_PWD=$(kubectl get secret nats-auth -n "$NAMESPACE" -o jsonpath='{.data.auth_password}' | base64 -d)
NATS_UPLOAD_PWD=$(kubectl get secret nats-auth -n "$NAMESPACE" -o jsonpath='{.data.upload_password}' | base64 -d)
NATS_VIDEO_PWD=$(kubectl get secret nats-auth -n "$NAMESPACE" -o jsonpath='{.data.video_password}' | base64 -d)
NATS_SOCIAL_PWD=$(kubectl get secret nats-auth -n "$NAMESPACE" -o jsonpath='{.data.social_password}' | base64 -d)
NATS_REALTIME_PWD=$(kubectl get secret nats-auth -n "$NAMESPACE" -o jsonpath='{.data.realtime_password}' | base64 -d)

VALKEY_PWD=$(kubectl get secret valkey-auth -n "$NAMESPACE" -o jsonpath='{.data.password}' | base64 -d)

echo "==> [2/6] Ensuring auth-secrets exists..."
if ! kubectl get secret auth-secrets -n "$NAMESPACE" >/dev/null 2>&1; then
    RSA_KEY=$(openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048)
    COOKIE_SECRET=$(gen_secret 32)
    DATABASE_URL="postgres://auth_svc:${PG_AUTH_PWD}@winkey-pg-rw:5432/winkey?sslmode=disable"
    NATS_URL="nats://auth:${NATS_AUTH_PWD}@nats.default.svc:4222"
    VALKEY_URL="redis://:${VALKEY_PWD}@valkey:6379"

    kubectl create secret generic auth-secrets -n "$NAMESPACE" \
      --from-literal=DATABASE_URL="$DATABASE_URL" \
      --from-literal=NATS_URL="$NATS_URL" \
      --from-literal=VALKEY_URL="$VALKEY_URL" \
      --from-literal=JWT_PRIVATE_KEY="$RSA_KEY" \
      --from-literal=JWT_KID="winkey-auth-key-1" \
      --from-literal=COOKIE_SECRET="$COOKIE_SECRET"
    echo "  Created secret auth-secrets." >&2
else
    echo "  Secret auth-secrets already exists." >&2
fi

echo "==> [3/6] Ensuring upload-secrets exists..."
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

echo "==> [4/6] Ensuring video-secrets exists..."
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
        kubectl patch secret video-secrets -n "$NAMESPACE" -p "{\"data\":{\"ANALYTICS_VIEWER_SALT\":\"$(echo -n "$ANALYTICS_VIEWER_SALT" | base64 -w0)\"}}"
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

echo "==> [5/6] Ensuring social-secrets exists..."
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

echo "==> [6/6] Ensuring realtime-secrets exists..."
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

echo "All Application Plane secrets successfully verified."

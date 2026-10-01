#!/usr/bin/env bash
# Generates and applies Kubernetes Secrets for Winkey Data Plane (PostgreSQL, NATS, Valkey)
# Idempotent: checks for existing secrets and never overwrites active credentials.
set -euo pipefail

export PATH="/usr/local/bin:$PATH"
if [ -f /etc/rancher/k3s/k3s.yaml ] && [ -z "${KUBECONFIG:-}" ]; then
    export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
fi

NAMESPACE="${1:-default}"

gen_pwd() {
    openssl rand -hex 16
}

ensure_pg_secret() {
    local SECRET_NAME="$1"
    local USERNAME="$2"
    if kubectl get secret "$SECRET_NAME" -n "$NAMESPACE" >/dev/null 2>&1; then
        echo "  Secret $SECRET_NAME already exists." >&2
    else
        local PWD
        PWD=$(gen_pwd)
        kubectl create secret generic "$SECRET_NAME" -n "$NAMESPACE" \
          --from-literal=username="$USERNAME" \
          --from-literal=password="$PWD"
        echo "  Created secret $SECRET_NAME." >&2
    fi
}

echo "==> [1/3] Ensuring PostgreSQL secrets exist..."
ensure_pg_secret "winkey-pg-owner" "winkey_owner"
ensure_pg_secret "winkey-pg-auth-svc" "auth_svc"
ensure_pg_secret "winkey-pg-media-svc" "media_svc"
ensure_pg_secret "winkey-pg-social-svc" "social_svc"
ensure_pg_secret "winkey-pg-analytics-svc" "analytics_svc"


echo "==> [2/3] Ensuring NATS authorization secret exists..."
if ! kubectl get secret "nats-auth" -n "$NAMESPACE" >/dev/null 2>&1; then
    ADMIN_PWD=$(gen_pwd)
    AUTH_PWD=$(gen_pwd)
    UPLOAD_PWD=$(gen_pwd)
    TRANSCODER_PWD=$(gen_pwd)
    VIDEO_PWD=$(gen_pwd)
    SOCIAL_PWD=$(gen_pwd)
    REALTIME_PWD=$(gen_pwd)
    ANALYTICS_PWD=$(gen_pwd)

    AUTH_CONF=$(cat <<EOF
authorization: {
  users: [
    {
      user: "admin"
      password: "${ADMIN_PWD}"
      permissions: {
        publish: [">", "_INBOX.>", "\$JS.API.>"]
        subscribe: [">", "_INBOX.>", "\$JS.API.>"]
      }
    },
    {
      user: "auth"
      password: "${AUTH_PWD}"
      permissions: {
        publish: ["user.>", "_INBOX.>", "\$JS.API.>"]
        subscribe: ["_INBOX.>"]
      }
    },
    {
      user: "upload"
      password: "${UPLOAD_PWD}"
      permissions: {
        publish: ["video.uploaded", "_INBOX.>", "\$JS.API.>"]
        subscribe: ["rt.video.*.progress", "_INBOX.>"]
      }
    },
    {
      user: "transcoder"
      password: "${TRANSCODER_PWD}"
      permissions: {
        publish: ["video.ready", "video.failed", "rt.video.*.progress", "dlq.video.uploaded", "_INBOX.>", "\$JS.API.>"]
        subscribe: ["video.uploaded", "_INBOX.>"]
      }
    },
    {
      user: "video"
      password: "${VIDEO_PWD}"
      permissions: {
        publish: ["video.deleted", "video.moderated", "video.visibility_changed", "analytics.>", "_INBOX.>", "\$JS.API.>"]
        subscribe: ["social.video.like_changed", "social.subscription.changed", "_INBOX.>"]
      }
    },
    {
      user: "social"
      password: "${SOCIAL_PWD}"
      permissions: {
        publish: ["social.comment.created", "social.video.like_changed", "social.subscription.changed", "_INBOX.>", "\$JS.API.>"]
        subscribe: ["video.ready", "video.deleted", "video.moderated", "_INBOX.>"]
      }
    },
    {
      user: "realtime"
      password: "${REALTIME_PWD}"
      permissions: {
        publish: ["_INBOX.>", "\$JS.API.>"]
        subscribe: ["video.ready", "video.failed", "social.comment.created", "social.video.like_changed", "rt.video.*.progress", "_INBOX.>"]
      }
    },
    {
      user: "analytics"
      password: "${ANALYTICS_PWD}"
      permissions: {
        publish: [
          "_INBOX.>",
          "\$JS.API.STREAM.INFO.ANALYTICS",
          "\$JS.API.CONSUMER.CREATE.ANALYTICS.analytics-clickhouse",
          "\$JS.API.CONSUMER.CREATE.ANALYTICS.analytics-clickhouse.>",
          "\$JS.API.CONSUMER.DURABLE.CREATE.ANALYTICS.analytics-clickhouse",
          "\$JS.API.CONSUMER.DURABLE.CREATE.ANALYTICS.analytics-clickhouse.>",
          "\$JS.API.CONSUMER.INFO.ANALYTICS.analytics-clickhouse",
          "\$JS.API.CONSUMER.MSG.NEXT.ANALYTICS.analytics-clickhouse",
          "\$JS.ACK.ANALYTICS.analytics-clickhouse.>"
        ]
        subscribe: [
          "_INBOX.>"
        ]
      }
    }
  ]
}
EOF
)
    kubectl create secret generic nats-auth -n "$NAMESPACE" \
      --from-literal=auth.conf="$AUTH_CONF" \
      --from-literal=admin_password="$ADMIN_PWD" \
      --from-literal=auth_password="$AUTH_PWD" \
      --from-literal=upload_password="$UPLOAD_PWD" \
      --from-literal=transcoder_password="$TRANSCODER_PWD" \
      --from-literal=video_password="$VIDEO_PWD" \
      --from-literal=social_password="$SOCIAL_PWD" \
      --from-literal=realtime_password="$REALTIME_PWD" \
      --from-literal=analytics_password="$ANALYTICS_PWD"

    kubectl create secret generic nats-admin-creds -n "$NAMESPACE" \
      --from-literal=username="admin" \
      --from-literal=password="$ADMIN_PWD"
    echo "  Created secret nats-auth and nats-admin-creds." >&2
else
    # Update existing secret if analytics_password is missing
    if ! kubectl get secret nats-auth -n "$NAMESPACE" -o jsonpath='{.data.analytics_password}' 2>/dev/null | grep -q .; then
        echo "  Updating existing nats-auth secret with analytics user and permissions..." >&2
        ADMIN_PWD=$(kubectl get secret nats-auth -n "$NAMESPACE" -o jsonpath='{.data.admin_password}' | base64 -d)
        AUTH_PWD=$(kubectl get secret nats-auth -n "$NAMESPACE" -o jsonpath='{.data.auth_password}' | base64 -d)
        UPLOAD_PWD=$(kubectl get secret nats-auth -n "$NAMESPACE" -o jsonpath='{.data.upload_password}' | base64 -d)
        TRANSCODER_PWD=$(kubectl get secret nats-auth -n "$NAMESPACE" -o jsonpath='{.data.transcoder_password}' | base64 -d)
        VIDEO_PWD=$(kubectl get secret nats-auth -n "$NAMESPACE" -o jsonpath='{.data.video_password}' | base64 -d)
        SOCIAL_PWD=$(kubectl get secret nats-auth -n "$NAMESPACE" -o jsonpath='{.data.social_password}' | base64 -d)
        REALTIME_PWD=$(kubectl get secret nats-auth -n "$NAMESPACE" -o jsonpath='{.data.realtime_password}' | base64 -d)
        ANALYTICS_PWD=$(gen_pwd)

        AUTH_CONF=$(cat <<EOF
authorization: {
  users: [
    {
      user: "admin"
      password: "${ADMIN_PWD}"
      permissions: {
        publish: [">", "_INBOX.>", "\$JS.API.>"]
        subscribe: [">", "_INBOX.>", "\$JS.API.>"]
      }
    },
    {
      user: "auth"
      password: "${AUTH_PWD}"
      permissions: {
        publish: ["user.>", "_INBOX.>", "\$JS.API.>"]
        subscribe: ["_INBOX.>"]
      }
    },
    {
      user: "upload"
      password: "${UPLOAD_PWD}"
      permissions: {
        publish: ["video.uploaded", "_INBOX.>", "\$JS.API.>"]
        subscribe: ["rt.video.*.progress", "_INBOX.>"]
      }
    },
    {
      user: "transcoder"
      password: "${TRANSCODER_PWD}"
      permissions: {
        publish: ["video.ready", "video.failed", "rt.video.*.progress", "dlq.video.uploaded", "_INBOX.>", "\$JS.API.>"]
        subscribe: ["video.uploaded", "_INBOX.>"]
      }
    },
    {
      user: "video"
      password: "${VIDEO_PWD}"
      permissions: {
        publish: ["video.deleted", "video.moderated", "video.visibility_changed", "analytics.>", "_INBOX.>", "\$JS.API.>"]
        subscribe: ["social.video.like_changed", "social.subscription.changed", "_INBOX.>"]
      }
    },
    {
      user: "social"
      password: "${SOCIAL_PWD}"
      permissions: {
        publish: ["social.comment.created", "social.video.like_changed", "social.subscription.changed", "_INBOX.>", "\$JS.API.>"]
        subscribe: ["video.ready", "video.deleted", "video.moderated", "_INBOX.>"]
      }
    },
    {
      user: "realtime"
      password: "${REALTIME_PWD}"
      permissions: {
        publish: ["_INBOX.>", "\$JS.API.>"]
        subscribe: ["video.ready", "video.failed", "social.comment.created", "social.video.like_changed", "rt.video.*.progress", "_INBOX.>"]
      }
    },
    {
      user: "analytics"
      password: "${ANALYTICS_PWD}"
      permissions: {
        publish: [
          "_INBOX.>",
          "\$JS.API.STREAM.INFO.ANALYTICS",
          "\$JS.API.CONSUMER.CREATE.ANALYTICS.analytics-clickhouse",
          "\$JS.API.CONSUMER.CREATE.ANALYTICS.analytics-clickhouse.>",
          "\$JS.API.CONSUMER.DURABLE.CREATE.ANALYTICS.analytics-clickhouse",
          "\$JS.API.CONSUMER.DURABLE.CREATE.ANALYTICS.analytics-clickhouse.>",
          "\$JS.API.CONSUMER.INFO.ANALYTICS.analytics-clickhouse",
          "\$JS.API.CONSUMER.MSG.NEXT.ANALYTICS.analytics-clickhouse",
          "\$JS.ACK.ANALYTICS.analytics-clickhouse.>"
        ]
        subscribe: [
          "_INBOX.>"
        ]
      }
    }
  ]
}
EOF
)
        kubectl create secret generic nats-auth -n "$NAMESPACE" \
          --from-literal=auth.conf="$AUTH_CONF" \
          --from-literal=admin_password="$ADMIN_PWD" \
          --from-literal=auth_password="$AUTH_PWD" \
          --from-literal=upload_password="$UPLOAD_PWD" \
          --from-literal=transcoder_password="$TRANSCODER_PWD" \
          --from-literal=video_password="$VIDEO_PWD" \
          --from-literal=social_password="$SOCIAL_PWD" \
          --from-literal=realtime_password="$REALTIME_PWD" \
          --from-literal=analytics_password="$ANALYTICS_PWD" \
          --dry-run=client -o yaml | kubectl apply -f -
        echo "  Updated secret nats-auth with analytics user." >&2
    else
        echo "  Secret nats-auth already exists." >&2
    fi
fi

echo "==> [3/3] Ensuring Valkey authentication secret exists..."
if ! kubectl get secret "valkey-auth" -n "$NAMESPACE" >/dev/null 2>&1; then
    VALKEY_PWD=$(gen_pwd)
    kubectl create secret generic valkey-auth -n "$NAMESPACE" \
      --from-literal=password="$VALKEY_PWD"
    echo "  Created secret valkey-auth." >&2
else
    echo "  Secret valkey-auth already exists." >&2
fi

# Retrieve passwords to print DSNs
PG_AUTH_PWD=$(kubectl get secret winkey-pg-auth-svc -n "$NAMESPACE" -o jsonpath='{.data.password}' | base64 -d)
PG_MEDIA_PWD=$(kubectl get secret winkey-pg-media-svc -n "$NAMESPACE" -o jsonpath='{.data.password}' | base64 -d)
PG_SOCIAL_PWD=$(kubectl get secret winkey-pg-social-svc -n "$NAMESPACE" -o jsonpath='{.data.password}' | base64 -d)
PG_ANALYTICS_PWD=$(kubectl get secret winkey-pg-analytics-svc -n "$NAMESPACE" -o jsonpath='{.data.password}' 2>/dev/null | base64 -d || echo "")

NATS_AUTH_PWD=$(kubectl get secret nats-auth -n "$NAMESPACE" -o jsonpath='{.data.auth_password}' | base64 -d)
NATS_UPLOAD_PWD=$(kubectl get secret nats-auth -n "$NAMESPACE" -o jsonpath='{.data.upload_password}' | base64 -d)
NATS_TRANSCODER_PWD=$(kubectl get secret nats-auth -n "$NAMESPACE" -o jsonpath='{.data.transcoder_password}' | base64 -d)
NATS_VIDEO_PWD=$(kubectl get secret nats-auth -n "$NAMESPACE" -o jsonpath='{.data.video_password}' | base64 -d)
NATS_SOCIAL_PWD=$(kubectl get secret nats-auth -n "$NAMESPACE" -o jsonpath='{.data.social_password}' | base64 -d)
NATS_REALTIME_PWD=$(kubectl get secret nats-auth -n "$NAMESPACE" -o jsonpath='{.data.realtime_password}' | base64 -d)
NATS_ANALYTICS_PWD=$(kubectl get secret nats-auth -n "$NAMESPACE" -o jsonpath='{.data.analytics_password}' 2>/dev/null | base64 -d || echo "")

VALKEY_PWD=$(kubectl get secret valkey-auth -n "$NAMESPACE" -o jsonpath='{.data.password}' | base64 -d)

echo ""
echo "=========================================================================="
echo " Winkey Data Plane Service DSNs & URLs (Cluster Internal: default.svc)"
echo "=========================================================================="
echo "# auth-svc:"
echo "DATABASE_URL=postgres://auth_svc:${PG_AUTH_PWD}@winkey-pg-rw.default.svc:5432/winkey?sslmode=require"
echo "NATS_URL=nats://auth:${NATS_AUTH_PWD}@nats.default.svc:4222"
echo ""
echo "# upload-svc:"
echo "DATABASE_URL=postgres://media_svc:${PG_MEDIA_PWD}@winkey-pg-rw.default.svc:5432/winkey?sslmode=require"
echo "NATS_URL=nats://upload:${NATS_UPLOAD_PWD}@nats.default.svc:4222"
echo ""
echo "# video-svc:"
echo "DATABASE_URL=postgres://media_svc:${PG_MEDIA_PWD}@winkey-pg-rw.default.svc:5432/winkey?sslmode=require"
echo "NATS_URL=nats://video:${NATS_VIDEO_PWD}@nats.default.svc:4222"
echo "VALKEY_URL=valkey://:${VALKEY_PWD}@valkey.default.svc:6379"
echo ""
echo "# social-svc:"
echo "DATABASE_URL=postgres://social_svc:${PG_SOCIAL_PWD}@winkey-pg-rw.default.svc:5432/winkey?sslmode=require"
echo "NATS_URL=nats://social:${NATS_SOCIAL_PWD}@nats.default.svc:4222"
echo ""
echo "# realtime-svc:"
echo "NATS_URL=nats://realtime:${NATS_REALTIME_PWD}@nats.default.svc:4222"
echo "VALKEY_URL=valkey://:${VALKEY_PWD}@valkey.default.svc:6379"
echo ""
echo "=========================================================================="
echo " gpu-01 Transcoder DSNs (over Tailscale NodePorts: 100.113.240.3)"
echo "=========================================================================="
echo "DATABASE_URL=postgres://media_svc:${PG_MEDIA_PWD}@100.113.240.3:30432/winkey?sslmode=require"
echo "NATS_URL=nats://transcoder:${NATS_TRANSCODER_PWD}@100.113.240.3:30422"
echo "S3_ENDPOINT=http://100.113.240.3:30900"
echo ""
echo "=========================================================================="
echo " gpu-01 Analytics Worker DSNs (over Tailscale NodePorts: 100.113.240.3)"
echo "=========================================================================="
echo "NATS_URL=nats://analytics:<password>@100.113.240.3:30422"
echo "# Password: kubectl get secret nats-auth -n $NAMESPACE -o jsonpath='{.data.analytics_password}' | base64 -d"
echo ""
echo "POSTGRES_URL=postgres://analytics_svc:<password>@100.113.240.3:30432/winkey?sslmode=require"
echo "# Password: kubectl get secret winkey-pg-analytics-svc -n $NAMESPACE -o jsonpath='{.data.password}' | base64 -d"
echo "=========================================================================="



#!/usr/bin/env bash
# Verification script for Winkey Data Plane (PostgreSQL, NATS, Valkey)
# Verifies operator, cluster, migrations, RBAC grants, NATS streams, auth matrix, Valkey, and S3 backup.
set -euo pipefail

export PATH="/usr/local/bin:$PATH"
if [ -f /etc/rancher/k3s/k3s.yaml ] && [ -z "${KUBECONFIG:-}" ]; then
    export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
fi

NAMESPACE="${1:-default}"

cleanup() {
    kubectl delete pod nats-verifier s3-backup-verify unauth-test-verifier auth-test-verifier -n "$NAMESPACE" --grace-period=0 --force --ignore-not-found >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "=========================================================================="
echo " 1. CloudNativePG Operator & PostgreSQL Cluster Status"
echo "=========================================================================="
echo "Checking CNPG operator..."
kubectl rollout status deployment cnpg-controller-manager -n cnpg-system --timeout=60s
echo "SUCCESS: CNPG operator is running."

echo "Checking PostgreSQL cluster winkey-pg..."
kubectl wait --for=condition=Ready cluster/winkey-pg -n "$NAMESPACE" --timeout=180s
STATUS=$(kubectl get cluster winkey-pg -n "$NAMESPACE" -o jsonpath='{.status.phase}')
echo "Cluster status phase: $STATUS"
if [ "$STATUS" != "Cluster in healthy state" ]; then
    echo "ERROR: Cluster is not in healthy state: $STATUS" >&2
    exit 1
fi
echo "SUCCESS: PostgreSQL cluster winkey-pg is Healthy."

echo ""
echo "=========================================================================="
echo " 2. Database Migrations Status"
echo "=========================================================================="
PG_POD=$(kubectl get pod -n "$NAMESPACE" -l "cnpg.io/cluster=winkey-pg,cnpg.io/instanceRole=primary" -o jsonpath='{.items[0].metadata.name}')
echo "Querying schema_migrations on primary pod $PG_POD..."
MIG_INFO=$(kubectl exec -n "$NAMESPACE" "$PG_POD" -c postgres -- psql -U postgres -d winkey -t -A -c "SELECT version, dirty FROM schema_migrations;")
echo "schema_migrations: $MIG_INFO"
MIG_VER=$(echo "$MIG_INFO" | cut -d'|' -f1)
MIG_DIRTY=$(echo "$MIG_INFO" | cut -d'|' -f2)

if [ "$MIG_VER" -lt 15 ] || [ "$MIG_DIRTY" != "f" ]; then
    echo "ERROR: Migrations not complete or dirty: version=$MIG_VER, dirty=$MIG_DIRTY" >&2
    exit 1
fi
echo "SUCCESS: Database migrated to version $MIG_VER (dirty=$MIG_DIRTY)."

echo ""
echo "=========================================================================="
echo " 3. Database Role Grants & Schema Isolation (db/README.md)"
echo "=========================================================================="
echo "Test 3.1: auth_svc can read auth.users..."
kubectl exec -n "$NAMESPACE" "$PG_POD" -c postgres -- psql -U postgres -d winkey -c "SET ROLE auth_svc; SELECT count(*) FROM auth.users;" >/dev/null
echo "  PASS: auth_svc queried auth.users."

echo "Test 3.2: media_svc can read auth.public_profiles..."
kubectl exec -n "$NAMESPACE" "$PG_POD" -c postgres -- psql -U postgres -d winkey -c "SET ROLE media_svc; SELECT count(*) FROM auth.public_profiles;" >/dev/null
echo "  PASS: media_svc queried auth.public_profiles."

echo "Test 3.3: media_svc CANNOT read auth.users (Must Fail)..."
if kubectl exec -n "$NAMESPACE" "$PG_POD" -c postgres -- psql -U postgres -d winkey -c "SET ROLE media_svc; SELECT count(*) FROM auth.users;" >/dev/null 2>&1; then
    echo "ERROR: media_svc was able to SELECT from auth.users!" >&2
    exit 1
fi
echo "  PASS: media_svc SELECT on auth.users was denied (Permission Denied)."

echo "Test 3.4: social_svc can read auth.public_profiles..."
kubectl exec -n "$NAMESPACE" "$PG_POD" -c postgres -- psql -U postgres -d winkey -c "SET ROLE social_svc; SELECT count(*) FROM auth.public_profiles;" >/dev/null
echo "  PASS: social_svc queried auth.public_profiles."

echo "Test 3.5: social_svc CANNOT read auth.users (Must Fail)..."
if kubectl exec -n "$NAMESPACE" "$PG_POD" -c postgres -- psql -U postgres -d winkey -c "SET ROLE social_svc; SELECT count(*) FROM auth.users;" >/dev/null 2>&1; then
    echo "ERROR: social_svc was able to SELECT from auth.users!" >&2
    exit 1
fi
echo "  PASS: social_svc SELECT on auth.users was denied (Permission Denied)."

echo "Test 3.6: analytics_svc can read analytics.video_daily..."
kubectl exec -n "$NAMESPACE" "$PG_POD" -c postgres -- psql -U postgres -d winkey -c "SET ROLE analytics_svc; SELECT count(*) FROM analytics.video_daily;" >/dev/null
echo "  PASS: analytics_svc queried analytics.video_daily."

echo "Test 3.7: analytics_svc CANNOT read media.videos (Must Fail)..."
if kubectl exec -n "$NAMESPACE" "$PG_POD" -c postgres -- psql -U postgres -d winkey -c "SET ROLE analytics_svc; SELECT count(*) FROM media.videos;" >/dev/null 2>&1; then
    echo "ERROR: analytics_svc was able to SELECT from media.videos!" >&2
    exit 1
fi
echo "  PASS: analytics_svc SELECT on media.videos was denied (Permission Denied)."

echo "Test 3.8: media_svc can read analytics.video_daily..."
kubectl exec -n "$NAMESPACE" "$PG_POD" -c postgres -- psql -U postgres -d winkey -c "SET ROLE media_svc; SELECT count(*) FROM analytics.video_daily;" >/dev/null
echo "  PASS: media_svc queried analytics.video_daily."
echo "SUCCESS: Database RBAC and isolation rules verified."


echo ""
echo "=========================================================================="
echo " 4. NATS JetStream Streams Configuration"
echo "=========================================================================="
kubectl delete pod nats-verifier -n "$NAMESPACE" --ignore-not-found >/dev/null 2>&1 || true

cat << 'EOF' | kubectl apply -n "$NAMESPACE" -f -
apiVersion: v1
kind: Pod
metadata:
  name: nats-verifier
  labels:
    app.kubernetes.io/name: nats-verifier
    app.kubernetes.io/part-of: winkey
spec:
  restartPolicy: Never
  containers:
  - name: verifier
    image: natsio/nats-box:0.14.5
    command: ["sh", "-c", "sleep 300"]
    env:
    - name: NATS_PORT
      value: "4222"
    - name: ADMIN_PWD
      valueFrom:
        secretKeyRef:
          name: nats-admin-creds
          key: password
    - name: AUTH_PWD
      valueFrom:
        secretKeyRef:
          name: nats-auth
          key: auth_password
    - name: UPLOAD_PWD
      valueFrom:
        secretKeyRef:
          name: nats-auth
          key: upload_password
    - name: TRANSCODER_PWD
      valueFrom:
        secretKeyRef:
          name: nats-auth
          key: transcoder_password
    - name: VIDEO_PWD
      valueFrom:
        secretKeyRef:
          name: nats-auth
          key: video_password
    - name: SOCIAL_PWD
      valueFrom:
        secretKeyRef:
          name: nats-auth
          key: social_password
    - name: REALTIME_PWD
      valueFrom:
        secretKeyRef:
          name: nats-auth
          key: realtime_password
    - name: ANALYTICS_PWD
      valueFrom:
        secretKeyRef:
          name: nats-auth
          key: analytics_password
EOF

kubectl wait --for=condition=Ready pod/nats-verifier -n "$NAMESPACE" --timeout=60s

echo "Listing JetStream streams:"
kubectl exec -n "$NAMESPACE" nats-verifier -- sh -c 'nats stream ls --server="nats://admin:${ADMIN_PWD}@nats:4222"'

for s in VIDEO USER SOCIAL DLQ ANALYTICS; do
    echo "Checking stream $s..."
    kubectl exec -n "$NAMESPACE" nats-verifier -- sh -c "nats stream info \"$s\" --server=\"nats://admin:\${ADMIN_PWD}@nats:4222\"" >/dev/null
done
echo "SUCCESS: Streams VIDEO, USER, SOCIAL, DLQ, ANALYTICS exist and are healthy."

echo ""
echo "=========================================================================="
echo " 5. NATS Service Authorization Matrix (contracts/events/README.md)"
echo "=========================================================================="
echo "Test 5.1: auth user publishes to user.registered..."
kubectl exec -n "$NAMESPACE" nats-verifier -- sh -c 'nats pub "user.registered" "test-user-reg" --server="nats://auth:${AUTH_PWD}@nats:4222"' >/dev/null
echo "  PASS: auth user published to user.registered."

echo "Test 5.2: auth user CANNOT publish to video.uploaded (Must Fail)..."
if kubectl exec -n "$NAMESPACE" nats-verifier -- sh -c 'nats pub "video.uploaded" "test-exploit" --server="nats://auth:${AUTH_PWD}@nats:4222"' >/dev/null 2>&1; then
    echo "ERROR: auth user was able to publish to video.uploaded!" >&2
    exit 1
fi
echo "  PASS: auth user blocked from video.uploaded (Authorization Violation)."

echo "Test 5.3: upload user publishes to video.uploaded..."
kubectl exec -n "$NAMESPACE" nats-verifier -- sh -c 'nats pub "video.uploaded" "test-upload" --server="nats://upload:${UPLOAD_PWD}@nats:4222"' >/dev/null
echo "  PASS: upload user published to video.uploaded."

echo "Test 5.4: upload user CANNOT publish to social.comment.created (Must Fail)..."
if kubectl exec -n "$NAMESPACE" nats-verifier -- sh -c 'nats pub "social.comment.created" "test-exploit" --server="nats://upload:${UPLOAD_PWD}@nats:4222"' >/dev/null 2>&1; then
    echo "ERROR: upload user was able to publish to social.comment.created!" >&2
    exit 1
fi
echo "  PASS: upload user blocked from social.comment.created (Authorization Violation)."

echo "Test 5.5: transcoder user publishes to video.ready..."
kubectl exec -n "$NAMESPACE" nats-verifier -- sh -c 'nats pub "video.ready" "test-ready" --server="nats://transcoder:${TRANSCODER_PWD}@nats:4222"' >/dev/null
echo "  PASS: transcoder user published to video.ready."

echo "Test 5.6: video user publishes to video.moderated..."
kubectl exec -n "$NAMESPACE" nats-verifier -- sh -c 'nats pub "video.moderated" "test-moderated" --server="nats://video:${VIDEO_PWD}@nats:4222"' >/dev/null
echo "  PASS: video user published to video.moderated."

echo "Test 5.7: social user publishes to social.comment.created..."
kubectl exec -n "$NAMESPACE" nats-verifier -- sh -c 'nats pub "social.comment.created" "test-comment" --server="nats://social:${SOCIAL_PWD}@nats:4222"' >/dev/null
echo "  PASS: social user published to social.comment.created."

echo "Test 5.8: realtime user subscribes to video.ready..."
kubectl exec -n "$NAMESPACE" nats-verifier -- sh -c '
  nats sub --count=1 "video.ready" --server="nats://realtime:${REALTIME_PWD}@nats:4222" > /tmp/sub_rt.log 2>&1 &
  SUB_PID=$!
  sleep 1
  nats pub "video.ready" "test-realtime-sub" --server="nats://transcoder:${TRANSCODER_PWD}@nats:4222" >/dev/null
  wait $SUB_PID
  grep -q "test-realtime-sub" /tmp/sub_rt.log
'
echo "  PASS: realtime user subscribed and received message from video.ready."

echo "Test 5.9: realtime user CANNOT subscribe to video.uploaded (Must Fail)..."
if kubectl exec -n "$NAMESPACE" nats-verifier -- sh -c 'nats sub --count=1 "video.uploaded" --server="nats://realtime:${REALTIME_PWD}@nats:4222"' >/dev/null 2>&1; then
    echo "ERROR: realtime user was able to subscribe to video.uploaded!" >&2
    exit 1
fi
echo "  PASS: realtime user blocked from video.uploaded (Permissions Violation)."

echo "Test 5.10: transcoder user subscribes to video.uploaded..."
kubectl exec -n "$NAMESPACE" nats-verifier -- sh -c '
  nats sub --count=1 "video.uploaded" --server="nats://transcoder:${TRANSCODER_PWD}@nats:4222" > /tmp/sub_tc.log 2>&1 &
  SUB_PID=$!
  sleep 1
  nats pub "video.uploaded" "test-tc-sub" --server="nats://upload:${UPLOAD_PWD}@nats:4222" >/dev/null
  wait $SUB_PID
  grep -q "test-tc-sub" /tmp/sub_tc.log
'
echo "  PASS: transcoder user subscribed and received message from video.uploaded."

echo "Test 5.11: transcoder user CANNOT subscribe to social.comment.created (Must Fail)..."
if kubectl exec -n "$NAMESPACE" nats-verifier -- sh -c 'nats sub --count=1 "social.comment.created" --server="nats://transcoder:${TRANSCODER_PWD}@nats:4222"' >/dev/null 2>&1; then
    echo "ERROR: transcoder user was able to subscribe to social.comment.created!" >&2
    exit 1
fi
echo "  PASS: transcoder user blocked from social.comment.created (Permissions Violation)."

echo "Test 5.12: social user subscribes to video.ready..."
kubectl exec -n "$NAMESPACE" nats-verifier -- sh -c '
  nats sub --count=1 "video.ready" --server="nats://social:${SOCIAL_PWD}@nats:4222" > /tmp/sub_soc.log 2>&1 &
  SUB_PID=$!
  sleep 1
  nats pub "video.ready" "test-soc-sub" --server="nats://transcoder:${TRANSCODER_PWD}@nats:4222" >/dev/null
  wait $SUB_PID
  grep -q "test-soc-sub" /tmp/sub_soc.log
'
echo "  PASS: social user subscribed and received message from video.ready."

echo "Test 5.13: social user CANNOT subscribe to video.uploaded (Must Fail)..."
if kubectl exec -n "$NAMESPACE" nats-verifier -- sh -c 'nats sub --count=1 "video.uploaded" --server="nats://social:${SOCIAL_PWD}@nats:4222"' >/dev/null 2>&1; then
    echo "ERROR: social user was able to subscribe to video.uploaded!" >&2
    exit 1
fi
echo "  PASS: social user blocked from video.uploaded (Permissions Violation)."

echo "Test 5.14: video user publishes to analytics.playback (R1 telemetry)..."
kubectl exec -n "$NAMESPACE" nats-verifier -- sh -c 'nats pub "analytics.playback" "test-playback" --server="nats://video:${VIDEO_PWD}@nats:4222"' >/dev/null
echo "  PASS: video user published to analytics.playback."

echo "Test 5.15: analytics user can inspect stream ANALYTICS..."
kubectl exec -n "$NAMESPACE" nats-verifier -- sh -c 'nats stream info "ANALYTICS" --server="nats://analytics:${ANALYTICS_PWD}@nats:4222"' >/dev/null
echo "  PASS: analytics user inspected stream ANALYTICS."

echo "Test 5.16: analytics user CANNOT publish to video.uploaded (Must Fail)..."
if kubectl exec -n "$NAMESPACE" nats-verifier -- sh -c 'nats pub "video.uploaded" "test-exploit" --server="nats://analytics:${ANALYTICS_PWD}@nats:4222"' >/dev/null 2>&1; then
    echo "ERROR: analytics user was able to publish to video.uploaded!" >&2
    exit 1
fi
echo "  PASS: analytics user blocked from video.uploaded (Permissions Violation)."

echo "Test 5.17: analytics user CANNOT publish to user.registered (Must Fail)..."
if kubectl exec -n "$NAMESPACE" nats-verifier -- sh -c 'nats pub "user.registered" "test-exploit" --server="nats://analytics:${ANALYTICS_PWD}@nats:4222"' >/dev/null 2>&1; then
    echo "ERROR: analytics user was able to publish to user.registered!" >&2
    exit 1
fi
echo "  PASS: analytics user blocked from user.registered (Permissions Violation)."

echo "Test 5.18: analytics user CANNOT subscribe to video.ready (Must Fail)..."
if kubectl exec -n "$NAMESPACE" nats-verifier -- sh -c 'nats sub --count=1 "video.ready" --server="nats://analytics:${ANALYTICS_PWD}@nats:4222"' >/dev/null 2>&1; then
    echo "ERROR: analytics user was able to subscribe to video.ready!" >&2
    exit 1
fi
echo "  PASS: analytics user blocked from video.ready (Permissions Violation)."
echo "Test 5.19: transcoder user CANNOT ack on stream SOCIAL (Must Fail)..."
if kubectl exec -n "$NAMESPACE" nats-verifier -- sh -c 'nats pub "\$JS.ACK.SOCIAL.social.123" "" --server="nats://transcoder:${TRANSCODER_PWD}@nats:4222"' >/dev/null 2>&1; then
    echo "ERROR: transcoder user was able to publish ack to stream SOCIAL!" >&2
    exit 1
fi
echo "  PASS: transcoder user blocked from acking on stream SOCIAL (Permissions Violation)."

echo "Test 5.20: transcoder user CANNOT subscribe to SOCIAL advisories (Must Fail)..."
if kubectl exec -n "$NAMESPACE" nats-verifier -- sh -c 'nats sub --count=1 "\$JS.EVENT.ADVISORY.CONSUMER.*.SOCIAL.>" --server="nats://transcoder:${TRANSCODER_PWD}@nats:4222"' >/dev/null 2>&1; then
    echo "ERROR: transcoder user was able to subscribe to SOCIAL advisories!" >&2
    exit 1
fi
echo "  PASS: transcoder user blocked from SOCIAL advisories (Permissions Violation)."
echo "SUCCESS: NATS publish and subscribe authorization matrix strictly enforced."

kubectl delete pod nats-verifier -n "$NAMESPACE" --grace-period=0 --force --ignore-not-found >/dev/null 2>&1 || true

echo ""
echo "=========================================================================="
echo " 6. Valkey 8 Configuration & Policy"
echo "=========================================================================="
VALKEY_PWD=$(kubectl get secret valkey-auth -n "$NAMESPACE" -o jsonpath='{.data.password}' | base64 -d)
echo "Checking Valkey PING..."
PING_RESP=$(kubectl exec -n "$NAMESPACE" valkey-0 -- valkey-cli -a "$VALKEY_PWD" ping 2>/dev/null)
echo "PING response: $PING_RESP"
if [ "$PING_RESP" != "PONG" ]; then
    echo "ERROR: Valkey ping failed: $PING_RESP" >&2
    exit 1
fi

echo "Checking Valkey maxmemory-policy..."
POLICY=$(kubectl exec -n "$NAMESPACE" valkey-0 -- valkey-cli -a "$VALKEY_PWD" config get maxmemory-policy 2>/dev/null | tail -n 1)
echo "maxmemory-policy: $POLICY"
if [ "$POLICY" != "volatile-lru" ]; then
    echo "ERROR: Expected maxmemory-policy volatile-lru, got: $POLICY" >&2
    exit 1
fi
echo "SUCCESS: Valkey is running with volatile-lru."

echo ""
echo "=========================================================================="
echo " 7. CloudNativePG Backup to Garage Object Storage"
echo "=========================================================================="
BACKUP_NAME="test-backup-$(date +%s)"
echo "Triggering on-demand backup: $BACKUP_NAME..."

if command -v kubectl-cnpg >/dev/null 2>&1; then
    kubectl-cnpg backup winkey-pg -n "$NAMESPACE" --backup-name="$BACKUP_NAME"
else
    cat <<EOF | kubectl apply -n "$NAMESPACE" -f -
apiVersion: postgresql.cnpg.io/v1
kind: Backup
metadata:
  name: ${BACKUP_NAME}
spec:
  cluster:
    name: winkey-pg
EOF
fi

echo "Waiting for backup to complete..."
kubectl wait --for=jsonpath='{.status.phase}'=completed backup/"$BACKUP_NAME" -n "$NAMESPACE" --timeout=180s
echo "SUCCESS: Backup $BACKUP_NAME completed successfully."

echo "Verifying backup artifacts in Garage S3 (winkey-pg-backup)..."
kubectl delete pod s3-backup-verify -n "$NAMESPACE" --grace-period=0 --force --ignore-not-found >/dev/null 2>&1 || true

cat << 'EOF' | kubectl apply -n "$NAMESPACE" -f -
apiVersion: v1
kind: Pod
metadata:
  name: s3-backup-verify
  labels:
    app.kubernetes.io/name: s3-backup-verify
    app.kubernetes.io/part-of: winkey
spec:
  restartPolicy: Never
  containers:
  - name: verifier
    image: alpine/k8s:1.32.0
    command: ["sh", "-c", "sleep 120"]
    env:
    - name: AWS_ACCESS_KEY_ID
      valueFrom:
        secretKeyRef:
          name: garage-key-pg-backup
          key: AWS_ACCESS_KEY_ID
    - name: AWS_SECRET_ACCESS_KEY
      valueFrom:
        secretKeyRef:
          name: garage-key-pg-backup
          key: AWS_SECRET_ACCESS_KEY
    - name: AWS_DEFAULT_REGION
      value: "garage"
EOF

kubectl wait --for=condition=Ready pod/s3-backup-verify -n "$NAMESPACE" --timeout=60s
kubectl exec -n "$NAMESPACE" s3-backup-verify -- aws --endpoint-url http://garage-s3:3900 s3 ls s3://winkey-pg-backup/ --recursive
kubectl delete pod s3-backup-verify -n "$NAMESPACE" --grace-period=0 --force --ignore-not-found >/dev/null 2>&1 || true

echo ""
echo "=========================================================================="
echo " 8. NetworkPolicy Isolation & Ingress Controls"
echo "=========================================================================="
kubectl delete pod unauth-test-verifier auth-test-verifier -n "$NAMESPACE" --grace-period=0 --force --ignore-not-found >/dev/null 2>&1 || true

echo "Test 8.1: Pod WITHOUT part-of: winkey label is blocked from data plane..."
cat << 'EOF' | kubectl apply -n "$NAMESPACE" -f -
apiVersion: v1
kind: Pod
metadata:
  name: unauth-test-verifier
  labels:
    app.kubernetes.io/name: unauth-test-verifier
spec:
  restartPolicy: Never
  containers:
  - name: test
    image: busybox:1.36
    command: ["sleep", "120"]
EOF

kubectl wait --for=condition=Ready pod/unauth-test-verifier -n "$NAMESPACE" --timeout=60s

echo "  Testing connection to PostgreSQL (winkey-pg-rw:5432)..."
if kubectl exec -n "$NAMESPACE" unauth-test-verifier -- nc -w 2 -z winkey-pg-rw 5432 >/dev/null 2>&1; then
    echo "ERROR: unauth pod reached PostgreSQL!" >&2
    exit 1
fi
echo "  PASS: PostgreSQL blocked unauthenticated pod (timeout)."

echo "  Testing connection to NATS (nats:4222)..."
if kubectl exec -n "$NAMESPACE" unauth-test-verifier -- nc -w 2 -z nats 4222 >/dev/null 2>&1; then
    echo "ERROR: unauth pod reached NATS!" >&2
    exit 1
fi
echo "  PASS: NATS blocked unauthenticated pod (timeout)."

echo "  Testing connection to Valkey (valkey:6379)..."
if kubectl exec -n "$NAMESPACE" unauth-test-verifier -- nc -w 2 -z valkey 6379 >/dev/null 2>&1; then
    echo "ERROR: unauth pod reached Valkey!" >&2
    exit 1
fi
echo "  PASS: Valkey blocked unauthenticated pod (timeout)."

echo "Test 8.2: Pod WITH part-of: winkey label can connect to data plane..."
cat << 'EOF' | kubectl apply -n "$NAMESPACE" -f -
apiVersion: v1
kind: Pod
metadata:
  name: auth-test-verifier
  labels:
    app.kubernetes.io/name: auth-test-verifier
    app.kubernetes.io/part-of: winkey
spec:
  restartPolicy: Never
  containers:
  - name: test
    image: busybox:1.36
    command: ["sleep", "120"]
EOF

kubectl wait --for=condition=Ready pod/auth-test-verifier -n "$NAMESPACE" --timeout=60s

echo "  Testing connection to PostgreSQL (winkey-pg-rw:5432)..."
kubectl exec -n "$NAMESPACE" auth-test-verifier -- nc -w 3 -z winkey-pg-rw 5432
echo "  PASS: Authorized pod connected to PostgreSQL."

echo "  Testing connection to NATS (nats:4222)..."
kubectl exec -n "$NAMESPACE" auth-test-verifier -- nc -w 3 -z nats 4222
echo "  PASS: Authorized pod connected to NATS."

echo "  Testing connection to Valkey (valkey:6379)..."
kubectl exec -n "$NAMESPACE" auth-test-verifier -- nc -w 3 -z valkey 6379
echo "  PASS: Authorized pod connected to Valkey."

kubectl delete pod unauth-test-verifier auth-test-verifier -n "$NAMESPACE" --grace-period=0 --force --ignore-not-found >/dev/null 2>&1 || true
echo "SUCCESS: NetworkPolicy strictly enforces pod isolation."

echo ""
echo "=========================================================================="
echo " All Winkey Data Plane Verification Checks PASSED!"
echo "=========================================================================="

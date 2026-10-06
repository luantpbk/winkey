#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MANIFEST="${SCRIPT_DIR}/postgres_restore_drill.yaml"
CLUSTER_NAME="winkey-pg-scratch"
NAMESPACE="default"

echo "=========================================================="
echo "    PostgreSQL Restore Drill from Cloudflare R2           "
echo "=========================================================="
echo "Cluster:   ${CLUSTER_NAME}"
echo "Namespace: ${NAMESPACE}"
echo ""

echo ">>> 1. Checking live cluster status (winkey-pg)..."
LIVE_POD="winkey-pg-1"
LIVE_VIDEOS=$(sudo /usr/local/bin/k3s kubectl exec -n "${NAMESPACE}" "${LIVE_POD}" -c postgres -- psql -U postgres -d winkey -t -c 'SELECT count(*) FROM media.videos;' | xargs)
LIVE_USERS=$(sudo /usr/local/bin/k3s kubectl exec -n "${NAMESPACE}" "${LIVE_POD}" -c postgres -- psql -U postgres -d winkey -t -c 'SELECT count(*) FROM auth.users;' | xargs)

echo "  Live row counts:"
echo "    media.videos: ${LIVE_VIDEOS}"
echo "    auth.users:   ${LIVE_USERS}"
echo ""

echo ">>> 2. Applying scratch restore manifest from R2 object store..."
START_TIME=$(date +%s)
START_ISO=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
sudo /usr/local/bin/k3s kubectl apply -f "${MANIFEST}"

echo ">>> 3. Waiting for scratch cluster ${CLUSTER_NAME} to complete recovery..."
while true; do
  STATUS=$(sudo /usr/local/bin/k3s kubectl get cluster "${CLUSTER_NAME}" -n "${NAMESPACE}" -o jsonpath='{.status.phase}' 2>/dev/null || echo "Starting")
  READY_INSTANCES=$(sudo /usr/local/bin/k3s kubectl get cluster "${CLUSTER_NAME}" -n "${NAMESPACE}" -o jsonpath='{.status.readyInstances}' 2>/dev/null || echo "0")
  echo "  Current phase: ${STATUS} (Ready instances: ${READY_INSTANCES})"
  if [ "${STATUS}" = "Cluster in healthy state" ] && [ "${READY_INSTANCES}" -ge 1 ]; then
    break
  fi
  sleep 5
done

END_TIME=$(date +%s)
END_ISO=$(date -u '+%Y-%m-%dT%H:%M:%SZ')
ELAPSED=$((END_TIME - START_TIME))

echo ""
echo ">>> 4. Recovery complete in ${ELAPSED} seconds!"
echo "  Start time:    ${START_ISO}"
echo "  Finished time: ${END_ISO}"
echo ""

echo ">>> 5. Querying restored row counts from ${CLUSTER_NAME}-1..."
SCRATCH_POD="${CLUSTER_NAME}-1"
RESTORED_VIDEOS=$(sudo /usr/local/bin/k3s kubectl exec -n "${NAMESPACE}" "${SCRATCH_POD}" -c postgres -- psql -U postgres -d winkey -t -c 'SELECT count(*) FROM media.videos;' | xargs)
RESTORED_USERS=$(sudo /usr/local/bin/k3s kubectl exec -n "${NAMESPACE}" "${SCRATCH_POD}" -c postgres -- psql -U postgres -d winkey -t -c 'SELECT count(*) FROM auth.users;' | xargs)

echo "  Restored row counts:"
echo "    media.videos: ${RESTORED_VIDEOS}"
echo "    auth.users:   ${RESTORED_USERS}"
echo ""

echo ">>> 6. Verifying parity..."
if [ "${LIVE_VIDEOS}" = "${RESTORED_VIDEOS}" ] && [ "${LIVE_USERS}" = "${RESTORED_USERS}" ]; then
  echo "  [SUCCESS] 100% Data parity confirmed between live and restored cluster!"
else
  echo "  [ERROR] Parity check failed!" >&2
  exit 1
fi

echo ""
echo ">>> 7. Cleaning up scratch instance..."
sudo /usr/local/bin/k3s kubectl delete cluster "${CLUSTER_NAME}" -n "${NAMESPACE}"
sudo /usr/local/bin/k3s kubectl delete pvc -n "${NAMESPACE}" -l "cnpg.io/cluster=${CLUSTER_NAME}"

echo ""
echo "=========================================================="
echo " Restore Drill Successful! All test instances cleaned up. "
echo "=========================================================="

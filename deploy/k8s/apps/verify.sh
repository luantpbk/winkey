#!/usr/bin/env bash
# In-cluster verification script for Winkey Application Plane (I2)
set -euo pipefail

export PATH="/usr/local/bin:$PATH"
if [ -f /etc/rancher/k3s/k3s.yaml ] && [ -z "${KUBECONFIG:-}" ]; then
    export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
fi

NAMESPACE="${1:-default}"

echo "=========================================================================="
echo " 1. Checking Deployments and Pod Readiness"
echo "=========================================================================="
for svc in auth-svc upload-svc video-svc social-svc realtime-svc web-svc; do
    echo "Checking rollout of deployment $svc..."
    kubectl rollout status deployment/"$svc" -n "$NAMESPACE" --timeout=120s
done
echo "SUCCESS: All 6 application deployments rolled out successfully."

echo ""
echo "=========================================================================="
echo " 2. Pod Health & Readiness Probes Check"
echo "=========================================================================="
kubectl get pods -n "$NAMESPACE" -l 'app.kubernetes.io/part-of=winkey' -o wide

for svc in auth upload video social realtime web; do
    pod=$(kubectl get pod -n "$NAMESPACE" -l "app.kubernetes.io/name=${svc}-svc" -o jsonpath='{.items[0].metadata.name}')
    echo -n "Checking pod $pod (${svc}): "
    ready=$(kubectl get pod "$pod" -n "$NAMESPACE" -o jsonpath='{.status.containerStatuses[0].ready}')
    if [ "$ready" != "true" ]; then
        echo "NOT READY!" >&2
        exit 1
    fi
    echo "Ready = true."
done
echo "SUCCESS: All application pods are Ready."

echo ""
echo "=========================================================================="
echo " 3. Total Resource Requests Breakdown"
echo "=========================================================================="
kubectl get pods -n "$NAMESPACE" -l 'app.kubernetes.io/part-of=winkey' -o custom-columns='NAME:.metadata.name,CPU_REQ:.spec.containers[*].resources.requests.cpu,MEM_REQ:.spec.containers[*].resources.requests.memory,CPU_LIM:.spec.containers[*].resources.limits.cpu,MEM_LIM:.spec.containers[*].resources.limits.memory'

echo ""
echo "=========================================================================="
echo " 4. OAuth Configuration Check (/v1/auth/oauth/google)"
echo "=========================================================================="
AUTH_IP=$(kubectl get svc auth-svc -n "$NAMESPACE" -o jsonpath='{.spec.clusterIP}' 2>/dev/null || true)
OAUTH_RESP=""
if [ -n "$AUTH_IP" ]; then
    OAUTH_RESP=$(curl -s -i "http://${AUTH_IP}:3001/v1/auth/oauth/google" 2>/dev/null || true)
fi
if [ -z "$OAUTH_RESP" ]; then
    OAUTH_RESP=$(curl -s -i "https://winkey.vn/v1/auth/oauth/google" 2>/dev/null || true)
fi

LOCATION_HEADER=$(echo "$OAUTH_RESP" | grep -i '^location:' | head -n1 | tr -d '\r')

if [ -z "$LOCATION_HEADER" ]; then
    echo "ERROR: /v1/auth/oauth/google did not return a Location header!" >&2
    exit 1
fi

if echo "$LOCATION_HEADER" | grep -qE '[?&]client_id=[^& ]+'; then
    echo "PASS: /v1/auth/oauth/google redirect Location contains non-empty client_id."
else
    echo "ERROR: /v1/auth/oauth/google redirect Location is missing non-empty client_id!" >&2
    exit 1
fi
echo "SUCCESS: Google OAuth redirect verified."

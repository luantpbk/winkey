#!/bin/sh
set -eu

NATS_SERVER="${NATS_SERVER:-nats:4222}"

echo "Waiting for NATS JetStream at ${NATS_SERVER}..."
READY=0
for i in $(seq 1 30); do
    if nats stream ls --server="$NATS_SERVER" >/dev/null 2>&1; then
        READY=1
        break
    fi
    sleep 1
done

if [ "$READY" -ne 1 ]; then
    echo "ERROR: Failed to connect to NATS JetStream at ${NATS_SERVER}" >&2
    exit 1
fi

create_or_update_stream() {
    NAME="$1"
    SUBJECT="$2"
    AGE="$3"
    cat <<EOF > "/tmp/${NAME}.json"
{
  "name": "${NAME}",
  "subjects": ["${SUBJECT}"],
  "retention": "limits",
  "max_consumers": -1,
  "max_msgs": -1,
  "max_bytes": -1,
  "discard": "old",
  "max_age": ${AGE},
  "storage": "file",
  "num_replicas": 1,
  "duplicate_window": 120000000000
}
EOF
    if nats stream info "$NAME" --server="$NATS_SERVER" >/dev/null 2>&1; then
        echo "Stream $NAME exists, updating..."
        nats stream edit "$NAME" --server="$NATS_SERVER" --config="/tmp/${NAME}.json" -f
    else
        echo "Creating stream $NAME..."
        nats stream add "$NAME" --server="$NATS_SERVER" --config="/tmp/${NAME}.json"
    fi
}

# VIDEO stream: video.> file storage, 1 replica, max age 7d (604800s), dupe window 2m (120s)
create_or_update_stream "VIDEO" "video.>" 604800000000000

# USER stream: user.> file storage, 1 replica, max age 7d (604800s), dupe window 2m (120s)
create_or_update_stream "USER" "user.>" 604800000000000

# DLQ stream: dlq.> file storage, 1 replica, max age 30d (2592000s), dupe window 2m (120s)
create_or_update_stream "DLQ" "dlq.>" 2592000000000000

echo "NATS streams configured successfully:"
nats stream ls --server="$NATS_SERVER"

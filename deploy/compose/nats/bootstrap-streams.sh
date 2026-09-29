#!/bin/sh
set -eu

NATS_SERVER="${NATS_SERVER:-nats:4222}"

echo "Waiting for NATS server at ${NATS_SERVER}..."
until nats server ping -s "$NATS_SERVER" >/dev/null 2>&1; do
    sleep 1
done

echo "NATS connected. Creating JetStream streams (replicas 1 in dev)..."

# VIDEO stream: video.> file storage, 1 replica, max age 7d, dupe window 2m
nats stream add VIDEO \
    --server="$NATS_SERVER" \
    --subjects="video.>" \
    --storage=file \
    --replicas=1 \
    --max-age=7d \
    --dupe-window=2m \
    --retention=limits \
    --discard=old 2>/dev/null || \
nats stream edit VIDEO \
    --server="$NATS_SERVER" \
    --subjects="video.>" \
    --storage=file \
    --replicas=1 \
    --max-age=7d \
    --dupe-window=2m \
    --retention=limits \
    --discard=old -f

# USER stream: user.> file storage, 1 replica, max age 7d, dupe window 2m
nats stream add USER \
    --server="$NATS_SERVER" \
    --subjects="user.>" \
    --storage=file \
    --replicas=1 \
    --max-age=7d \
    --dupe-window=2m \
    --retention=limits \
    --discard=old 2>/dev/null || \
nats stream edit USER \
    --server="$NATS_SERVER" \
    --subjects="user.>" \
    --storage=file \
    --replicas=1 \
    --max-age=7d \
    --dupe-window=2m \
    --retention=limits \
    --discard=old -f

# DLQ stream: dlq.> file storage, 1 replica, max age 30d, dupe window 2m
nats stream add DLQ \
    --server="$NATS_SERVER" \
    --subjects="dlq.>" \
    --storage=file \
    --replicas=1 \
    --max-age=30d \
    --dupe-window=2m \
    --retention=limits \
    --discard=old 2>/dev/null || \
nats stream edit DLQ \
    --server="$NATS_SERVER" \
    --subjects="dlq.>" \
    --storage=file \
    --replicas=1 \
    --max-age=30d \
    --dupe-window=2m \
    --retention=limits \
    --discard=old -f

echo "NATS streams configured successfully:"
nats stream ls --server="$NATS_SERVER"

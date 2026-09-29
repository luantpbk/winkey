FROM dxflrs/garage:v1.0.1 AS garage-bin
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    awscli \
    jq \
    && rm -rf /var/lib/apt/lists/*

COPY --from=garage-bin /garage /usr/local/bin/garage
COPY bootstrap.sh /bootstrap.sh
RUN chmod +x /bootstrap.sh

ENTRYPOINT ["/bootstrap.sh"]

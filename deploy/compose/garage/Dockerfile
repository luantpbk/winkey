FROM dxflrs/garage:v1.0.1 AS garage-bin
FROM alpine:3.21

RUN apk add --no-cache curl bash aws-cli jq

COPY --from=garage-bin /garage /usr/local/bin/garage
COPY bootstrap.sh /bootstrap.sh
RUN chmod +x /bootstrap.sh

ENTRYPOINT ["/bootstrap.sh"]

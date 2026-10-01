# Build context: the repository root (the service depends on libs/go).
#   docker buildx build --platform linux/amd64,linux/arm64 -f services/analytics/Dockerfile .
# Built with GOWORK=off: the module stands alone (go.work is not copied).
FROM --platform=$BUILDPLATFORM golang:1.26 AS build
ARG TARGETOS TARGETARCH
ENV GOWORK=off
WORKDIR /src
COPY libs/go/go.mod libs/go/go.sum libs/go/
COPY services/analytics/go.mod services/analytics/go.sum services/analytics/
RUN cd services/analytics && go mod download
COPY libs/go libs/go
COPY services/analytics services/analytics
RUN cd services/analytics && CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" -o /out/analytics-worker ./cmd/analytics-worker

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/analytics-worker /analytics-worker
USER nonroot:nonroot
# db/clickhouse/*.sql is mounted at /migrations (CLICKHOUSE_MIGRATIONS_DIR), never baked into the image.
EXPOSE 8081
ENTRYPOINT ["/analytics-worker"]

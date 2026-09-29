# Build context: the repository root (the service depends on libs/go).
#   docker buildx build --platform linux/amd64,linux/arm64 -f services/upload/Dockerfile .
FROM --platform=$BUILDPLATFORM golang:1.24 AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY libs/go/go.mod libs/go/go.sum libs/go/
COPY services/upload/go.mod services/upload/go.sum services/upload/
RUN cd services/upload && go mod download
COPY libs/go libs/go
COPY services/upload services/upload
RUN cd services/upload && CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" -o /out/upload ./cmd/upload

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/upload /upload
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/upload"]

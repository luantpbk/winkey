# Build context: the repository root (the service depends on libs/go).
#   docker buildx build --platform linux/amd64,linux/arm64 -f services/video/Dockerfile .
FROM --platform=$BUILDPLATFORM golang:1.26 AS build
ARG TARGETOS TARGETARCH
WORKDIR /src
COPY libs/go/go.mod libs/go/go.sum libs/go/
COPY services/video/go.mod services/video/go.sum services/video/
RUN cd services/video && go mod download
COPY libs/go libs/go
COPY services/video services/video
RUN cd services/video && CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH \
    go build -trimpath -ldflags="-s -w" -o /out/video ./cmd/video

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/video /video
USER nonroot:nonroot
EXPOSE 8080
ENTRYPOINT ["/video"]

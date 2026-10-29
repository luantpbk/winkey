# Multi-arch Dockerfile for Winkey chat-svc (linux/amd64 and linux/arm64)
# Build context: repository root
#   docker buildx build --platform linux/amd64,linux/arm64 -f services/chat/Dockerfile .

FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Install pnpm matching repo version
RUN npm install -g pnpm@12.6.0

# Copy root monorepo workspace configuration and lockfile
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./

# Copy packages and service source
COPY packages/metrics ./packages/metrics
COPY services/chat ./services/chat

# Install all workspace dependencies
RUN pnpm install --frozen-lockfile

# Build libraries and chat service
RUN pnpm --filter @winkey/metrics run build
RUN pnpm --filter @winkey/chat run build

# Deploy standalone production bundle
RUN pnpm --filter=@winkey/chat --prod deploy /app/deployed
RUN cp -r /app/services/chat/dist /app/deployed/dist && \
    mkdir -p /app/deployed/node_modules/@winkey/metrics && \
    cp -r /app/packages/metrics/dist /app/deployed/node_modules/@winkey/metrics/dist

# --- Production Runner Stage ---
FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV HTTP_PORT=8003

# Copy deployed application from builder
COPY --from=builder /app/deployed ./

# Run as non-root user (node user has uid 1000)
USER node

EXPOSE 8003

CMD ["node", "dist/index.js"]

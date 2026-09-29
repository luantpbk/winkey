# Multi-arch Dockerfile for Winkey realtime-gw (linux/amd64 and linux/arm64)
# Build context: repository root
#   docker buildx build --platform linux/amd64,linux/arm64 -f services/realtime/Dockerfile .

FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Install pnpm matching repo version
RUN npm install -g pnpm@12.6.0

# Copy root monorepo workspace configuration and lockfile
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml turbo.json ./

# Copy service source and contracts
COPY services/realtime ./services/realtime
COPY contracts/realtime ./contracts/realtime

# Install all workspace dependencies
RUN pnpm install --frozen-lockfile

# Build realtime service
RUN pnpm --filter @winkey/realtime run build

# Deploy standalone production bundle
RUN pnpm --filter=@winkey/realtime --prod deploy /app/deployed
RUN cp -r /app/services/realtime/dist /app/deployed/dist

# --- Production Runner Stage ---
FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV HTTP_PORT=8003

# Copy deployed application and contracts from builder
COPY --from=builder /app/deployed ./
COPY --from=builder /app/contracts/realtime ./contracts/realtime

# Run as non-root user (node user has uid 1000)
USER node

EXPOSE 8003

CMD ["node", "dist/index.js"]

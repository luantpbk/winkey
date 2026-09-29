# Multi-arch Dockerfile for Winkey auth-svc (linux/amd64 and linux/arm64)
# ADR-012: Every image must build for linux/amd64,linux/arm64

FROM node:22-bookworm-slim AS builder

WORKDIR /app

# Enable corepack and install pnpm
RUN corepack enable && corepack prepare pnpm@latest --activate

# Copy outbox package first
COPY packages/outbox /app/packages/outbox
RUN cd /app/packages/outbox && pnpm install --frozen-lockfile=false && pnpm build

# Copy auth-svc package definition
COPY services/auth/package.json services/auth/tsconfig.json /app/services/auth/

WORKDIR /app/services/auth
RUN pnpm install --frozen-lockfile=false

# Copy auth-svc source files
COPY services/auth/src /app/services/auth/src
RUN pnpm build

# --- Production Runner Stage ---
FROM node:22-bookworm-slim AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV HTTP_PORT=8001

# Copy build artifacts and dependencies
COPY --from=builder /app/packages/outbox/dist /app/packages/outbox/dist
COPY --from=builder /app/packages/outbox/package.json /app/packages/outbox/package.json
COPY --from=builder /app/services/auth/dist /app/services/auth/dist
COPY --from=builder /app/services/auth/node_modules /app/services/auth/node_modules
COPY --from=builder /app/services/auth/package.json /app/services/auth/package.json

WORKDIR /app/services/auth

# Run as non-root user (node user has uid 1000)
USER node

EXPOSE 8001

CMD ["node", "dist/index.js"]

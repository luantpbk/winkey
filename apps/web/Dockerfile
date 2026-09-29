# Multi-arch Next.js Dockerfile (linux/amd64, linux/arm64)
# Stage 1: Dependencies
FROM --platform=$BUILDPLATFORM node:22-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app

RUN npm install -g pnpm@12.6.0

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY packages/api-client/package.json ./packages/api-client/
COPY apps/web/package.json ./apps/web/

RUN pnpm install --frozen-lockfile

# Stage 2: Builder
FROM --platform=$BUILDPLATFORM node:22-alpine AS builder
WORKDIR /app
RUN npm install -g pnpm@12.6.0

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/packages/api-client/node_modules ./packages/api-client/node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules

COPY contracts ./contracts
COPY packages/api-client ./packages/api-client
COPY apps/web ./apps/web
COPY package.json pnpm-workspace.yaml ./

ENV STANDALONE=1
ENV NEXT_TELEMETRY_DISABLED=1

RUN pnpm --filter @winkey/web run build

# Stage 3: Runner (Multi-arch target)
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV HOSTNAME="0.0.0.0"

# Non-root user (per ADR-012 and AGENTS.md DoD)
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nextjs

# Copy standalone build and public static files
COPY --from=builder /app/apps/web/public ./apps/web/public
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/standalone ./
COPY --from=builder --chown=nextjs:nodejs /app/apps/web/.next/static ./apps/web/.next/static

USER nextjs

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/healthz || exit 1

CMD ["node", "apps/web/server.js"]

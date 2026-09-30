# Winkey Web (`apps/web`)

Next.js App Router (RSC) web frontend for Winkey video streaming platform.

## Stack

- **Framework**: Next.js 15 (App Router, Server Components)
- **UI & Styling**: React 19, Tailwind CSS v4, Lucide Icons
- **Data Fetching**: TanStack Query (React Query)
- **Internationalization**: `next-intl` (Vietnamese default, English)
- **Video Player**: HLS.js with native HLS Safari fallback
- **Realtime**: WebSocket client with single-use ticket lifecycle, backoff + jitter, room ref-counting, AJV schema validation, and toast notifications
- **Mocks**: Mock Service Worker (MSW) with typed fixtures from `@winkey/api-client`
- **Testing**: Vitest, React Testing Library, Playwright (E2E)

## Routes

- `/`: Home video feed with responsive grid, infinite scroll cursor pagination, and skeleton loaders.
- `/watch/[id]`: Video playback page with SSR metadata, Open Graph tags, channel info, and expandable description.
- `/c/[handle]`: Channel profile header and uploaded videos grid.
- `/login`, `/register`: Authentication forms mapping RFC 9457 `Problem.errors` to fields, plus Google OAuth button.
- `/upload`: Resumable multipart uploader for creators with parallel uploads (≤ 4), exponential backoff, speed/ETA tracking, and reload recovery via IndexedDB.
- `/studio`: Creator Studio table listing videos with live WebSocket updates (`upload:{id}` rooms), real-time progress bars, status transitions, and slow fallback poll (30s) only when disconnected.
- `/healthz`, `/readyz`: Service health and readiness probes.

## Environment Variables

| Variable | Description | Default |
|---|---|---|
| `NEXT_PUBLIC_API_MOCKS` | Enable MSW mock handlers for backend-less dev/testing (`1` = enabled) | `1` |
| `NEXT_PUBLIC_API_URL` | Winkey API origin (Traefik gateway in dev) | `http://localhost:8080` |
| `NEXT_PUBLIC_WS_URL` | Realtime WebSocket gateway origin | `ws://localhost:8080/v1/realtime` |
| `NEXT_PUBLIC_MEDIA_BASE_URL` | Media cache base URL for HLS segments | `https://media.winkey.vn` |
| `PORT` | HTTP port for Next.js server | `3000` |

## Getting Started

```bash
# Install dependencies
pnpm install

# Start development server with MSW mocks enabled
pnpm --filter @winkey/web run dev

# Run unit & component tests
pnpm --filter @winkey/web run test

# Typecheck
pnpm --filter @winkey/web run typecheck

# Production build
pnpm --filter @winkey/web run build
```

## Docker

Build multi-arch image:

```bash
docker build -t winkey-web:latest -f apps/web/Dockerfile .
```

# @winkey/api-client

Typed TypeScript clients and domain models generated from Winkey OpenAPI 3.1 contracts (`contracts/openapi/*.v1.yaml`).

## Features

- Fully typed endpoints and parameters powered by `openapi-fetch` and `openapi-typescript`.
- Automatic schema resolution and cross-referencing from `common.yaml` (UUIDv7, RFC 9457 Problem, User, Video, etc.).
- Built-in `createAuthInterceptor` middleware for non-intrusive bearer token injection from memory.
- Stale detection script that fails CI if OpenAPI contracts change without updating generated TypeScript definitions.

## Installation

```bash
pnpm add @winkey/api-client
```

## Usage

```typescript
import { createWinkeyClient, createAuthClient } from '@winkey/api-client';

// With custom token getter (memory only)
const client = createWinkeyClient({
  baseUrl: 'https://winkey.vn',
  getAccessToken: () => tokenStore.get(),
});

// Access auth endpoints
const { data, error } = await client.auth.POST('/v1/auth/login', {
  body: {
    email: 'user@example.com',
    password: 'password123',
  },
});

// Access video feed
const { data: feed } = await client.video.GET('/v1/videos', {
  params: {
    query: { limit: 20 },
  },
});
```

## Scripts

- `pnpm run generate`: Regenerate TypeScript types from `contracts/openapi/*.v1.yaml`.
- `pnpm run check:generated`: Check if generated files on disk are up to date with contracts (fails with code 1 if stale).
- `pnpm run typecheck`: Run TypeScript compiler validation.
- `pnpm run test`: Run Vitest unit tests.

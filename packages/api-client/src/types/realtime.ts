export interface paths {
    "/v1/realtime/ticket": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Issue a single-use ticket for opening the WebSocket.
         * @description The ticket is valid for 30 seconds and can be redeemed once. It is stored in Valkey under
         *     `rt:ticket:{sha256(ticket)}` with the caller's user id and roles, and deleted atomically when
         *     the WebSocket upgrade redeems it. Rate limit per user: 30 tickets per minute.
         */
        post: operations["createRealtimeTicket"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/realtime": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * WebSocket upgrade.
         * @description Without `ticket` the connection is anonymous and can only join `video:*` rooms of videos the
         *     public can read. With an invalid, expired or already used ticket the upgrade is refused with
         *     `401` before switching protocols. After `101`, frames follow `contracts/realtime/*.schema.json`.
         */
        get: operations["openRealtime"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        RealtimeTicket: {
            /**
             * @description Opaque, URL-safe, at least 256 bits of randomness. Never logged.
             * @example 6oJrJZ0gk3v1wz7r1p6Vx3m9w8u2QHc4Ljq7bN5sT0Y
             */
            ticket: string;
            /**
             * Format: date-time
             * @example 2026-09-29T12:00:30Z
             */
            expires_at: string;
        };
        /** @description RFC 9457 problem details. Content type `application/problem+json`. */
        Problem: {
            /**
             * Format: uri-reference
             * @description Stable identifier of the error kind, e.g. `/problems/validation`.
             */
            type: string;
            title: string;
            status: number;
            detail?: string;
            instance?: string;
            /** @description Machine-readable error code, SCREAMING_SNAKE_CASE (e.g. `UPLOAD_TOO_LARGE`). */
            code?: string;
            /** @description Field-level validation errors. */
            errors?: {
                field: string;
                message: string;
            }[];
        };
    };
    responses: {
        /** @description Missing or invalid credentials. */
        Unauthorized: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Rate limit exceeded. See `Retry-After`. */
        TooManyRequests: {
            headers: {
                "Retry-After"?: number;
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Validation failed. */
        BadRequest: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
    };
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    createRealtimeTicket: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Ticket issued. */
            201: {
                headers: {
                    "Cache-Control"?: "no-store";
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["RealtimeTicket"];
                };
            };
            401: components["responses"]["Unauthorized"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    openRealtime: {
        parameters: {
            query?: {
                ticket?: string;
            };
            header: {
                Upgrade: "websocket";
            };
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Switching protocols; the server sends a `welcome` message first. */
            101: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            429: components["responses"]["TooManyRequests"];
        };
    };
}

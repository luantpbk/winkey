export interface paths {
    "/v1/uploads": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Start an upload. Requires role `creator` (except `purpose = SOCIAL`).
         * @description SOC-2b (ADR-049): `purpose: SOCIAL` starts a short video for a post. Any signed-in user may do it (no `creator`
         *     role); the video is created `UNLISTED` whatever `visibility` says; `size_bytes` ≤ 314572800 (300 MiB) else `400`
         *     code `VIDEO_TOO_LARGE`. The transcoder fails a social video longer than 180 s with `error` code `TOO_LONG`
         *     (`video.failed`). Social uploads count against the same quotas as films. The rest of the flow (parts,
         *     complete, progress, `getUpload`) is unchanged.
         */
        post: operations["createUpload"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/uploads/{video_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
            };
            cookie?: never;
        };
        /** Upload / processing status (owner only). Used for polling when realtime is unavailable. */
        get: operations["getUpload"];
        put?: never;
        post?: never;
        /** Abort an upload that is still `UPLOADING` (owner only). Deletes the video row. */
        delete: operations["abortUpload"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/uploads/{video_id}/parts": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Presign part upload URLs (owner only, status `UPLOADING`). Can be called again to resume. */
        post: operations["presignParts"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/uploads/{video_id}/complete": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Complete the multipart upload (owner only). Idempotent once `UPLOADED`. */
        post: operations["completeUpload"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/images": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Start an image upload — returns one presigned PUT URL (task SOC-1b).
         * @description Creates the `media.images` row (`UPLOADING`) and a presigned `PUT` (TTL 15 min) on the public raw-bucket
         *     endpoint for `{owner_id}/images/{image_id}`. The signature covers `Content-Type` and `Content-Length`, so
         *     the browser must send exactly `content_type` and `size_bytes`.
         */
        post: operations["createImageUpload"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/images/{image_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                image_id: components["parameters"]["ImageId"];
            };
            cookie?: never;
        };
        /**
         * An image of the caller and its processing state (task SOC-1b).
         * @description Another user's image → `404`.
         */
        get: operations["getImage"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/images/{image_id}/complete": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                image_id: components["parameters"]["ImageId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Mark an image uploaded; processing starts (task SOC-1b).
         * @description The image must be the caller's and `UPLOADING` (`409` code `INVALID_STATE` otherwise; `404` if unknown).
         *     upload-svc checks with `HEAD` that the object exists and its size equals `size_bytes` (`409` code
         *     `UPLOAD_INCOMPLETE` otherwise), then in one transaction sets `PROCESSING` and writes `media.image_uploaded`
         *     to the outbox. Idempotent for an image already `PROCESSING`, `READY` or `FAILED` (returns it as is).
         */
        post: operations["completeImageUpload"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/uploads/{video_id}/audio-tracks": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Start uploading an extra audio track for a video (owner with role `creator`, task MUX1).
         * @description Requires role `creator` like `createUpload` (ROLE1, ADR-046): without it `403`, before anything is read.
         *     The video must exist and not be `DELETED` (it may still be processing). At most 8 extra tracks per video
         *     and one per (`lang`, `kind`): a duplicate answers `409` `AUDIO_TRACK_EXISTS`, a ninth `409`
         *     `TOO_MANY_AUDIO_TRACKS`. The new track is `UPLOADING` until completed; it counts toward the upload quotas
         *     like a video upload.
         */
        post: operations["createAudioTrackUpload"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/uploads/{video_id}/audio-tracks/{track_id}": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
                track_id: components["parameters"]["TrackId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Abort an audio track upload that is still `UPLOADING` (owner only). */
        delete: operations["abortAudioTrackUpload"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/uploads/{video_id}/audio-tracks/{track_id}/parts": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
                track_id: components["parameters"]["TrackId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Presign part upload URLs for an audio track (owner only, track `UPLOADING`). Can be called again to resume. */
        post: operations["presignAudioTrackParts"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/v1/uploads/{video_id}/audio-tracks/{track_id}/complete": {
        parameters: {
            query?: never;
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
                track_id: components["parameters"]["TrackId"];
            };
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Complete an audio track upload (owner only). Idempotent once `UPLOADED`; writes `video.audio_uploaded`. */
        post: operations["completeAudioTrackUpload"];
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
        CreateUploadRequest: {
            title: string;
            /** @default  */
            description: string;
            visibility?: components["schemas"]["Visibility"];
            filename: string;
            /**
             * @description Advisory only; the transcoder validates the real container with ffprobe.
             * @enum {string}
             */
            content_type: "video/mp4" | "video/quicktime" | "video/webm" | "video/x-matroska";
            /** Format: int64 */
            size_bytes: number;
            /** @description Defaults to `FILM` (task SOC-2b). */
            purpose?: components["schemas"]["VideoPurpose"];
        };
        CreateUploadResponse: {
            video_id: components["schemas"]["Uuid"];
            /**
             * Format: int64
             * @description Bytes per part. Every part except the last must be exactly this size.
             */
            part_size: number;
            part_count: number;
        };
        CreateAudioTrackUploadRequest: {
            lang: components["schemas"]["LangTag"];
            /** @description Shown in the player's audio menu, e.g. `Thuyết minh`. */
            label: string;
            kind: components["schemas"]["AudioTrackKind"];
            /** @description Absent means `false`. Selected first by players; setting it clears it on the video's other tracks. */
            is_default?: boolean;
            filename: string;
            /**
             * @description Advisory only; the transcoder validates the real stream with ffprobe.
             * @enum {string}
             */
            content_type: "audio/wav" | "audio/x-wav" | "audio/flac" | "audio/mp4" | "audio/x-m4a" | "audio/aac" | "audio/ogg" | "audio/webm";
            /** Format: int64 */
            size_bytes: number;
        };
        CreateAudioTrackUploadResponse: {
            track_id: components["schemas"]["Uuid"];
            /**
             * Format: int64
             * @description Bytes per part, same rule as `createUpload`.
             */
            part_size: number;
            part_count: number;
        };
        PresignPartsRequest: {
            part_numbers: number[];
        };
        PresignPartsResponse: {
            urls: {
                part_number: number;
                /** Format: uri */
                url: string;
            }[];
            /** Format: date-time */
            expires_at: string;
        };
        CompleteUploadRequest: {
            parts: {
                part_number: number;
                etag: string;
            }[];
        };
        UploadStatus: {
            video_id: components["schemas"]["Uuid"];
            status: components["schemas"]["VideoStatus"];
            /** @description Transcoding progress of the latest job; 0 before processing starts. */
            progress: number;
            error: string | null;
        };
        /** @enum {string} */
        ImagePurpose: "AVATAR" | "BANNER" | "POST";
        CreateImageUploadRequest: {
            purpose: components["schemas"]["ImagePurpose"];
            /**
             * @description Advisory; the transcoder trusts only ffprobe.
             * @enum {string}
             */
            content_type: "image/jpeg" | "image/png" | "image/webp" | "image/avif";
            /** Format: int64 */
            size_bytes: number;
        };
        CreateImageUploadResponse: {
            image_id: components["schemas"]["Uuid"];
            /** Format: uri */
            upload_url: string;
            /** @description Headers the `PUT` must send exactly (`Content-Type`; browsers set `Content-Length` themselves). */
            upload_headers: {
                [key: string]: string;
            };
            /** Format: date-time */
            expires_at: string;
        };
        /** @enum {string} */
        ImageStatus: "UPLOADING" | "PROCESSING" | "READY" | "FAILED";
        Image: {
            id: components["schemas"]["Uuid"];
            purpose: components["schemas"]["ImagePurpose"];
            status: components["schemas"]["ImageStatus"];
            /**
             * Format: uri
             * @description Public URL of `image.webp` once READY.
             */
            url: string | null;
            /** Format: uri */
            thumb_url: string | null;
            width: number | null;
            height: number | null;
            /**
             * @description Set when FAILED. `INVALID_INPUT` means the file is not a usable still image.
             * @enum {string|null}
             */
            error: "INVALID_INPUT" | "STORAGE_ERROR" | "INTERNAL" | null;
            /** Format: date-time */
            created_at: string;
        };
        /**
         * @description Until task SEC1 (signed cookies) ships, PRIVATE/UNLISTED only affect listings and API reads;
         *     media URLs are unguessable but not access-controlled.
         * @enum {string}
         */
        Visibility: "PUBLIC" | "UNLISTED" | "PRIVATE";
        /**
         * @description `FILM`: a video of the catalogue (every video before SOC-2b). `SOCIAL`: a short video uploaded for a post (task
         *     SOC-2b, ADR-049): at most 3 minutes and 300 MiB, encoded to 720p + 360p only, always `UNLISTED`.
         * @enum {string}
         */
        VideoPurpose: "FILM" | "SOCIAL";
        /**
         * Format: uuid
         * @description UUIDv7 generated by the owning service.
         * @example 0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c0d
         */
        Uuid: string;
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
        /** @enum {string} */
        VideoStatus: "UPLOADING" | "UPLOADED" | "PROCESSING" | "READY" | "FAILED";
        /**
         * @description BCP 47 language tag, lowercase language + optional uppercase region (`vi`, `en`, `zh-TW`).
         * @example vi
         */
        LangTag: string;
        /**
         * @description `original`: the film's own language; `dub`: dubbed dialogue; `voiceover`: narration mixed over the original
         *     sound (thuyết minh); `commentary`: an extra talk track. Every track is a complete mix (ADR-042).
         * @enum {string}
         */
        AudioTrackKind: "original" | "dub" | "voiceover" | "commentary";
        AudioTrack: {
            id: components["schemas"]["Uuid"];
            lang: components["schemas"]["LangTag"];
            label: string;
            kind: components["schemas"]["AudioTrackKind"];
            is_default: boolean;
            /**
             * @description Only `READY` tracks are in the HLS master and in `Playback.audio_tracks`.
             * @enum {string}
             */
            status: "UPLOADING" | "UPLOADED" | "PROCESSING" | "READY" | "FAILED";
            /** @description Why the encode failed (`FAILED` only), e.g. `AUDIO_DURATION_MISMATCH`. */
            error: string | null;
            /** Format: date-time */
            updated_at: string;
        };
    };
    responses: {
        /** @description Validation failed. */
        BadRequest: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Missing or invalid credentials. */
        Unauthorized: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Authenticated but not allowed. */
        Forbidden: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Resource does not exist or is not visible to the caller. */
        NotFound: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
        /** @description Resource is in a state that does not allow this operation. */
        Conflict: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                "application/problem+json": components["schemas"]["Problem"];
            };
        };
    };
    parameters: {
        ImageId: components["schemas"]["Uuid"];
        TrackId: components["schemas"]["Uuid"];
        VideoId: components["schemas"]["Uuid"];
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    createUpload: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateUploadRequest"];
            };
        };
        responses: {
            /** @description Upload started. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreateUploadResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            /** @description Upload quota exceeded (code `UPLOAD_QUOTA_EXCEEDED`). See the quota rules above and `Retry-After`. */
            429: {
                headers: {
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getUpload: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Current status. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UploadStatus"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    abortUpload: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Aborted. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    presignParts: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PresignPartsRequest"];
            };
        };
        responses: {
            /** @description Presigned URLs. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PresignPartsResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    completeUpload: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CompleteUploadRequest"];
            };
        };
        responses: {
            /** @description Upload accepted; transcoding is queued. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["UploadStatus"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    createImageUpload: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateImageUploadRequest"];
            };
        };
        responses: {
            /** @description Upload started. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreateImageUploadResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            /** @description Image quota exceeded (code `UPLOAD_QUOTA_EXCEEDED`). */
            429: {
                headers: {
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    getImage: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                image_id: components["parameters"]["ImageId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description The image. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Image"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
        };
    };
    completeImageUpload: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                image_id: components["parameters"]["ImageId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Processing. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Image"];
                };
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    createAudioTrackUpload: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CreateAudioTrackUploadRequest"];
            };
        };
        responses: {
            /** @description Upload started. */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["CreateAudioTrackUploadResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            /** @description Upload quota exceeded (code `UPLOAD_QUOTA_EXCEEDED`), as for `createUpload`. */
            429: {
                headers: {
                    "Retry-After"?: number;
                    [name: string]: unknown;
                };
                content: {
                    "application/problem+json": components["schemas"]["Problem"];
                };
            };
        };
    };
    abortAudioTrackUpload: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
                track_id: components["parameters"]["TrackId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Aborted. */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    presignAudioTrackParts: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
                track_id: components["parameters"]["TrackId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["PresignPartsRequest"];
            };
        };
        responses: {
            /** @description Presigned URLs. */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["PresignPartsResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    completeAudioTrackUpload: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                video_id: components["parameters"]["VideoId"];
                track_id: components["parameters"]["TrackId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                "application/json": components["schemas"]["CompleteUploadRequest"];
            };
        };
        responses: {
            /** @description Accepted; the audio encode is queued. */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["AudioTrack"];
                };
            };
            400: components["responses"]["BadRequest"];
            401: components["responses"]["Unauthorized"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
}

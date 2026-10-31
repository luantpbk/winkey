import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Env } from '../config/env.js';

/**
 * Ciphertext of SOC-3b attachments in the private `winkey-chat` bucket. Object keys never carry a file name.
 * Never log presigned URLs or object keys: log attachment ids and sizes only.
 */
export interface AttachmentStorage {
  /** A presigned PUT that accepts exactly `sizeBytes` bytes of application/octet-stream. */
  presignPut(
    key: string,
    sizeBytes: number,
    expiresInSeconds: number,
  ): Promise<{ url: string; headers: Record<string, string> }>;
  presignGet(key: string, expiresInSeconds: number): Promise<string>;
  /** The stored object's size, or null when it does not exist. */
  headSize(key: string): Promise<number | null>;
  deleteObject(key: string): Promise<void>;
  /** Deletes up to any number of keys, at most 1 000 per request. Returns the keys that failed. */
  deleteObjects(keys: string[]): Promise<string[]>;
}

export const ATTACHMENT_CONTENT_TYPE = 'application/octet-stream';

export function attachmentObjectKey(conversationId: string, attachmentId: string): string {
  return `c/${conversationId}/${attachmentId}`;
}

export class S3AttachmentStorage implements AttachmentStorage {
  constructor(
    private readonly client: S3Client,
    /** Used only to presign, so URLs carry the origin browsers can reach. */
    private readonly presignClient: S3Client,
    private readonly bucket: string,
  ) {}

  async presignPut(key: string, sizeBytes: number, expiresInSeconds: number) {
    const command = new PutObjectCommand({
      Bucket: this.bucket,
      Key: key,
      ContentLength: sizeBytes,
      ContentType: ATTACHMENT_CONTENT_TYPE,
    });
    const url = await getSignedUrl(this.presignClient, command, {
      expiresIn: expiresInSeconds,
      // Both headers are part of the signature, so the PUT must send exactly this size and type.
      signableHeaders: new Set(['content-length', 'content-type']),
    });
    return {
      url,
      headers: { 'Content-Type': ATTACHMENT_CONTENT_TYPE, 'Content-Length': String(sizeBytes) },
    };
  }

  async presignGet(key: string, expiresInSeconds: number): Promise<string> {
    return getSignedUrl(
      this.presignClient,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      {
        expiresIn: expiresInSeconds,
      },
    );
  }

  async headSize(key: string): Promise<number | null> {
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return res.ContentLength ?? null;
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === 'NotFound' || e.$metadata?.httpStatusCode === 404) return null;
      throw err;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async deleteObjects(keys: string[]): Promise<string[]> {
    const failed: string[] = [];
    for (let i = 0; i < keys.length; i += 1000) {
      const batch = keys.slice(i, i + 1000);
      try {
        const res = await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
          }),
        );
        for (const e of res.Errors ?? []) if (e.Key) failed.push(e.Key);
      } catch {
        failed.push(...batch);
      }
    }
    return failed;
  }
}

/** Null when the bucket is not configured: the service still starts and the attachment endpoints answer 503. */
export function createAttachmentStorage(env: Env): AttachmentStorage | null {
  if (!env.CHAT_S3_ENDPOINT || !env.CHAT_S3_ACCESS_KEY_ID || !env.CHAT_S3_SECRET_ACCESS_KEY) {
    return null;
  }
  const make = (endpoint: string) =>
    new S3Client({
      endpoint,
      region: env.CHAT_S3_REGION,
      forcePathStyle: true,
      // SDK >= 3.729 adds a CRC32 of the (empty) presign-time body to PUT URLs, so every browser upload of real
      // bytes failed with "Invalid digest". Ciphertext integrity is the client's AES-GCM tag + SHA-256.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
      credentials: {
        accessKeyId: env.CHAT_S3_ACCESS_KEY_ID!,
        secretAccessKey: env.CHAT_S3_SECRET_ACCESS_KEY!,
      },
    });
  const client = make(env.CHAT_S3_ENDPOINT);
  const presignClient = env.CHAT_S3_PUBLIC_ENDPOINT ? make(env.CHAT_S3_PUBLIC_ENDPOINT) : client;
  return new S3AttachmentStorage(client, presignClient, env.CHAT_S3_BUCKET);
}

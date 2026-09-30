import { type NatsConnection, type Subscription, DeliverPolicy, type JsMsg } from 'nats';
import type { ConnectionManager } from '../websocket/connection-manager.js';

export interface EventEnvelope<T = Record<string, unknown>> {
  event_id: string;
  type: string;
  version: number;
  occurred_at: string;
  producer: string;
  data: T;
}

export interface VideoProgressData {
  video_id: string;
  owner_id: string;
  job_id: string;
  stage: 'DOWNLOADING' | 'PROBING' | 'TRANSCODING' | 'UPLOADING';
  percent: number;
}

export interface VideoReadyData {
  video_id: string;
  owner_id: string;
}

export interface VideoFailedData {
  video_id: string;
  owner_id: string;
  reason: 'INVALID_INPUT' | 'TIMEOUT' | 'ENCODER_ERROR' | 'STORAGE_ERROR' | 'INTERNAL';
  message: string;
  retryable: boolean;
}

export interface CommentCreatedData {
  comment_id: string;
  video_id: string;
  video_owner_id: string;
  author_id: string;
  parent_id: string | null;
  parent_author_id: string | null;
  body: string;
  created_at: string;
}

export interface LikeChangedData {
  video_id: string;
  user_id: string;
  liked: boolean;
  like_count: number;
}

export interface SubscriptionChangedData {
  subscriber_id: string;
  channel_id: string;
  subscribed: boolean;
  subscriber_count: number;
}

export interface NatsConsumerOptions {
  nats: NatsConnection;
  connectionManager: ConnectionManager;
  logger?: {
    info: (obj: Record<string, unknown> | string, msg?: string) => void;
    warn: (obj: Record<string, unknown> | string, msg?: string) => void;
    error: (obj: Record<string, unknown> | string, msg?: string) => void;
  };
}

export class RealtimeEventConsumer {
  private readonly nats: NatsConnection;
  private readonly connectionManager: ConnectionManager;
  private readonly logger: NatsConsumerOptions['logger'];

  private isRunning = false;
  private isVideoConsumerReady = false;
  private isSocialConsumerReady = false;
  private coreSub: Subscription | null = null;
  private videoConsumerIter: { stop(): void } | null = null;
  private socialConsumerIter: { stop(): void } | null = null;

  constructor(options: NatsConsumerOptions) {
    this.nats = options.nats;
    this.connectionManager = options.connectionManager;
    this.logger = options.logger;
  }

  isReady(): boolean {
    return this.isVideoConsumerReady && this.isSocialConsumerReady;
  }

  async start(): Promise<void> {
    if (this.isRunning) return;
    this.isRunning = true;

    // 1. Core NATS subscription: rt.video.*.progress
    this.setupCoreSub();

    // 2. Start JetStream consumers with auto-retry
    const videoPromise = this.setupVideoConsumer();
    const socialPromise = this.setupSocialConsumer();

    // Await up to 500ms so isReady is true immediately if streams already exist
    await Promise.race([
      Promise.all([videoPromise, socialPromise]),
      new Promise((r) => setTimeout(r, 500)),
    ]);
  }

  private setupCoreSub(): void {
    try {
      this.coreSub = this.nats.subscribe('rt.video.*.progress');
      (async () => {
        if (!this.coreSub) return;
        for await (const msg of this.coreSub) {
          if (!this.isRunning) break;
          try {
            const raw = new TextDecoder().decode(msg.data);
            const env = JSON.parse(raw) as EventEnvelope<VideoProgressData>;
            this.handleVideoProgress(env);
          } catch (err) {
            this.logger?.warn({ err }, 'Error handling core NATS progress message');
          }
        }
      })();
      this.logger?.info({}, 'Subscribed to core NATS rt.video.*.progress');
    } catch (err) {
      this.logger?.error({ err }, 'Failed to subscribe to core NATS progress');
    }
  }

  private async setupVideoConsumer(): Promise<void> {
    const js = this.nats.jetstream();
    let delayMs = 1000;

    while (this.isRunning && !this.isVideoConsumerReady) {
      try {
        const videoConsumer = await js.consumers.get('VIDEO', {
          filterSubjects: ['video.ready', 'video.failed'],
          deliver_policy: DeliverPolicy.New,
        });
        const videoMessages = await videoConsumer.consume();
        this.videoConsumerIter = videoMessages;
        this.isVideoConsumerReady = true;
        this.logger?.info({}, 'Started ephemeral ordered consumer on stream VIDEO');

        (async () => {
          try {
            for await (const m of videoMessages) {
              if (!this.isRunning) break;
              this.handleJetStreamMessage(m);
            }
          } catch (err) {
            this.logger?.warn({ err }, 'VIDEO consumer iteration error');
          } finally {
            this.isVideoConsumerReady = false;
            if (this.isRunning) {
              void this.setupVideoConsumer();
            }
          }
        })();
        break;
      } catch (err) {
        this.logger?.warn(
          { err, retryInMs: delayMs },
          'Could not start ephemeral consumer on stream VIDEO; retrying',
        );
        if (!this.isRunning) break;
        await new Promise((r) => setTimeout(r, delayMs));
        delayMs = Math.min(delayMs * 2, 30000);
      }
    }
  }

  private async setupSocialConsumer(): Promise<void> {
    const js = this.nats.jetstream();
    let delayMs = 1000;

    while (this.isRunning && !this.isSocialConsumerReady) {
      try {
        const socialConsumer = await js.consumers.get('SOCIAL', {
          filterSubjects: [
            'social.comment.created',
            'social.video.like_changed',
            'social.subscription.changed',
          ],
          deliver_policy: DeliverPolicy.New,
        });
        const socialMessages = await socialConsumer.consume();
        this.socialConsumerIter = socialMessages;
        this.isSocialConsumerReady = true;
        this.logger?.info({}, 'Started ephemeral ordered consumer on stream SOCIAL');

        (async () => {
          try {
            for await (const m of socialMessages) {
              if (!this.isRunning) break;
              this.handleJetStreamMessage(m);
            }
          } catch (err) {
            this.logger?.warn({ err }, 'SOCIAL consumer iteration error');
          } finally {
            this.isSocialConsumerReady = false;
            if (this.isRunning) {
              void this.setupSocialConsumer();
            }
          }
        })();
        break;
      } catch (err) {
        this.logger?.warn(
          { err, retryInMs: delayMs },
          'Could not start ephemeral consumer on stream SOCIAL; retrying',
        );
        if (!this.isRunning) break;
        await new Promise((r) => setTimeout(r, delayMs));
        delayMs = Math.min(delayMs * 2, 30000);
      }
    }
  }

  private handleVideoProgress(env: EventEnvelope<VideoProgressData>): void {
    if (env.version !== 1) {
      this.logger?.warn(
        { version: env.version, type: env.type },
        'Ignoring event with unknown version',
      );
      return;
    }

    const data = env.data;
    if (!data || !data.video_id) return;

    this.connectionManager.broadcastEvent(
      `upload:${data.video_id}`,
      'video.progress',
      {
        video_id: data.video_id,
        stage: data.stage,
        percent: data.percent,
      },
      data.owner_id,
    );
  }

  private handleJetStreamMessage(m: JsMsg): void {
    try {
      const raw = new TextDecoder().decode(m.data);
      const env = JSON.parse(raw) as EventEnvelope;

      if (env.version !== 1) {
        this.logger?.warn(
          { version: env.version, type: env.type },
          'Ignoring JetStream event with unknown version',
        );
        return;
      }

      switch (m.subject) {
        case 'video.ready': {
          const data = env.data as unknown as VideoReadyData;
          if (!data || !data.video_id) break;

          // upload:{video_id}
          this.connectionManager.broadcastEvent(
            `upload:${data.video_id}`,
            'video.ready',
            { video_id: data.video_id },
            data.owner_id,
          );

          // user:{owner_id}
          if (data.owner_id) {
            this.connectionManager.broadcastEvent(`user:${data.owner_id}`, 'video.ready', {
              video_id: data.video_id,
            });
          }
          break;
        }

        case 'video.failed': {
          const data = env.data as unknown as VideoFailedData;
          if (!data || !data.video_id) break;

          const failedPayload = {
            video_id: data.video_id,
            reason: data.reason,
            message: data.message,
            retryable: data.retryable,
          };

          // upload:{video_id}
          this.connectionManager.broadcastEvent(
            `upload:${data.video_id}`,
            'video.failed',
            failedPayload,
            data.owner_id,
          );

          // user:{owner_id}
          if (data.owner_id) {
            this.connectionManager.broadcastEvent(
              `user:${data.owner_id}`,
              'video.failed',
              failedPayload,
            );
          }
          break;
        }

        case 'social.comment.created': {
          const data = env.data as unknown as CommentCreatedData;
          if (!data || !data.video_id || !data.comment_id) break;

          const commentRef = {
            comment_id: data.comment_id,
            video_id: data.video_id,
            parent_id: data.parent_id ?? null,
          };

          // video:{video_id}
          this.connectionManager.broadcastEvent(
            `video:${data.video_id}`,
            'comment.created',
            commentRef,
          );

          // If reply and not self-reply: user:{parent_author_id}
          if (data.parent_author_id && data.parent_author_id !== data.author_id) {
            this.connectionManager.broadcastEvent(
              `user:${data.parent_author_id}`,
              'comment.reply',
              commentRef,
            );
          }

          // N2 notification hints (never send to the actor themself):
          // 1. Top-level comment: parent_id null and video_owner_id != author_id -> VIDEO_COMMENT to user:{video_owner_id}
          if (!data.parent_id && data.video_owner_id && data.video_owner_id !== data.author_id) {
            this.connectionManager.broadcastEvent(
              `user:${data.video_owner_id}`,
              'notification.hint',
              { kind: 'VIDEO_COMMENT' },
            );
          }

          // 2. Reply: parent_author_id non-null and parent_author_id != author_id -> COMMENT_REPLY to user:{parent_author_id}
          if (data.parent_author_id && data.parent_author_id !== data.author_id) {
            this.connectionManager.broadcastEvent(
              `user:${data.parent_author_id}`,
              'notification.hint',
              { kind: 'COMMENT_REPLY' },
            );
          }
          break;
        }

        case 'social.video.like_changed': {
          const data = env.data as unknown as LikeChangedData;
          if (!data || !data.video_id) break;

          this.connectionManager.broadcastEvent(`video:${data.video_id}`, 'like.count', {
            video_id: data.video_id,
            like_count: data.like_count,
          });
          break;
        }

        case 'social.subscription.changed': {
          const data = env.data as unknown as SubscriptionChangedData;
          if (!data || !data.channel_id || !data.subscriber_id) break;

          // N2 notification hint: subscribed is true and subscriber_id != channel_id
          // -> NEW_SUBSCRIBER to user:{channel_id}
          // subscribed is false (unsubscribe) -> nothing
          // subscriber_id == channel_id (self-subscribe) -> nothing
          if (data.subscribed && data.subscriber_id !== data.channel_id) {
            this.connectionManager.broadcastEvent(`user:${data.channel_id}`, 'notification.hint', {
              kind: 'NEW_SUBSCRIBER',
            });
          }
          break;
        }

        default:
          this.logger?.warn({ subject: m.subject }, 'Unhandled JetStream subject');
          break;
      }
    } catch (err) {
      this.logger?.error({ err, subject: m.subject }, 'Error processing JetStream message');
    }
  }

  async stop(): Promise<void> {
    this.isRunning = false;
    this.isVideoConsumerReady = false;
    this.isSocialConsumerReady = false;
    if (this.coreSub) {
      this.coreSub.unsubscribe();
      this.coreSub = null;
    }
    if (this.videoConsumerIter) {
      this.videoConsumerIter.stop();
      this.videoConsumerIter = null;
    }
    if (this.socialConsumerIter) {
      this.socialConsumerIter.stop();
      this.socialConsumerIter = null;
    }
  }
}

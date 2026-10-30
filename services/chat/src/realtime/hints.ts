import type { NatsConnection } from 'nats';
import { StringCodec } from 'nats';

const sc = StringCodec();

export type ChatHint =
  | { kind: 'MESSAGE'; conversation_id: string; seq: number }
  | { kind: 'TO_DEVICE' }
  | { kind: 'CONVERSATION'; conversation_id: string }
  | { kind: 'DEVICES'; user_id: string };

export class RealtimeHintDispatcher {
  constructor(
    private readonly ncOrGetter: NatsConnection | (() => NatsConnection | null) | null,
    private readonly logger?: { warn: (obj: unknown, msg: string) => void },
  ) {}

  private getNc(): NatsConnection | null {
    if (typeof this.ncOrGetter === 'function') {
      return this.ncOrGetter();
    }
    return this.ncOrGetter;
  }

  publishHint(userId: string, hint: ChatHint): void {
    const nc = this.getNc();
    if (!nc || nc.isClosed()) return;
    try {
      const subject = `rt.chat.user.${userId}`;
      const payload = JSON.stringify(hint);
      nc.publish(subject, sc.encode(payload));
    } catch (err) {
      // Hints are at-most-once: log and ignore
      this.logger?.warn(
        { err, userId, hintKind: hint.kind },
        'Failed to publish chat hint to NATS',
      );
    }
  }

  publishHints(userIds: Iterable<string>, hint: ChatHint): void {
    for (const userId of userIds) {
      this.publishHint(userId, hint);
    }
  }
}

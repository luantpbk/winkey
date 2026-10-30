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
    private readonly nc: NatsConnection | null,
    private readonly logger?: { warn: (obj: unknown, msg: string) => void },
  ) {}

  publishHint(userId: string, hint: ChatHint): void {
    if (!this.nc || this.nc.isClosed()) return;
    try {
      const subject = `rt.chat.user.${userId}`;
      const payload = JSON.stringify(hint);
      this.nc.publish(subject, sc.encode(payload));
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

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function findRepoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const contractsDir = path.join(dir, 'contracts', 'realtime');
    if (fs.existsSync(contractsDir) && fs.statSync(contractsDir).isDirectory()) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  throw new Error('Repository root (contracts/realtime) not found');
}

export interface ClientSubscribeMessage {
  type: 'subscribe';
  id: string;
  room: string;
}

export interface ClientUnsubscribeMessage {
  type: 'unsubscribe';
  id: string;
  room: string;
}

export interface ClientPingMessage {
  type: 'ping';
  id: string;
}

export type ClientMessage = ClientSubscribeMessage | ClientUnsubscribeMessage | ClientPingMessage;

export interface ServerWelcomeMessage {
  type: 'welcome';
  connection_id: string;
  user_id: string | null;
  heartbeat_interval_ms: number;
}

export interface ServerAckMessage {
  type: 'ack';
  id: string;
}

export interface ServerErrorMessage {
  type: 'error';
  id: string | null;
  code:
    | 'BAD_MESSAGE'
    | 'ROOM_INVALID'
    | 'ROOM_FORBIDDEN'
    | 'AUTH_REQUIRED'
    | 'TOO_MANY_ROOMS'
    | 'RATE_LIMITED';
  message: string;
}

export interface ServerPongMessage {
  type: 'pong';
  id: string;
}

export type ServerEventName =
  | 'video.progress'
  | 'video.ready'
  | 'video.failed'
  | 'comment.created'
  | 'comment.reply'
  | 'like.count';

export interface ServerEventMessage {
  type: 'event';
  room: string;
  event: ServerEventName;
  data: Record<string, unknown>;
  ts: string;
}

export type ServerMessage =
  | ServerWelcomeMessage
  | ServerAckMessage
  | ServerErrorMessage
  | ServerPongMessage
  | ServerEventMessage;

const repoRoot = findRepoRoot();
const clientSchemaPath = path.join(repoRoot, 'contracts', 'realtime', 'client.schema.json');
const serverSchemaPath = path.join(repoRoot, 'contracts', 'realtime', 'server.schema.json');

const clientSchema = JSON.parse(fs.readFileSync(clientSchemaPath, 'utf-8'));
const serverSchema = JSON.parse(fs.readFileSync(serverSchemaPath, 'utf-8'));

import type { ErrorObject } from 'ajv';

const AjvClass = Ajv2020 as unknown as new (
  opts?: Record<string, unknown>,
) => import('ajv').default;
const ajv = new AjvClass({
  strict: false,
  allErrors: true,
});
(addFormats as unknown as (a: unknown) => void)(ajv);

const clientValidator = ajv.compile<ClientMessage>(clientSchema);
const serverValidator = ajv.compile<ServerMessage>(serverSchema);

export function validateClientMessage(data: unknown): {
  valid: boolean;
  message?: ClientMessage;
  error?: string;
} {
  const valid = clientValidator(data);
  if (!valid) {
    const errorText =
      clientValidator.errors?.map((e: ErrorObject) => e.message).join(', ') ||
      'Invalid client message';
    return { valid: false, error: errorText };
  }
  return { valid: true, message: data as ClientMessage };
}

export function validateServerMessage(data: unknown): {
  valid: boolean;
  message?: ServerMessage;
  error?: string;
} {
  const valid = serverValidator(data);
  if (!valid) {
    const errorText =
      serverValidator.errors?.map((e: ErrorObject) => e.message).join(', ') ||
      'Invalid server message';
    return { valid: false, error: errorText };
  }
  return { valid: true, message: data as ServerMessage };
}

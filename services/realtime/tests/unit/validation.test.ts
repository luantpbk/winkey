import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateClientMessage, validateServerMessage } from '../../src/schemas/validation.js';

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
  throw new Error('Repository root not found');
}

describe('Client & Server Schema Validation', () => {
  it('validates all examples in contracts/realtime/examples/client', () => {
    const clientExamplesDir = path.join(
      findRepoRoot(),
      'contracts',
      'realtime',
      'examples',
      'client',
    );
    const files = fs.readdirSync(clientExamplesDir).filter((f) => f.endsWith('.json'));

    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = JSON.parse(fs.readFileSync(path.join(clientExamplesDir, file), 'utf8'));
      const res = validateClientMessage(content);
      expect(res.valid, `Client example ${file} failed validation: ${res.error}`).toBe(true);
    }
  });

  it('validates all examples in contracts/realtime/examples/server', () => {
    const serverExamplesDir = path.join(
      findRepoRoot(),
      'contracts',
      'realtime',
      'examples',
      'server',
    );
    const files = fs.readdirSync(serverExamplesDir).filter((f) => f.endsWith('.json'));

    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const content = JSON.parse(fs.readFileSync(path.join(serverExamplesDir, file), 'utf8'));
      const res = validateServerMessage(content);
      expect(res.valid, `Server example ${file} failed validation: ${res.error}`).toBe(true);
    }
  });

  it('rejects invalid client messages', () => {
    // Missing required fields
    expect(validateClientMessage({ type: 'subscribe' }).valid).toBe(false);

    // Malformed room format
    expect(
      validateClientMessage({
        type: 'subscribe',
        id: '123',
        room: 'invalid-room',
      }).valid,
    ).toBe(false);

    // User rooms are prohibited for client subscribe
    expect(
      validateClientMessage({
        type: 'subscribe',
        id: '123',
        room: 'user:0192f5e4-7c1a-7b3e-9d2a-5f6e7a8b9c01',
      }).valid,
    ).toBe(false);

    // Unknown message type
    expect(
      validateClientMessage({
        type: 'unknown',
        id: '123',
      }).valid,
    ).toBe(false);

    // Extra properties not allowed (additionalProperties: false)
    expect(
      validateClientMessage({
        type: 'ping',
        id: '123',
        extra: 'field',
      }).valid,
    ).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateValidatorCode } from '../scripts/gen-realtime-validator.mjs';
import { validateServerFrame } from '../src/lib/realtime/schema-validator';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const generatedValidatorPath = path.resolve(
  __dirname,
  '../src/lib/realtime/generated-server-validator.js',
);
const schemaValidatorSourcePath = path.resolve(
  __dirname,
  '../src/lib/realtime/schema-validator.ts',
);

describe('Realtime Validator Standalone Compilation & Drift Guard (SOC-1a CSP compliance)', () => {
  it('committed generated-server-validator.js matches generator output (no drift)', async () => {
    expect(fs.existsSync(generatedValidatorPath)).toBe(true);

    const committedContent = fs.readFileSync(generatedValidatorPath, 'utf8');
    const freshGeneratedContent = await generateValidatorCode();

    expect(
      committedContent,
      'generated-server-validator.js has drifted from contracts/realtime/server.schema.json! Run `pnpm gen:realtime-validator` to regenerate.',
    ).toBe(freshGeneratedContent);
  });

  it('schema-validator.ts does not import ajv at runtime (preventing new Function / eval under CSP)', () => {
    const source = fs.readFileSync(schemaValidatorSourcePath, 'utf8');

    expect(source).not.toContain("from 'ajv'");
    expect(source).not.toContain("from 'ajv/");
    expect(source).not.toContain("from 'ajv-formats'");
    expect(source).not.toContain('ajv.compile');
    expect(source).not.toContain('new Function');
    expect(source).toContain("from './generated-server-validator.js'");
  });

  it('validateServerFrame accepts valid welcome frame', () => {
    const welcomeFrame = {
      type: 'welcome',
      connection_id: '0192f5e4-7c1a-7b3e-9d2a-c00000000001',
      user_id: null,
      heartbeat_interval_ms: 15000,
    };

    const res = validateServerFrame(welcomeFrame);
    expect(res.valid).toBe(true);
    expect(res.message).toEqual(welcomeFrame);
    expect(res.error).toBeUndefined();
  });

  it('validateServerFrame accepts valid event frame (comment.created)', () => {
    const eventFrame = {
      type: 'event',
      room: 'video:0192f5e4-7c1a-7b3e-9d2a-c00000000001',
      event: 'comment.created',
      data: {
        comment_id: '0192f5e4-7c1a-7b3e-9d2a-c00000000099',
        video_id: '0192f5e4-7c1a-7b3e-9d2a-c00000000001',
        parent_id: null,
      },
      ts: new Date().toISOString(),
    };

    const res = validateServerFrame(eventFrame);
    expect(res.valid).toBe(true);
    expect(res.message).toEqual(eventFrame);
  });

  it('validateServerFrame rejects non-objects or invalid schemas', () => {
    expect(validateServerFrame(null).valid).toBe(false);
    expect(validateServerFrame('string-frame').valid).toBe(false);
    expect(validateServerFrame({}).valid).toBe(false);

    const invalidUuidFrame = {
      type: 'welcome',
      connection_id: 'not-a-uuid',
      user_id: null,
      heartbeat_interval_ms: 15000,
    };
    const res = validateServerFrame(invalidUuidFrame);
    expect(res.valid).toBe(false);
    expect(res.error).toBeDefined();
  });
});

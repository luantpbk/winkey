import { describe, it, expect, afterAll } from 'vitest';
import { connect, StringCodec } from 'nats';
import { natsOptionsFromUrl } from '../src/nats.js';

describe('natsOptionsFromUrl unit tests', () => {
  it('parses URL without credentials', () => {
    const opts = natsOptionsFromUrl('nats://nats.default.svc:4222');
    expect(opts.servers).toBe('nats://nats.default.svc:4222');
    expect(opts.user).toBeUndefined();
    expect(opts.pass).toBeUndefined();
  });

  it('parses URL with password starting with digits', () => {
    const opts = natsOptionsFromUrl('nats://myuser:123456@nats.default.svc:4222');
    expect(opts.servers).toBe('nats://nats.default.svc:4222');
    expect(opts.user).toBe('myuser');
    expect(opts.pass).toBe('123456');
  });

  it('parses URL with %-escaped characters in password and username', () => {
    const opts = natsOptionsFromUrl('nats://user%20name:p%40ss%25w%C3%B6rd%21@127.0.0.1:4222');
    expect(opts.servers).toBe('nats://127.0.0.1:4222');
    expect(opts.user).toBe('user name');
    expect(opts.pass).toBe('p@ss%wörd!');
  });

  it('parses URL without port', () => {
    const opts = natsOptionsFromUrl('nats://auth:secret@nats-server');
    expect(opts.servers).toBe('nats://nats-server');
    expect(opts.user).toBe('auth');
    expect(opts.pass).toBe('secret');
  });
});

describe('natsOptionsFromUrl integration test (NATS with auth)', () => {
  let stopContainer: (() => Promise<void>) | null = null;
  let natsHost: string | null = null;
  let natsPort: number | null = null;

  afterAll(async () => {
    if (stopContainer) {
      await stopContainer();
    }
  });

  it('connects to NATS server requiring auth using URL with user/pass', async (ctx) => {
    try {
      const { GenericContainer } = await import('testcontainers');
      const container = await new GenericContainer('nats:2.10-alpine')
        .withCommand(['--user', 'testapp', '--pass', '987secr%t!'])
        .withExposedPorts(4222)
        .start();

      natsHost = container.getHost();
      natsPort = container.getMappedPort(4222);
      stopContainer = async () => {
        await container.stop();
      };
    } catch {
      if (process.env.WINKEY_REQUIRE_DOCKER === '1') {
        expect.fail('NATS container required by WINKEY_REQUIRE_DOCKER=1 but unavailable');
      }
      ctx.skip();
      return;
    }

    // 1. Connection with valid credentials encoded in URL succeeds
    const rawUrl = `nats://testapp:987secr%25t!@${natsHost}:${natsPort}`;
    const opts = natsOptionsFromUrl(rawUrl);
    const nc = await connect(opts);
    expect(nc.getServer()).toBeDefined();

    // Verify publish & subscribe work over authenticated connection
    const sc = StringCodec();
    const sub = nc.subscribe('test.auth.check');
    await nc.publish('test.auth.check', sc.encode('hello auth'));
    for await (const msg of sub) {
      expect(sc.decode(msg.data)).toBe('hello auth');
      break;
    }
    await nc.close();

    // 2. Connection without credentials fails
    const noCredsUrl = `nats://${natsHost}:${natsPort}`;
    await expect(connect(natsOptionsFromUrl(noCredsUrl))).rejects.toThrow();

    // 3. Connection with wrong password fails
    const wrongPassUrl = `nats://testapp:wrongpassword@${natsHost}:${natsPort}`;
    await expect(connect(natsOptionsFromUrl(wrongPassUrl))).rejects.toThrow();
  });
});

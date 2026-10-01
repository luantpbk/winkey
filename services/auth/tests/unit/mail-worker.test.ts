import { describe, it, expect, beforeEach, vi } from 'vitest';
import { MailQueueWorker, sanitizeErrorMessage } from '../../src/mail/worker.js';
import { NodeMailerSender } from '../../src/mail/mailer.js';
import { getEnv } from '../../src/config/env.js';
import { createMockDb, createMockStore, type MockStore } from '../fixtures/mock-db.js';

describe('MailQueueWorker', () => {
  let store: MockStore;
  let db: any;

  beforeEach(() => {
    store = createMockStore();
    const mock = createMockDb(store);
    db = mock.db;
  });

  it('sanitizeErrorMessage redacts email addresses and truncates length', () => {
    const err = new Error('SMTP connection failed for user alice@winkey.vn on host mail.winkey.vn');
    const sanitized = sanitizeErrorMessage(err);

    expect(sanitized).toContain('[REDACTED]');
    expect(sanitized).not.toContain('alice@winkey.vn');

    const longError = new Error('A'.repeat(600));
    expect(sanitizeErrorMessage(longError).length).toBe(500);
  });

  it('successfully delivers email, marks sent_at, and clears params', async () => {
    // Add pending email
    store.mail_queue.push({
      id: '1',
      user_id: 'user-1',
      to_email: 'test@winkey.vn',
      template: 'VERIFY_EMAIL',
      locale: 'vi',
      params: { link: 'https://winkey.vn/vi/verify-email?token=123' },
      created_at: new Date(),
      attempts: 0,
      next_attempt_at: new Date(Date.now() - 1000),
      sent_at: null,
      dead_at: null,
      last_error: null,
    });

    const mockSender = {
      sendMail: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const worker = new MailQueueWorker({
      db,
      mailer: mockSender,
      pollIntervalMs: 100,
    });

    const processed = await worker.processBatchOnce();
    expect(processed).toBe(1);
    expect(mockSender.sendMail).toHaveBeenCalledTimes(1);

    const row = store.mail_queue[0];
    expect(row.sent_at).not.toBeNull();
    expect(row.params).toBeNull();
    expect(row.dead_at).toBeNull();
  });

  it('retries with exponential backoff on failure and records last_error', async () => {
    store.mail_queue.push({
      id: '1',
      user_id: 'user-1',
      to_email: 'test@winkey.vn',
      template: 'VERIFY_EMAIL',
      locale: 'vi',
      params: { link: 'https://winkey.vn/vi/verify-email?token=123' },
      created_at: new Date(),
      attempts: 2,
      next_attempt_at: new Date(Date.now() - 1000),
      sent_at: null,
      dead_at: null,
      last_error: null,
    });

    const mockSender = {
      sendMail: vi.fn().mockRejectedValue(new Error('Connection timed out')),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const worker = new MailQueueWorker({
      db,
      mailer: mockSender,
      pollIntervalMs: 100,
    });

    const processed = await worker.processBatchOnce();
    expect(processed).toBe(1);

    const row = store.mail_queue[0];
    expect(row.attempts).toBe(3);
    expect(row.sent_at).toBeNull();
    expect(row.dead_at).toBeNull();
    expect(row.params).not.toBeNull(); // params retained while retrying
    expect(row.last_error).toContain('Connection timed out');

    // 2^3 = 8 minutes backoff
    const expectedNextAttempt = Date.now() + 8 * 60 * 1000;
    expect(Math.abs(row.next_attempt_at.getTime() - expectedNextAttempt)).toBeLessThan(5000);
  });

  it('marks row as dead after 8 attempts and clears params', async () => {
    store.mail_queue.push({
      id: '1',
      user_id: 'user-1',
      to_email: 'test@winkey.vn',
      template: 'RESET_PASSWORD',
      locale: 'en',
      params: { link: 'https://winkey.vn/en/reset-password?token=123' },
      created_at: new Date(),
      attempts: 7, // 7 prior failures, this will be attempt 8
      next_attempt_at: new Date(Date.now() - 1000),
      sent_at: null,
      dead_at: null,
      last_error: null,
    });

    const mockSender = {
      sendMail: vi.fn().mockRejectedValue(new Error('Persistent 550 recipient rejected')),
      close: vi.fn().mockResolvedValue(undefined),
    };

    const worker = new MailQueueWorker({
      db,
      mailer: mockSender,
      pollIntervalMs: 100,
    });

    const processed = await worker.processBatchOnce();
    expect(processed).toBe(1);

    const row = store.mail_queue[0];
    expect(row.attempts).toBe(8);
    expect(row.sent_at).toBeNull();
    expect(row.dead_at).not.toBeNull();
    expect(row.params).toBeNull(); // cleared on dead!
    expect(row.last_error).toContain('Persistent 550');
  });

  it('NodeMailerSender in log mode suppresses mail and logs safely', async () => {
    const logInfo = vi.fn();
    const env = getEnv({
      MAIL_TRANSPORT: 'log',
      JWT_PRIVATE_KEY: 'dummy',
    });

    const sender = new NodeMailerSender(env, {
      info: logInfo,
      warn: vi.fn(),
      error: vi.fn(),
    });

    await sender.sendMail({
      queueId: '42',
      toEmail: 'secret@winkey.vn',
      template: 'RESET_PASSWORD',
      rendered: {
        subject: 'Reset Password',
        text: 'Link: https://secret-token',
        html: '<p>Link</p>',
      },
    });

    expect(logInfo).toHaveBeenCalledWith(
      { queueId: '42', template: 'RESET_PASSWORD', op: 'mail_suppressed' },
      'mail suppressed',
    );
  });
});

import { describe, it, expect } from 'vitest';
import { renderEmail } from '../../src/mail/templates.js';

describe('mail templates', () => {
  const verifyLink =
    'https://winkey.vn/vi/verify-email?token=abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE';
  const resetLink =
    'https://winkey.vn/en/reset-password?token=abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE';

  describe('VERIFY_EMAIL', () => {
    it('renders Vietnamese template containing the link in text and HTML', () => {
      const email = renderEmail('VERIFY_EMAIL', 'vi', { link: verifyLink });

      expect(email.subject).toContain('Xác minh');
      expect(email.text).toContain(verifyLink);
      expect(email.html).toContain(verifyLink);
      expect(email.html).toContain(`<a href="${verifyLink}">`);
    });

    it('renders English template containing the link in text and HTML', () => {
      const email = renderEmail('VERIFY_EMAIL', 'en', { link: verifyLink });

      expect(email.subject).toContain('Verify');
      expect(email.text).toContain(verifyLink);
      expect(email.html).toContain(verifyLink);
      expect(email.html).toContain(`<a href="${verifyLink}">`);
    });
  });

  describe('RESET_PASSWORD', () => {
    it('renders Vietnamese template containing the link in text and HTML', () => {
      const email = renderEmail('RESET_PASSWORD', 'vi', { link: resetLink });

      expect(email.subject).toContain('Đặt lại mật khẩu');
      expect(email.text).toContain(resetLink);
      expect(email.html).toContain(resetLink);
      expect(email.html).toContain(`<a href="${resetLink}">`);
    });

    it('renders English template containing the link in text and HTML', () => {
      const email = renderEmail('RESET_PASSWORD', 'en', { link: resetLink });

      expect(email.subject).toContain('Reset your password');
      expect(email.text).toContain(resetLink);
      expect(email.html).toContain(resetLink);
      expect(email.html).toContain(`<a href="${resetLink}">`);
    });
  });

  describe('PASSWORD_CHANGED', () => {
    it('renders Vietnamese template without any link', () => {
      const email = renderEmail('PASSWORD_CHANGED', 'vi', null);

      expect(email.subject).toContain('Mật khẩu');
      expect(email.text).not.toContain('http');
      expect(email.html).not.toContain('<a ');
    });

    it('renders English template without any link', () => {
      const email = renderEmail('PASSWORD_CHANGED', 'en', null);

      expect(email.subject).toContain('password was changed');
      expect(email.text).not.toContain('http');
      expect(email.html).not.toContain('<a ');
    });
  });

  describe('STEP_UP_CODE', () => {
    const testCode = '654321';

    it('renders Vietnamese template containing the code, 10 min expiry, password change advice, and no link', () => {
      const email = renderEmail('STEP_UP_CODE', 'vi', { code: testCode });

      expect(email.subject).toContain('xác thực');
      expect(email.text).toContain(testCode);
      expect(email.html).toContain(testCode);
      expect(email.text).toContain('10 phút');
      expect(email.html).toContain('10 phút');
      expect(email.text.toLowerCase()).toContain('đổi mật khẩu');
      expect(email.html.toLowerCase()).toContain('đổi mật khẩu');
      expect(email.text).not.toContain('http');
      expect(email.html).not.toContain('<a ');
    });

    it('renders English template containing the code, 10 min expiry, password change advice, and no link', () => {
      const email = renderEmail('STEP_UP_CODE', 'en', { code: testCode });

      expect(email.subject).toContain('verification code');
      expect(email.text).toContain(testCode);
      expect(email.html).toContain(testCode);
      expect(email.text).toContain('10 minutes');
      expect(email.html).toContain('10 minutes');
      expect(email.text.toLowerCase()).toContain('change your password');
      expect(email.html.toLowerCase()).toContain('change your password');
      expect(email.text).not.toContain('http');
      expect(email.html).not.toContain('<a ');
    });
  });
});

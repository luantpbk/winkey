import { describe, it, expect, vi } from 'vitest';
import React from 'react';
import fs from 'node:fs';
import path from 'node:path';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { sanitizeFeedbackUrl } from '../src/lib/feedback';
import { LegalDoc } from '../src/components/legal/legal-doc';
import { CinemaShell } from '../src/components/layout/cinema-shell';
import { Sidebar } from '../src/components/layout/sidebar';
import viMessages from '../messages/vi.json';

// --- Locale Mock ---
vi.mock('next-intl', () => ({
  useTranslations: (namespace?: string) => {
    return (key: string, values?: Record<string, unknown>) => {
      const fullPath = namespace ? `${namespace}.${key}` : key;
      const parts = fullPath.split('.');
      let cur: unknown = viMessages;
      for (const p of parts) {
        if (cur && typeof cur === 'object' && p in cur) {
          cur = (cur as Record<string, unknown>)[p];
        } else {
          return key;
        }
      }
      if (typeof cur === 'string') {
        let res = cur;
        if (values) {
          for (const [k, v] of Object.entries(values)) {
            res = res.replace(new RegExp(`\\{${k}\\}`, 'g'), String(v));
          }
        }
        return res;
      }
      return key;
    };
  },
}));

vi.mock('../src/i18n/routing', () => ({
  routing: {
    locales: ['vi', 'en'],
    defaultLocale: 'vi',
  },
  Link: ({
    children,
    href,
    ...props
  }: {
    children: React.ReactNode;
    href: string;
    [key: string]: unknown;
  }) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn() }),
}));

vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({
    user: null,
    isAuthenticated: false,
    canAccessAdmin: false,
    logout: vi.fn(),
  }),
}));

describe('Task BETA1-web: Legal Documents & Feedback URL (ADR-034)', () => {
  describe('1. Verbatim Copy Integrity Check vs docs/legal/', () => {
    const files = ['terms.vi.md', 'privacy.vi.md', 'community.vi.md'];
    const docsDir = path.resolve(__dirname, '../../../docs/legal');
    const webDir = path.resolve(__dirname, '../content/legal');

    files.forEach((filename) => {
      it(`guarantees apps/web/content/legal/${filename} exactly matches docs/legal/${filename}`, () => {
        const docsPath = path.join(docsDir, filename);
        const webPath = path.join(webDir, filename);

        expect(fs.existsSync(docsPath)).toBe(true);
        expect(fs.existsSync(webPath)).toBe(true);

        const docsContent = fs.readFileSync(docsPath, 'utf-8');
        const webContent = fs.readFileSync(webPath, 'utf-8');

        expect(webContent).toBe(docsContent);
      });
    });
  });

  describe('2. FEEDBACK_URL Sanitization & Safety Logic', () => {
    it('returns null for empty, undefined, whitespace, or invalid values', () => {
      expect(sanitizeFeedbackUrl(undefined)).toBeNull();
      expect(sanitizeFeedbackUrl(null)).toBeNull();
      expect(sanitizeFeedbackUrl('')).toBeNull();
      expect(sanitizeFeedbackUrl('   ')).toBeNull();
    });

    it('rejects non-https and unsafe protocols', () => {
      expect(sanitizeFeedbackUrl('http://insecure.example.com')).toBeNull();
      expect(sanitizeFeedbackUrl('javascript:alert(1)')).toBeNull();
      expect(sanitizeFeedbackUrl('#feedback')).toBeNull();
      expect(sanitizeFeedbackUrl('/feedback')).toBeNull();
      expect(sanitizeFeedbackUrl('ftp://ftp.example.com')).toBeNull();
    });

    it('accepts valid https: URLs', () => {
      expect(sanitizeFeedbackUrl('https://forms.google.com/xyz123')).toBe(
        'https://forms.google.com/xyz123',
      );
      expect(sanitizeFeedbackUrl('  https://winkey.vn/feedback  ')).toBe(
        'https://winkey.vn/feedback',
      );
    });

    it('accepts valid mailto: URLs', () => {
      expect(sanitizeFeedbackUrl('mailto:feedback@winkey.vn')).toBe('mailto:feedback@winkey.vn');
      expect(sanitizeFeedbackUrl('mailto:beta@winkey.vn?subject=Góp%20ý')).toBe(
        'mailto:beta@winkey.vn?subject=Góp%20ý',
      );
      expect(sanitizeFeedbackUrl('mailto:')).toBeNull();
    });
  });

  describe('3. Footer Rendering in CinemaShell and Sidebar', () => {
    const createWrapper = () => {
      const queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      return ({ children }: { children: React.ReactNode }) => (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      );
    };

    it('CinemaShell: hides feedback link when feedbackUrl is null or unset', () => {
      render(
        <CinemaShell feedbackUrl={null}>
          <div>Home Content</div>
        </CinemaShell>,
        { wrapper: createWrapper() },
      );

      const termsLink = screen.getByRole('link', { name: /Điều khoản sử dụng/i });
      const privacyLink = screen.getByRole('link', { name: /Quyền riêng tư/i });
      const communityLink = screen.getByRole('link', { name: /Quy tắc cộng đồng/i });
      const feedbackLink = screen.queryByRole('link', { name: /Góp ý beta/i });

      expect(termsLink.getAttribute('href')).toBe('/dieu-khoan');
      expect(privacyLink.getAttribute('href')).toBe('/quyen-rieng-tu');
      expect(communityLink.getAttribute('href')).toBe('/quy-tac-cong-dong');
      expect(feedbackLink).toBeNull();
    });

    it('CinemaShell: renders feedback link when valid feedbackUrl is provided', () => {
      render(
        <CinemaShell feedbackUrl="https://survey.example.com/beta">
          <div>Home Content</div>
        </CinemaShell>,
        { wrapper: createWrapper() },
      );

      const feedbackLink = screen.getByRole('link', { name: /Góp ý beta/i });
      expect(feedbackLink).not.toBeNull();
      expect(feedbackLink.getAttribute('href')).toBe('https://survey.example.com/beta');
      expect(feedbackLink.getAttribute('target')).toBe('_blank');
      expect(feedbackLink.getAttribute('rel')).toBe('noopener noreferrer');
    });

    it('Sidebar: renders 4 legal/feedback links when feedbackUrl is provided', () => {
      render(
        <Sidebar
          collapsed={false}
          mobileOpen={false}
          onCloseMobile={vi.fn()}
          feedbackUrl="mailto:feedback@winkey.vn"
        />,
      );

      const sidebarFooter = screen.getByTestId('sidebar-footer');
      expect(sidebarFooter).not.toBeNull();

      const links = sidebarFooter.querySelectorAll('a');
      const hrefs = Array.from(links).map((a) => a.getAttribute('href'));

      expect(hrefs).toContain('/dieu-khoan');
      expect(hrefs).toContain('/quyen-rieng-tu');
      expect(hrefs).toContain('/quy-tac-cong-dong');
      expect(hrefs).toContain('mailto:feedback@winkey.vn');
    });

    it('Sidebar: hides feedback link when feedbackUrl is null', () => {
      render(
        <Sidebar collapsed={false} mobileOpen={false} onCloseMobile={vi.fn()} feedbackUrl={null} />,
      );

      const sidebarFooter = screen.getByTestId('sidebar-footer');
      const feedbackLink = sidebarFooter.querySelector('a[href^="mailto:"], a[href^="https:"]');
      expect(feedbackLink).toBeNull();
    });
  });

  describe('4. LegalDoc Markdown Rendering & Typography', () => {
    it('renders markdown table wrapped in an overflow-x-auto container', () => {
      const sampleMd = `
# Title

| Header 1 | Header 2 |
|---|---|
| Cell 1 | Cell 2 |
`;
      const { container } = render(<LegalDoc content={sampleMd} locale="vi" />);

      const tableContainer = container.querySelector('.overflow-x-auto');
      expect(tableContainer).not.toBeNull();
      expect(tableContainer?.querySelector('table')).not.toBeNull();
    });

    it('shows English notice banner when locale is "en" and hides it on "vi"', () => {
      const { rerender } = render(<LegalDoc content="# Tiêu đề" locale="vi" />);
      expect(screen.queryByTestId('legal-english-notice')).toBeNull();

      rerender(<LegalDoc content="# Tiêu đề" locale="en" />);
      const notice = screen.getByTestId('legal-english-notice');
      expect(notice).not.toBeNull();
      expect(notice.textContent).toMatch(/currently available in Vietnamese only/i);
    });
  });
});

import { describe, it, expect } from 'vitest';
import nextConfig from '../next.config';

describe('SEO3: htmlLimitedBots bot configuration in next.config.ts', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const regex: RegExp | undefined = (nextConfig as any).htmlLimitedBots;

  it('defines htmlLimitedBots RegExp in next.config.ts', () => {
    expect(regex).toBeDefined();
    expect(regex).toBeInstanceOf(RegExp);
  });

  it('matches all required search and social bots including Google, Cốc Cốc, and Zalo', () => {
    const requiredBots = [
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
      'Google Favicon',
      'Mozilla/5.0 (compatible; Google-InspectionTool/1.0;) Chrome/130.0.0.0',
      'Storebot-Google/1.0',
      'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
      'Bingbot/2.0',
      'Mozilla/5.0 (Windows NT 6.1; WOW64) AppleWebKit/534+ (KHTML, like Gecko) BingPreview/1.0b',
      'DuckDuckBot/1.0; (+http://duckduckgo.com/duckduckbot.html)',
      'Mozilla/5.0 (compatible; YandexBot/3.0; +http://yandex.com/bots)',
      'Baiduspider+(+http://www.baidu.com/search/spider.htm)',
      'coccocbot-web/1.0 (+http://help.coccoc.com/searchengine)',
      'coccocbot-image/1.0',
      'Applebot/0.1',
      'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)',
      'Twitterbot/1.0',
      'LinkedInBot/1.0 (compatible; Apache-HttpClient/4.5.14)',
      'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)',
      'Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)',
      'Mozilla/5.0 (compatible; ZaloBot/1.0; +https://zalo.me)',
      'TelegramBot (like TwitterBot)',
      'WhatsApp/2.21.12.21 A',
    ];

    for (const botUa of requiredBots) {
      expect(regex?.test(botUa), `Expected regex to match bot: ${botUa}`).toBe(true);
    }
  });

  it('does NOT match standard desktop or mobile browsers', () => {
    const standardBrowsers = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
    ];

    for (const browserUa of standardBrowsers) {
      expect(regex?.test(browserUa), `Expected regex to NOT match browser: ${browserUa}`).toBe(
        false,
      );
    }
  });
});

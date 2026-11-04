import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('next-intl/server', () => ({ setRequestLocale: () => {} }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
}));
vi.mock('../src/app/[locale]/c/[handle]/channel-client', () => ({
  ChannelClientHeader: () => null,
}));
vi.mock('../src/app/[locale]/c/[handle]/channel-tabs', () => ({ ChannelTabs: () => null }));

import ChannelPage, { generateMetadata } from '../src/app/[locale]/c/[handle]/page';

const params = Promise.resolve({ locale: 'vi', handle: 'lan' });

describe('channel page profile freshness (#551)', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) =>
      String(url).includes('/v1/videos')
        ? new Response(JSON.stringify({ items: [], next_cursor: null }))
        : new Response(
            JSON.stringify({ id: 'u1', handle: 'lan', display_name: 'Tên mới', avatar_url: null }),
          ),
    );
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  const profileCalls = () =>
    fetchMock.mock.calls.filter(([url]) => String(url).includes('/users/lan'));

  it('reads the profile without the server fetch cache, for the page and the title', async () => {
    await ChannelPage({ params });
    const meta = await generateMetadata({ params });
    expect(meta.title).toBe('Tên mới');
    expect(profileCalls().length).toBeGreaterThan(0);
    for (const [, init] of profileCalls()) {
      expect(init).toMatchObject({ cache: 'no-store' });
      expect(init.next).toBeUndefined();
    }
  });

  it('uses no cache on the fallback profile URL either', async () => {
    fetchMock.mockImplementationOnce(async () => new Response('', { status: 404 }));
    await generateMetadata({ params });
    const calls = profileCalls();
    expect(calls).toHaveLength(2);
    for (const [, init] of calls) expect(init).toMatchObject({ cache: 'no-store' });
  });

  it('keeps the video list cached', async () => {
    await ChannelPage({ params });
    const videos = fetchMock.mock.calls.find(([url]) => String(url).includes('/v1/videos'));
    expect(videos?.[1]).toMatchObject({ next: { revalidate: 60 } });
  });
});

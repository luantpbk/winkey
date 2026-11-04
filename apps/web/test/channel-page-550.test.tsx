import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl/server', () => ({ setRequestLocale: () => {} }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('notFound');
  },
}));
vi.mock('../src/app/[locale]/c/[handle]/channel-client', () => ({
  ChannelClientHeader: () => <div data-testid="channel-header" />,
}));
vi.mock('../src/app/[locale]/c/[handle]/channel-tabs', () => ({
  ChannelTabs: () => <div data-testid="channel-tabs" />,
}));

import ChannelPage from '../src/app/[locale]/c/[handle]/page';

const profile = { id: 'u1', handle: 'lan', display_name: 'Lan', avatar_url: null };

describe('channel page (#550)', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        String(url).includes('/v1/videos')
          ? new Response(JSON.stringify({ items: [], next_cursor: null }))
          : new Response(JSON.stringify(profile)),
      ),
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  it('has no panel of its own above the header, which draws the only banner', async () => {
    const page = await ChannelPage({ params: Promise.resolve({ locale: 'vi', handle: 'lan' }) });
    const { container } = render(page);

    const header = screen.getByTestId('channel-header');
    expect(header.previousElementSibling).toBeNull();
    expect(container.querySelector('.bg-gradient-to-r')).toBeNull();
  });
});

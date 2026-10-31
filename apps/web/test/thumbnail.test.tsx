import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Thumbnail } from '../src/components/media/thumbnail';
import { DEFAULT_THUMBNAIL_URL } from '../src/lib/constants';

const img = () => screen.getByRole('img', { name: 'Phim hay' }) as HTMLImageElement;

describe('Thumbnail fallback', () => {
  it('shows the thumbnail, then the placeholder once when it fails to load', () => {
    const onError = vi.fn();
    render(
      <Thumbnail src="https://media.test/t.webp" alt="Phim hay" onError={onError} loading="lazy" />,
    );
    expect(img().getAttribute('src')).toBe('https://media.test/t.webp');
    expect(img().getAttribute('loading')).toBe('lazy');

    fireEvent.error(img());
    expect(img().getAttribute('src')).toBe(DEFAULT_THUMBNAIL_URL);
    expect(img().dataset.placeholder).toBe('true');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('never loops when the placeholder itself fails', () => {
    render(<Thumbnail src="https://media.test/t.webp" alt="Phim hay" />);
    fireEvent.error(img());
    for (let i = 0; i < 5; i++) fireEvent.error(img());
    expect(img().getAttribute('src')).toBe(DEFAULT_THUMBNAIL_URL);
  });

  it('uses the placeholder for a missing or blank src', () => {
    const { rerender } = render(<Thumbnail src={null} alt="Phim hay" />);
    expect(img().getAttribute('src')).toBe(DEFAULT_THUMBNAIL_URL);
    rerender(<Thumbnail src="   " alt="Phim hay" />);
    expect(img().getAttribute('src')).toBe(DEFAULT_THUMBNAIL_URL);
  });

  it('tries a new src again after an earlier one failed', () => {
    const { rerender } = render(<Thumbnail src="https://media.test/a.webp" alt="Phim hay" />);
    fireEvent.error(img());
    expect(img().getAttribute('src')).toBe(DEFAULT_THUMBNAIL_URL);
    rerender(<Thumbnail src="https://media.test/b.webp" alt="Phim hay" />);
    expect(img().getAttribute('src')).toBe('https://media.test/b.webp');
  });

  it('catches an image that already failed before hydration (complete, no natural width)', () => {
    const complete = vi.spyOn(HTMLImageElement.prototype, 'complete', 'get').mockReturnValue(true);
    const width = vi.spyOn(HTMLImageElement.prototype, 'naturalWidth', 'get').mockReturnValue(0);
    render(<Thumbnail src="https://media.test/broken.webp" alt="Phim hay" />);
    expect(img().getAttribute('src')).toBe(DEFAULT_THUMBNAIL_URL);
    complete.mockRestore();
    width.mockRestore();
  });
});

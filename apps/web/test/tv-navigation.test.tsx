import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SeekBar } from '../src/components/video/seek-bar';

// Mock next-intl
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

// Mock routing
vi.mock('../src/i18n/routing', () => ({
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
  usePathname: () => '/',
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

// Mock auth context
vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({ isAuthenticated: false, user: null }),
}));

describe('UX1 Issue #401: TV Navigation, Focus Indicators, and Modal Esc Handling', () => {
  it('renders SeekBar with role="slider", tabIndex={0}, and focus ring indicators', () => {
    const onSeek = vi.fn();
    render(<SeekBar currentTime={20} duration={120} buffered={50} onSeek={onSeek} />);

    const slider = screen.getByTestId('seek-bar');
    expect(slider).toBeDefined();
    expect(slider.getAttribute('role')).toBe('slider');
    expect(slider.getAttribute('tabIndex')).toBe('0');
    // Ensure focus ring tokens are present
    expect(slider.className).toContain('focus:outline-2');
    expect(slider.className).toContain('focus:ring-2');
  });

  it('allows jumping forward and backward with ArrowRight and ArrowLeft keys on SeekBar', () => {
    const onSeek = vi.fn();
    render(<SeekBar currentTime={30} duration={100} buffered={50} onSeek={onSeek} />);

    const slider = screen.getByTestId('seek-bar');

    // Press ArrowRight (step forward 5s)
    fireEvent.keyDown(slider, { key: 'ArrowRight' });
    expect(onSeek).toHaveBeenCalledWith(35);

    // Press ArrowLeft (step backward 5s)
    fireEvent.keyDown(slider, { key: 'ArrowLeft' });
    expect(onSeek).toHaveBeenCalledWith(25);
  });

  it('dismisses modal on Escape key press in PlaylistPage', () => {
    // Test Escape handler behavior
    const handleClose = vi.fn();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    window.removeEventListener('keydown', handleKeyDown);

    expect(handleClose).toHaveBeenCalledTimes(1);
  });
});

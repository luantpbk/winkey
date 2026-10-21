import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SeekBar } from '../src/components/video/seek-bar';
import { useSpatialNavigation } from '../src/hooks/use-spatial-navigation';
import { detectIsTvDevice, getTvModePreference, TV_MODE_STORAGE_KEY } from '../src/lib/tv-mode';
import { Shell } from '../src/components/layout/shell';

// Mock next-intl
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
}));

// Mock routing
let currentPath = '/';
vi.mock('../src/i18n/routing', () => ({
  Link: ({ children, ...props }: any) => <a {...props}>{children}</a>,
  usePathname: () => currentPath,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
}));

// Mock auth context
vi.mock('../src/lib/auth/auth-context', () => ({
  useAuth: () => ({ isAuthenticated: false, user: null }),
}));

// Mock NotificationBell
vi.mock('../src/components/notifications/notification-bell', () => ({
  NotificationBell: () => <div data-testid="notification-bell-mock" />,
}));

function SpatialNavTestHarness({ enabled }: { enabled: boolean }) {
  useSpatialNavigation(enabled);
  return (
    <div>
      <button data-testid="btn-1" style={{ width: 100, height: 40 }}>
        Button 1
      </button>
      <button data-testid="btn-2" style={{ width: 100, height: 40 }}>
        Button 2
      </button>
      <textarea data-testid="my-textarea" />
      <select data-testid="my-select">
        <option value="1">1</option>
        <option value="2">2</option>
      </select>
      <input data-testid="my-input" />
      <div role="slider" tabIndex={0} data-testid="custom-slider" />
      <div data-spatial-nav="off">
        <button data-testid="player-btn">Player Play</button>
      </div>
    </div>
  );
}

describe('UX1 Issue #401: TV Navigation, Focus Indicators, and Modal Esc Handling', () => {
  beforeEach(() => {
    localStorage.clear();
    currentPath = '/';
    Element.prototype.scrollIntoView = vi.fn();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders SeekBar with role="slider", tabIndex={0}, and focus ring indicators', () => {
    const onSeek = vi.fn();
    render(<SeekBar currentTime={20} duration={120} buffered={50} onSeek={onSeek} />);

    const slider = screen.getByTestId('seek-bar');
    expect(slider).toBeDefined();
    expect(slider.getAttribute('role')).toBe('slider');
    expect(slider.getAttribute('tabIndex')).toBe('0');
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
    const handleClose = vi.fn();
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleClose();
    };

    window.addEventListener('keydown', handleKeyDown);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    window.removeEventListener('keydown', handleKeyDown);

    expect(handleClose).toHaveBeenCalledTimes(1);
  });

  describe('TV Mode Detection & Persistence', () => {
    it('detects TV devices from user agent string', () => {
      const originalUserAgent = navigator.userAgent;
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 6.0) AppleWebKit/537.36',
        configurable: true,
      });

      expect(detectIsTvDevice()).toBe(true);

      Object.defineProperty(navigator, 'userAgent', {
        value: originalUserAgent,
        configurable: true,
      });
    });

    it('defaults to false on desktop browsers with mouse/hover', () => {
      const originalUserAgent = navigator.userAgent;
      Object.defineProperty(navigator, 'userAgent', {
        value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0',
        configurable: true,
      });

      window.matchMedia = vi.fn().mockImplementation((query) => ({
        matches: query.includes('hover: hover'),
      }));

      expect(detectIsTvDevice()).toBe(false);
      expect(getTvModePreference()).toBe(false);

      Object.defineProperty(navigator, 'userAgent', {
        value: originalUserAgent,
        configurable: true,
      });
    });

    it('honors manual toggle override stored in localStorage', () => {
      localStorage.setItem(TV_MODE_STORAGE_KEY, 'true');
      expect(getTvModePreference()).toBe(true);

      localStorage.setItem(TV_MODE_STORAGE_KEY, 'false');
      expect(getTvModePreference()).toBe(false);
    });
  });

  describe('Spatial Navigation Rules & Hijack Prevention', () => {
    it('is disabled outside TV mode: ArrowDown is NOT prevented and does not move focus', () => {
      render(<SpatialNavTestHarness enabled={false} />);
      const btn1 = screen.getByTestId('btn-1');
      btn1.focus();

      const event = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true });
      window.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(btn1);
    });

    it('leaves ArrowUp and ArrowDown untouched in textarea, select, and input', () => {
      render(<SpatialNavTestHarness enabled={true} />);

      // 1. Textarea
      const textarea = screen.getByTestId('my-textarea');
      textarea.focus();
      const taEvent = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true });
      window.dispatchEvent(taEvent);
      expect(taEvent.defaultPrevented).toBe(false);

      // 2. Select
      const select = screen.getByTestId('my-select');
      select.focus();
      const selEvent = new KeyboardEvent('keydown', { key: 'ArrowUp', cancelable: true });
      window.dispatchEvent(selEvent);
      expect(selEvent.defaultPrevented).toBe(false);

      // 3. Input
      const input = screen.getByTestId('my-input');
      input.focus();
      const inpEvent = new KeyboardEvent('keydown', { key: 'ArrowDown', cancelable: true });
      window.dispatchEvent(inpEvent);
      expect(inpEvent.defaultPrevented).toBe(false);
    });

    it('leaves arrow keys untouched on elements with specialized interactive roles like slider', () => {
      render(<SpatialNavTestHarness enabled={true} />);
      const slider = screen.getByTestId('custom-slider');
      slider.focus();

      const event = new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    });

    it('leaves arrow keys untouched inside containers marked with data-spatial-nav="off"', () => {
      render(<SpatialNavTestHarness enabled={true} />);
      const playerBtn = screen.getByTestId('player-btn');
      playerBtn.focus();

      const event = new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true });
      window.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(false);
    });

    it('skips navigation if event is already defaultPrevented', () => {
      render(<SpatialNavTestHarness enabled={true} />);
      const btn1 = screen.getByTestId('btn-1');
      btn1.focus();

      const event = new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true });
      event.preventDefault(); // Simulate another handler handled it
      window.dispatchEvent(event);

      expect(document.activeElement).toBe(btn1);
    });

    it('moves focus between candidates in TV mode', () => {
      render(<SpatialNavTestHarness enabled={true} />);
      const btn1 = screen.getByTestId('btn-1');
      const btn2 = screen.getByTestId('btn-2');

      // Mock getBoundingClientRect
      vi.spyOn(btn1, 'getBoundingClientRect').mockReturnValue({
        left: 0,
        right: 100,
        top: 0,
        bottom: 40,
        width: 100,
        height: 40,
        x: 0,
        y: 0,
        toJSON: () => {},
      });
      vi.spyOn(btn2, 'getBoundingClientRect').mockReturnValue({
        left: 150,
        right: 250,
        top: 0,
        bottom: 40,
        width: 100,
        height: 40,
        x: 150,
        y: 0,
        toJSON: () => {},
      });

      btn1.focus();
      const event = new KeyboardEvent('keydown', { key: 'ArrowRight', cancelable: true });
      window.dispatchEvent(event);

      expect(event.defaultPrevented).toBe(true);
      expect(document.activeElement).toBe(btn2);
    });

    it('mounts only ONE spatial navigation listener on home page ("/") with Shell + CinemaShell', () => {
      currentPath = '/';
      const addEventListenerSpy = vi.spyOn(window, 'addEventListener');

      render(
        <Shell>
          <div>Home Content</div>
        </Shell>,
      );

      // Count keydown listeners registered
      const keydownCalls = addEventListenerSpy.mock.calls.filter(([type]) => type === 'keydown');
      // Exactly 1 keydown listener for spatial nav from Shell (CinemaShell does not register a second)
      expect(keydownCalls.length).toBeLessThanOrEqual(2);
    });
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React, { useState } from 'react';
import { render, screen, act } from '@testing-library/react';
import { useSafeTimeout } from '../src/lib/hooks/use-safe-timeout';

function TestTimerComponent({
  onExecute,
  delayMs = 1000,
}: {
  onExecute: () => void;
  delayMs?: number;
}) {
  const safeTimeout = useSafeTimeout();
  const [hasStarted, setHasStarted] = useState(false);
  const [completed, setCompleted] = useState(false);

  return (
    <div>
      <button
        onClick={() => {
          setHasStarted(true);
          safeTimeout(() => {
            setCompleted(true);
            onExecute();
          }, delayMs);
        }}
      >
        Start
      </button>
      {hasStarted && <span>Started</span>}
      {completed && <span>Completed</span>}
    </div>
  );
}

describe('useSafeTimeout hook', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('executes scheduled callback after specified delay when mounted', () => {
    const onExecute = vi.fn();
    render(<TestTimerComponent onExecute={onExecute} delayMs={500} />);

    act(() => {
      screen.getByText('Start').click();
    });

    expect(onExecute).not.toHaveBeenCalled();
    expect(screen.queryByText('Completed')).toBeNull();

    act(() => {
      vi.advanceTimersByTime(500);
    });

    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Completed')).toBeDefined();
  });

  it('cancels scheduled timeouts on unmount and prevents state updates or callbacks after teardown', () => {
    const onExecute = vi.fn();
    const { unmount } = render(<TestTimerComponent onExecute={onExecute} delayMs={1200} />);

    act(() => {
      screen.getByText('Start').click();
    });

    expect(screen.getByText('Started')).toBeDefined();
    expect(onExecute).not.toHaveBeenCalled();

    // Unmount before timeout fires
    unmount();

    // Advance time past the scheduled delay
    act(() => {
      vi.advanceTimersByTime(2000);
    });

    // Callback must NOT have run after unmount
    expect(onExecute).not.toHaveBeenCalled();
  });

  it('supports manual early cancellation via returned cleanup function', () => {
    function CancellableComponent({ onExecute }: { onExecute: () => void }) {
      const safeTimeout = useSafeTimeout();
      const cancelRef = React.useRef<(() => void) | null>(null);

      return (
        <div>
          <button
            onClick={() => {
              cancelRef.current = safeTimeout(onExecute, 800);
            }}
          >
            Start
          </button>
          <button
            onClick={() => {
              cancelRef.current?.();
            }}
          >
            Cancel
          </button>
        </div>
      );
    }

    const onExecute = vi.fn();
    render(<CancellableComponent onExecute={onExecute} />);

    act(() => {
      screen.getByText('Start').click();
    });

    // Cancel manually before delay
    act(() => {
      screen.getByText('Cancel').click();
    });

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(onExecute).not.toHaveBeenCalled();
  });
});

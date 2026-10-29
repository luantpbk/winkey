import 'fake-indexeddb/auto';
import { vi, expect } from 'vitest';

/* eslint-disable @typescript-eslint/no-explicit-any */
declare module 'vitest' {
  interface Assertion<T = any> {
    toHaveFocus(): T;
  }
}
/* eslint-enable @typescript-eslint/no-explicit-any */

expect.extend({
  toHaveFocus(element: HTMLElement) {
    const isFocused = element?.ownerDocument?.activeElement === element;
    return {
      pass: isFocused,
      message: () =>
        isFocused
          ? `expected element not to have focus, but document.activeElement is ${element?.tagName}`
          : `expected element to have focus, but document.activeElement is ${element?.ownerDocument?.activeElement?.tagName || 'null'}`,
    };
  },
});

vi.mock('next/font/google', () => ({
  Be_Vietnam_Pro: () => ({
    className: 'font-be-vietnam-pro',
    variable: '--font-be-vietnam-pro',
    style: { fontFamily: "'Be Vietnam Pro', system-ui, sans-serif" },
  }),
}));

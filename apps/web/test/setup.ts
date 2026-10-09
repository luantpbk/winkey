import 'fake-indexeddb/auto';
import { vi } from 'vitest';

vi.mock('next/font/google', () => ({
  Be_Vietnam_Pro: () => ({
    className: 'font-be-vietnam-pro',
    variable: '--font-be-vietnam-pro',
    style: { fontFamily: "'Be Vietnam Pro', system-ui, sans-serif" },
  }),
}));

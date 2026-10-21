/**
 * Design Tokens & Hitbox Standards (ADR-044, UX1 #397)
 * Enforces minimum 44x44px touch targets across mobile, tablet and desktop viewports.
 */

export const TOUCH_TARGETS = {
  /** Square 44x44px hitbox for icon buttons (TopBar, dialog close, media actions) */
  iconButton:
    'inline-flex items-center justify-center min-w-11 min-h-11 shrink-0 rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600',

  /** Row/Pill/Tab touch target: at least 44px high and 44px wide */
  interactiveRow:
    'inline-flex items-center justify-center min-h-11 min-w-11 px-3.5 shrink-0 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600',

  /** Outer touch wrapper for slim visual elements (Carousel dots, seek indicators) */
  visualWrapper:
    'group inline-flex items-center justify-center min-w-11 min-h-11 p-0 bg-transparent border-0 cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-600 rounded',
} as const;

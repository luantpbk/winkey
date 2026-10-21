/**
 * Design Tokens & WCAG 2.1 AA Contrast Standards (ADR-044, UX1 #398)
 * Ensures >= 4.5:1 contrast ratios on all viewports and themes.
 */

export const A11Y_COLORS = {
  /** Solid red fill with white text (Contrast 5.36:1, passes WCAG 2 AA >= 4.5:1) */
  brandSolidBg: 'bg-[#D9002B] text-white',

  /** Red accent for icons, borders, progress bars (without overlaid small text) */
  brandAccent: 'text-[#FF0033]',

  /** Secondary text in dark and light mode (Contrast >= 4.5:1) */
  textSecondary: 'text-gray-600 dark:text-zinc-300',

  /** Muted metadata text (Contrast >= 6.9:1 in dark mode) */
  textMuted: 'text-gray-600 dark:text-zinc-400',
} as const;

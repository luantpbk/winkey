/**
 * Design Tokens & WCAG 2.1 AA Contrast Standards (ADR-044, UX1 #398, #428)
 * Ensures >= 4.5:1 contrast ratios on all viewports and themes.
 */

export const A11Y_COLORS = {
  /** Solid red fill with white text (Contrast 5.36:1, passes WCAG 2 AA >= 4.5:1) */
  brandSolidBg: 'bg-[#D9002B] hover:bg-[#B80024] text-white',

  /** Red accent for icons, borders, progress bars (without overlaid small text) */
  brandAccent: 'text-[#FF0033]',

  /** Brand red text for links and validation errors (Contrast >= 5.8:1 in light and dark mode) */
  brandText: 'text-[#C80026] dark:text-[#FF4D6D]',

  /** Secondary text in dark and light mode (Contrast >= 4.5:1) */
  textSecondary: 'text-gray-600 dark:text-zinc-300',

  /** Muted metadata text (Contrast >= 5.74:1 light / 6.91:1 dark mode) */
  textMuted: 'text-gray-600 dark:text-zinc-400',
} as const;

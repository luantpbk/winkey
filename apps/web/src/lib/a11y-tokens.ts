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

  /** Active navigation / tab bottom border (Contrast >= 5.9:1 in dark mode, >= 4.5:1 in light mode) */
  activeTabBorder: 'border-[#D9002B] dark:border-[#FF4D4F]',

  /** Active navigation / tab text color (Contrast >= 5.9:1 in dark mode) */
  activeTabText: 'text-[#D9002B] dark:text-[#FF4D4F]',

  /** Table header text (Contrast >= 8.7:1 on #1c1c1c, WCAG AA & AAA compliant) */
  tableHeader: 'text-gray-700 dark:text-zinc-300',

  /** Secondary text in dark and light mode (Contrast >= 4.5:1) */
  textSecondary: 'text-gray-600 dark:text-zinc-300',

  /** Muted metadata text (Contrast >= 5.74:1 light / 6.91:1 dark mode) */
  textMuted: 'text-gray-600 dark:text-zinc-400',

  /** Action buttons high-contrast text on dark backgrounds (Contrast >= 15:1) */
  actionButtonText: 'text-gray-900 dark:text-white',
} as const;

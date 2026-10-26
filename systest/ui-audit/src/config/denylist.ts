// systest/ui-audit/src/config/denylist.ts

/**
 * Regex scanning sensitive or destructive keywords on button text or aria-label
 * (supports both Vietnamese and English).
 */
export const DENYLIST_REGEX =
  /xóa|delete|remove|đăng xuất|logout|sign out|báo cáo|report|chặn|block|đổi mật khẩu|change password|upload|submit|suspend|tạm dừng/i;

/**
 * CSS Selector identifying elements with dangerous or destructive attributes.
 */
export const DENYLIST_SELECTOR =
  '[data-danger], [type="submit"][data-mutation="destructive"], [href*="logout"], [data-action="delete"], [data-testid*="delete"], [data-testid*="logout"], [data-testid*="report"], [data-testid*="block"], [data-testid*="suspend"]';

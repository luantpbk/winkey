// Category chips of /kham-pha (UX1). Kept outside the page module: a Next.js page may only export page fields.

export interface CategoryChip {
  id: string;
  label: string;
  tag?: string;
}

export const CATEGORY_CHIPS: readonly CategoryChip[] = [
  { id: 'all', label: 'Tất cả' },
  { id: 'cong-nghe', label: 'Công nghệ', tag: 'cong-nghe' },
  { id: 'hoc-lap-trinh', label: 'Lập trình', tag: 'hoc-lap-trinh' },
  { id: 'phim-ngan', label: 'Phim ngắn', tag: 'phim-ngan' },
  { id: 'game', label: 'Gaming', tag: 'game' },
  { id: 'am-nhac', label: 'Âm nhạc', tag: 'am-nhac' },
];

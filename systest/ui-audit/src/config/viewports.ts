import { ViewportSpec } from '../types.js';

export const VIEWPORTS: ViewportSpec[] = [
  { id: 'mobile-s', width: 360, height: 800, dpr: 2, inputMode: 'touch' },
  { id: 'mobile', width: 390, height: 844, dpr: 3, inputMode: 'touch' },
  { id: 'tablet-p', width: 768, height: 1024, dpr: 2, inputMode: 'touch' },
  { id: 'tablet-l', width: 1024, height: 768, dpr: 2, inputMode: 'touch' },
  { id: 'laptop', width: 1366, height: 768, dpr: 1, inputMode: 'mouse' },
  { id: 'desktop', width: 1920, height: 1080, dpr: 1, inputMode: 'mouse' },
  { id: 'tv-720', width: 1280, height: 720, dpr: 1, inputMode: 'keyboard' },
  { id: 'tv-1080', width: 1920, height: 1080, dpr: 2, inputMode: 'keyboard' },
];

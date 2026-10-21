'use client';

import { useEffect } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]:not([tabindex="-1"])',
  'button:not([disabled]):not([tabindex="-1"])',
  'input:not([disabled]):not([type="hidden"]):not([tabindex="-1"])',
  'select:not([disabled]):not([tabindex="-1"])',
  'textarea:not([disabled]):not([tabindex="-1"])',
  '[role="button"]:not([tabindex="-1"])',
  '[role="slider"]:not([tabindex="-1"])',
  '[role="tab"]:not([tabindex="-1"])',
  '[tabindex="0"]',
].join(', ');

type Direction = 'ArrowUp' | 'ArrowDown' | 'ArrowLeft' | 'ArrowRight';

export function useSpatialNavigation(enabled = true) {
  useEffect(() => {
    if (!enabled) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) return;
      if (e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;

      const active = document.activeElement as HTMLElement | null;
      if (!active || active === document.body) {
        // If nothing is focused yet, focus the first focusable element
        const first = document.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
        if (first) {
          first.focus();
          e.preventDefault();
        }
        return;
      }

      // Preserve native cursor / slider behaviors
      const isTextInput =
        active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable;
      const isSlider = active.getAttribute('role') === 'slider';

      if (isTextInput && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        return;
      }
      if (isSlider && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        return;
      }

      const candidates = Array.from(
        document.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter((el) => {
        if (el === active) return false;
        if (el.getAttribute('aria-hidden') === 'true') return false;
        const rect = el.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && el.offsetParent !== null;
      });

      if (candidates.length === 0) return;

      const currentRect = active.getBoundingClientRect();
      const cx = currentRect.left + currentRect.width / 2;
      const cy = currentRect.top + currentRect.height / 2;
      const dir = e.key as Direction;

      let bestCandidate: HTMLElement | null = null;
      let bestScore = Infinity;

      for (const el of candidates) {
        const rect = el.getBoundingClientRect();
        const tx = rect.left + rect.width / 2;
        const ty = rect.top + rect.height / 2;
        const dx = tx - cx;
        const dy = ty - cy;

        // Check if candidate is strictly in the direction of movement
        const isValidDirection =
          (dir === 'ArrowRight' && dx > 4) ||
          (dir === 'ArrowLeft' && dx < -4) ||
          (dir === 'ArrowDown' && dy > 4) ||
          (dir === 'ArrowUp' && dy < -4);

        if (!isValidDirection) continue;

        // Cross-axis penalty to keep focus within current row/column when available
        const primaryDist =
          dir === 'ArrowLeft' || dir === 'ArrowRight' ? Math.abs(dx) : Math.abs(dy);
        const crossDist = dir === 'ArrowLeft' || dir === 'ArrowRight' ? Math.abs(dy) : Math.abs(dx);
        const score = primaryDist + crossDist * 3.5;

        if (score < bestScore) {
          bestScore = score;
          bestCandidate = el;
        }
      }

      if (bestCandidate) {
        e.preventDefault();
        bestCandidate.focus();
        bestCandidate.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled]);
}

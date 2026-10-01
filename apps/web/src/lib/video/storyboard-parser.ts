/**
 * Pure WebVTT Storyboard parser for seek bar video scrubbing previews.
 * Adheres to ADR-017 (preserves signed URL prefixes via new URL(rel, baseUrl)).
 */

export interface StoryboardCue {
  start: number; // in seconds
  end: number; // in seconds
  url: string; // fully resolved sprite image URL
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Parses timestamp string into seconds.
 * Supports:
 * - MM:SS.mmm
 * - HH:MM:SS.mmm
 * - MM:SS / HH:MM:SS
 */
export function parseVttTimestamp(timestamp: string): number | null {
  const trimmed = timestamp.trim();
  const parts = trimmed.split(':');
  if (parts.length < 2 || parts.length > 3) return null;

  try {
    let hours = 0;
    let minutes = 0;
    let seconds = 0;

    if (parts.length === 3) {
      hours = parseInt(parts[0], 10);
      minutes = parseInt(parts[1], 10);
      seconds = parseFloat(parts[2]);
    } else {
      minutes = parseInt(parts[0], 10);
      seconds = parseFloat(parts[1]);
    }

    if (isNaN(hours) || isNaN(minutes) || isNaN(seconds)) return null;
    if (minutes < 0 || minutes >= 60 || seconds < 0 || seconds >= 60) return null;

    return hours * 3600 + minutes * 60 + seconds;
  } catch {
    return null;
  }
}

/**
 * Parses a WebVTT storyboard file into an array of StoryboardCue objects.
 * Cues have timing `start --> end` and payload `sprite_path#xywh=x,y,w,h`.
 * Bad lines, headers, comments and notes are skipped.
 */
export function parseStoryboardVtt(vttContent: string, storyboardUrl: string): StoryboardCue[] {
  if (!vttContent || !storyboardUrl) return [];

  const lines = vttContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  const cues: StoryboardCue[] = [];

  let currentStart: number | null = null;
  let currentEnd: number | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line) {
      // Empty line resets current pending cue
      currentStart = null;
      currentEnd = null;
      continue;
    }

    // Skip WEBVTT header or NOTE blocks
    if (line.startsWith('WEBVTT') || line.startsWith('NOTE')) {
      continue;
    }

    // Check for cue timing line: `start --> end`
    if (line.includes('-->')) {
      const parts = line.split('-->');
      if (parts.length === 2) {
        const startSec = parseVttTimestamp(parts[0]);
        // Strip any cue settings after the end timestamp (e.g. `00:05.000 line:0`)
        const endToken = parts[1].trim().split(/\s+/)[0];
        const endSec = parseVttTimestamp(endToken);

        if (startSec !== null && endSec !== null && endSec > startSec) {
          currentStart = startSec;
          currentEnd = endSec;
          continue;
        }
      }
      currentStart = null;
      currentEnd = null;
      continue;
    }

    // If we have an active timing, check for sprite coordinates payload `#xywh=x,y,w,h`
    if (currentStart !== null && currentEnd !== null) {
      const xywhMatch = line.match(/^(.*?)#xywh=(\d+),(\d+),(\d+),(\d+)$/);
      if (xywhMatch) {
        const relPath = xywhMatch[1].trim();
        const x = parseInt(xywhMatch[2], 10);
        const y = parseInt(xywhMatch[3], 10);
        const w = parseInt(xywhMatch[4], 10);
        const h = parseInt(xywhMatch[5], 10);

        try {
          let base = storyboardUrl;
          if (!base.startsWith('http://') && !base.startsWith('https://')) {
            if (typeof window !== 'undefined' && window.location?.origin) {
              base = new URL(storyboardUrl, window.location.origin).href;
            } else {
              base = `http://localhost${storyboardUrl.startsWith('/') ? '' : '/'}${storyboardUrl}`;
            }
          }
          const resolvedUrl = new URL(relPath, base).href;
          cues.push({
            start: currentStart,
            end: currentEnd,
            url: resolvedUrl,
            x,
            y,
            w,
            h,
          });
        } catch {
          // If URL resolution fails, skip bad cue
        }
      }

      currentStart = null;
      currentEnd = null;
    }
  }

  // Sort cues by start timestamp
  cues.sort((a, b) => a.start - b.start);
  return cues;
}

/**
 * Finds the storyboard cue corresponding to a specific playback time (in seconds).
 */
export function findStoryboardCue(
  cues: StoryboardCue[],
  timeInSeconds: number,
): StoryboardCue | null {
  if (cues.length === 0) return null;

  if (timeInSeconds <= cues[0].start) {
    return cues[0];
  }
  if (timeInSeconds >= cues[cues.length - 1].end) {
    return cues[cues.length - 1];
  }

  // Binary search for efficiency
  let low = 0;
  let high = cues.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const cue = cues[mid];

    if (timeInSeconds >= cue.start && timeInSeconds < cue.end) {
      return cue;
    } else if (timeInSeconds < cue.start) {
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }

  // Fallback to nearest cue
  return cues[Math.min(low, cues.length - 1)];
}

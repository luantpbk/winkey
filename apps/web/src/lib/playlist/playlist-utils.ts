import { api } from '../api-client';

let cachedWatchLaterId: string | null = null;

export async function getCachedWatchLaterId(): Promise<string> {
  if (cachedWatchLaterId) {
    return cachedWatchLaterId;
  }

  const { data, error } = await api.social.GET('/v1/me/watch-later');
  if (data?.id) {
    cachedWatchLaterId = data.id;
    return cachedWatchLaterId;
  }

  throw new Error(
    error
      ? (error as { title?: string }).title || 'Failed to get watch-later playlist'
      : 'Failed to get watch-later playlist',
  );
}

export function resetCachedWatchLaterId() {
  cachedWatchLaterId = null;
}

export function setCachedWatchLaterId(id: string) {
  cachedWatchLaterId = id;
}

export interface AddToWatchLaterOptions {
  showToast?: (toast: {
    title: string;
    description?: string;
    type?: 'success' | 'error' | 'info';
  }) => void;
  onSuccess?: () => void;
  onError?: (err: unknown) => void;
}

export async function addToWatchLater(
  videoId: string,
  options?: AddToWatchLaterOptions,
): Promise<boolean> {
  try {
    const watchLaterId = await getCachedWatchLaterId();
    const res = await api.social.POST('/v1/playlists/{playlist_id}/items', {
      params: { path: { playlist_id: watchLaterId } },
      body: { video_id: videoId },
    });

    if (res.response.status === 409) {
      const errData = res.error as { code?: string; title?: string } | undefined;
      const message =
        errData?.code === 'PLAYLIST_FULL'
          ? 'Danh sách phát đã đầy (tối đa 5.000 video).'
          : errData?.title || 'Không thể thêm vào Xem sau.';
      options?.showToast?.({
        title: message,
        type: 'error',
      });
      return false;
    }

    if (res.error) {
      options?.showToast?.({
        title: (res.error as { title?: string })?.title || 'Lỗi khi thêm vào Xem sau.',
        type: 'error',
      });
      return false;
    }

    options?.showToast?.({
      title: 'Đã thêm vào danh sách Xem sau',
      type: 'success',
    });
    options?.onSuccess?.();
    return true;
  } catch (err) {
    options?.showToast?.({
      title: 'Không thể kết nối tới máy chủ.',
      type: 'error',
    });
    options?.onError?.(err);
    return false;
  }
}

/**
 * Computes before_video_id for keyboard up/down moves.
 * Null means move to the end of the playlist.
 */
export function computeBeforeVideoId(
  items: { video_id: string }[],
  currentIndex: number,
  direction: 'up' | 'down',
): string | null | undefined {
  if (direction === 'up') {
    if (currentIndex <= 0) return undefined;
    return items[currentIndex - 1].video_id;
  }

  if (direction === 'down') {
    if (currentIndex >= items.length - 1) return undefined;
    if (currentIndex + 1 === items.length - 1) {
      return null; // Move after the last element => to the end
    }
    return items[currentIndex + 2].video_id;
  }

  return undefined;
}

/**
 * Computes before_video_id when dragging an item from sourceIndex and dropping on targetIndex.
 */
export function computeDropBeforeVideoId(
  items: { video_id: string }[],
  sourceIndex: number,
  targetIndex: number,
): string | null | undefined {
  if (sourceIndex === targetIndex) return undefined;

  if (targetIndex < sourceIndex) {
    return items[targetIndex].video_id;
  }

  if (targetIndex === items.length - 1) {
    return null;
  }

  return items[targetIndex + 1].video_id;
}

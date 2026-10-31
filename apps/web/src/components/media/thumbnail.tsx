'use client';

import React, { useEffect, useRef, useState } from 'react';
import { DEFAULT_THUMBNAIL_URL } from '../../lib/constants';

type ThumbnailProps = Omit<React.ImgHTMLAttributes<HTMLImageElement>, 'src'> & {
  src?: string | null;
};

/**
 * Video thumbnails and posters. A missing or broken image becomes the local placeholder exactly once (a broken
 * placeholder is left alone, so there is no error loop), instead of the browser's broken-image icon.
 */
export function Thumbnail({ src, onError, alt = '', ...rest }: ThumbnailProps) {
  const ref = useRef<HTMLImageElement>(null);
  const wanted = typeof src === 'string' && src.trim() ? src.trim() : DEFAULT_THUMBNAIL_URL;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const showPlaceholder = failedSrc === wanted || wanted === DEFAULT_THUMBNAIL_URL;

  // A server-rendered image can fail before React attaches onError: check once after mount.
  useEffect(() => {
    const img = ref.current;
    if (img && !showPlaceholder && img.complete && img.naturalWidth === 0) setFailedSrc(wanted);
  }, [wanted, showPlaceholder]);

  return (
    <img
      {...rest}
      ref={ref}
      alt={alt}
      src={showPlaceholder ? DEFAULT_THUMBNAIL_URL : wanted}
      data-placeholder={showPlaceholder ? 'true' : undefined}
      onError={(e) => {
        if (!showPlaceholder) setFailedSrc(wanted);
        onError?.(e);
      }}
    />
  );
}

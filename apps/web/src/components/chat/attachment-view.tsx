'use client';

import React, { useEffect, useRef, useState } from 'react';
import {
  Download,
  FileText,
  Image as ImageIcon,
  Play,
  AlertTriangle,
  Loader2,
  X,
} from 'lucide-react';
import type { AttachmentRef } from '../../lib/e2ee/events';
import {
  AttachmentError,
  attachmentKind,
  downloadAttachment,
  formatBytes,
  safeFileName,
} from '../../lib/e2ee/attachments';

type LoadState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; url: string; inline: boolean }
  | { status: 'error'; message: string };

function errorMessage(err: unknown): string {
  if (err instanceof AttachmentError) {
    if (err.code === 'EXPIRED') return 'Tệp đã hết hạn';
    if (err.code === 'INTEGRITY') return 'Tệp không hợp lệ, không thể hiển thị';
    return err.message;
  }
  return 'Không tải được tệp.';
}

/**
 * Decrypts on demand into a blob: URL that lives as long as the component (revoked on unmount). `inline` is true only
 * when the decrypted bytes are an allowlisted image or video of the claimed kind; otherwise the blob is opaque bytes.
 */
function useDecryptedUrl(conversationId: string, ref: AttachmentRef) {
  const [state, setState] = useState<LoadState>({ status: 'idle' });
  const urlRef = useRef<string | null>(null);

  useEffect(
    () => () => {
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    },
    [],
  );

  const load = async (): Promise<string | null> => {
    if (state.status === 'ready') return state.url;
    setState({ status: 'loading' });
    try {
      const { blob, inlineType } = await downloadAttachment(conversationId, ref);
      const url = URL.createObjectURL(blob);
      urlRef.current = url;
      setState({ status: 'ready', url, inline: inlineType !== null });
      return url;
    } catch (err) {
      setState({ status: 'error', message: errorMessage(err) });
      return null;
    }
  };

  return { state, load };
}

/** Saves through `a.download` only: blob: URLs are never opened in a tab, where their content would run as a page. */
function saveAs(url: string, name: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = safeFileName(name);
  a.rel = 'noopener';
  a.click();
}

function Lightbox({ url, name, onClose }: { url: string; name: string; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={name}
      onClick={onClose}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/85 p-4"
    >
      <button
        ref={closeRef}
        type="button"
        onClick={onClose}
        aria-label="Đóng"
        className="absolute right-4 top-4 rounded-full bg-white/10 p-2 text-white hover:bg-white/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
      >
        <X className="h-5 w-5" aria-hidden="true" />
      </button>
      <img
        src={url}
        alt={name}
        onClick={(e) => e.stopPropagation()}
        className="max-h-full max-w-full rounded-lg object-contain"
      />
    </div>
  );
}

function FileChip({
  ref_,
  state,
  onClick,
}: {
  ref_: AttachmentRef;
  state: LoadState;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Tải về ${ref_.name}`}
      className="flex w-full max-w-xs items-center gap-2.5 rounded-xl border border-zinc-200 bg-white px-3 py-2 text-left text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
    >
      <FileText className="h-6 w-6 shrink-0 text-red-500" aria-hidden="true" />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-xs font-medium">{ref_.name}</span>
        <span className="block text-[11px] text-zinc-600 dark:text-zinc-400">
          {state.status === 'error' ? state.message : formatBytes(ref_.size)}
        </span>
      </span>
      {state.status === 'loading' ? (
        <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
      ) : (
        <Download className="h-4 w-4 shrink-0" aria-hidden="true" />
      )}
    </button>
  );
}

function ImageAttachment({
  conversationId,
  ref_,
}: {
  conversationId: string;
  ref_: AttachmentRef;
}) {
  const { state, load } = useDecryptedUrl(conversationId, ref_);
  const [open, setOpen] = useState(false);
  const ratio = ref_.width && ref_.height ? `${ref_.width} / ${ref_.height}` : '4 / 3';
  const thumb = ref_.thumb ? `data:image/webp;base64,${ref_.thumb}` : null;

  if (state.status === 'ready' && !state.inline) {
    // Claimed to be an image, but the bytes are not one we render: offer the opaque bytes as a download.
    return <FileChip ref_={ref_} state={state} onClick={() => saveAs(state.url, ref_.name)} />;
  }
  if (state.status === 'ready') {
    return (
      <>
        <button
          type="button"
          onClick={() => setOpen(true)}
          aria-label={`Phóng to ảnh ${ref_.name}`}
          className="block rounded-xl focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
        >
          <img
            src={state.url}
            alt={ref_.name}
            style={{ aspectRatio: ratio }}
            className="w-full max-w-xs rounded-xl object-cover"
          />
        </button>
        {open && <Lightbox url={state.url} name={ref_.name} onClose={() => setOpen(false)} />}
      </>
    );
  }
  return (
    <button
      type="button"
      onClick={() => void load()}
      aria-label={`Xem ảnh ${ref_.name}`}
      style={{ aspectRatio: ratio }}
      className="relative block w-full max-w-xs overflow-hidden rounded-xl bg-zinc-200 dark:bg-zinc-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
    >
      {thumb ? (
        <img src={thumb} alt="" className="h-full w-full object-cover blur-[2px] scale-105" />
      ) : (
        <ImageIcon className="absolute inset-0 m-auto h-8 w-8 text-zinc-400" aria-hidden="true" />
      )}
      <span className="absolute inset-0 flex items-center justify-center">
        <span className="inline-flex items-center gap-1.5 rounded-full bg-black/60 px-3 py-1.5 text-xs font-medium text-white">
          {state.status === 'loading' ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          ) : state.status === 'error' ? (
            <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
          ) : (
            <ImageIcon className="h-3.5 w-3.5" aria-hidden="true" />
          )}
          {state.status === 'error' ? state.message : `Xem ảnh · ${formatBytes(ref_.size)}`}
        </span>
      </span>
    </button>
  );
}

function VideoAttachment({
  conversationId,
  ref_,
}: {
  conversationId: string;
  ref_: AttachmentRef;
}) {
  const { state, load } = useDecryptedUrl(conversationId, ref_);
  if (state.status === 'ready' && !state.inline) {
    return <FileChip ref_={ref_} state={state} onClick={() => saveAs(state.url, ref_.name)} />;
  }
  if (state.status === 'ready') {
    return (
      <video src={state.url} controls playsInline className="w-full max-w-xs rounded-xl bg-black">
        {ref_.name}
      </video>
    );
  }
  return (
    <button
      type="button"
      onClick={() => void load()}
      className="flex w-full max-w-xs items-center gap-2 rounded-xl bg-zinc-900 px-3 py-6 text-xs text-white focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500"
    >
      {state.status === 'loading' ? (
        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      ) : (
        <Play className="h-4 w-4" aria-hidden="true" />
      )}
      <span className="truncate">
        {state.status === 'error'
          ? state.message
          : `Phát video ${ref_.name} · ${formatBytes(ref_.size)}`}
      </span>
    </button>
  );
}

function FileAttachment({ conversationId, ref_ }: { conversationId: string; ref_: AttachmentRef }) {
  const { state, load } = useDecryptedUrl(conversationId, ref_);
  const save = async () => {
    const url = await load();
    if (url) saveAs(url, ref_.name);
  };
  return <FileChip ref_={ref_} state={state} onClick={() => void save()} />;
}

export function AttachmentList({
  conversationId,
  attachments,
}: {
  conversationId: string;
  attachments: AttachmentRef[];
}) {
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {attachments.map((a) =>
        attachmentKind(a.mime) === 'image' ? (
          <ImageAttachment key={a.id} conversationId={conversationId} ref_={a} />
        ) : attachmentKind(a.mime) === 'video' ? (
          <VideoAttachment key={a.id} conversationId={conversationId} ref_={a} />
        ) : (
          <FileAttachment key={a.id} conversationId={conversationId} ref_={a} />
        ),
      )}
    </div>
  );
}

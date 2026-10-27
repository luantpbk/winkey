'use client';

import React, { useState, useEffect, useRef } from 'react';
import type { PublicProfile } from '@winkey/api-client';
import { formatViews } from '../../../../lib/format';
import { SubscribeButton } from '../../../../components/social/subscribe-button';
import { RelationsModal } from '../../../../components/social/relations-modal';
import { BlockConfirmDialog } from '../../../../components/social/block-confirm-dialog';
import { ReportDialog } from '../../../../components/moderation/report-dialog';
import { A11Y_COLORS } from '../../../../lib/a11y-tokens';
import { api } from '../../../../lib/api-client';
import { useAuth } from '../../../../lib/auth/auth-context';
import { useToast } from '../../../../components/ui/toast';
import { MoreVertical, UserX, VolumeX, Volume2, Flag, Lock, ExternalLink } from 'lucide-react';

export type UserProfile = PublicProfile & {
  bio?: string | null;
  links?: Array<{ label?: string; url: string }>;
  banner_url?: string | null;
  is_private?: boolean;
};

export interface ChannelClientHeaderProps {
  profile: UserProfile;
  videoCount: number;
}

export function ChannelClientHeader({ profile, videoCount }: ChannelClientHeaderProps) {
  const { user, isAuthenticated } = useAuth();
  const { showToast } = useToast();

  const [subscriberCount, setSubscriberCount] = useState<number>(0);
  const [modalType, setModalType] = useState<'followers' | 'following' | null>(null);

  // Relationship & Action menu
  const [relationship, setRelationship] = useState<{
    following: boolean;
    follow_requested: boolean;
    blocking: boolean;
    muting: boolean;
  } | null>(null);

  const [showMenu, setShowMenu] = useState<boolean>(false);
  const [showBlockDialog, setShowBlockDialog] = useState<boolean>(false);
  const [showReportDialog, setShowReportDialog] = useState<boolean>(false);

  const menuRef = useRef<HTMLDivElement>(null);
  const isOwnChannel = Boolean(user && user.id === profile.id);

  // Close menu on click outside
  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setShowMenu(false);
      }
    }
    if (showMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showMenu]);

  // Fetch relationship if authenticated and not own channel
  useEffect(() => {
    let isMounted = true;
    async function fetchRelationship() {
      if (!isAuthenticated || isOwnChannel) return;
      try {
        const res = await api.social.GET('/v1/channels/{channel_id}/relationship', {
          params: { path: { channel_id: profile.id } },
        });
        if (res.response.ok && res.data && isMounted) {
          setRelationship({
            following: res.data.following,
            follow_requested: res.data.follow_requested,
            blocking: res.data.blocking,
            muting: res.data.muting,
          });
        }
      } catch {
        // Ignored
      }
    }
    void fetchRelationship();
    return () => {
      isMounted = false;
    };
  }, [isAuthenticated, isOwnChannel, profile.id]);

  const handleToggleMute = async () => {
    setShowMenu(false);
    if (!isAuthenticated) return;

    const isMuting = relationship?.muting;
    try {
      if (isMuting) {
        await api.social.DELETE('/v1/me/mutes/{user_id}', {
          params: { path: { user_id: profile.id } },
        });
        setRelationship((prev) => (prev ? { ...prev, muting: false } : null));
        showToast({ title: `Đã bỏ tắt tiếng @${profile.handle}`, type: 'success' });
      } else {
        await api.social.PUT('/v1/me/mutes/{user_id}', {
          params: { path: { user_id: profile.id } },
        });
        setRelationship((prev) => (prev ? { ...prev, muting: true } : null));
        showToast({ title: `Đã tắt tiếng @${profile.handle}`, type: 'success' });
      }
    } catch {
      showToast({ title: 'Thao tác thất bại.', type: 'error' });
    }
  };

  const handleConfirmBlock = async () => {
    await api.social.PUT('/v1/me/blocks/{user_id}', {
      params: { path: { user_id: profile.id } },
    });
    setRelationship((prev) =>
      prev ? { ...prev, blocking: true, following: false, follow_requested: false } : null,
    );
    showToast({ title: `Đã chặn @${profile.handle}`, type: 'success' });
  };

  const isBlocked = Boolean(relationship?.blocking);

  return (
    <div className="flex flex-col w-full">
      {/* Banner */}
      {profile.banner_url ? (
        <div className="w-full h-36 sm:h-52 md:h-64 rounded-2xl overflow-hidden mb-6 bg-zinc-800">
          <img
            src={profile.banner_url}
            alt={`${profile.display_name} banner`}
            className="w-full h-full object-cover"
          />
        </div>
      ) : (
        <div className="w-full h-24 sm:h-32 rounded-2xl bg-gradient-to-r from-zinc-800 via-zinc-900 to-black mb-6" />
      )}

      {/* Header Info */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 px-2">
        <div className="flex items-start sm:items-center gap-4 sm:gap-6">
          {profile.avatar_url ? (
            <img
              src={profile.avatar_url}
              alt={profile.display_name}
              className="h-20 w-20 sm:h-28 sm:w-28 rounded-full object-cover ring-4 ring-[#272727] shrink-0"
            />
          ) : (
            <div className="flex h-20 w-20 sm:h-28 sm:w-28 items-center justify-center rounded-full bg-[#D9002B] text-white font-bold text-3xl shrink-0">
              {profile.display_name.charAt(0)}
            </div>
          )}

          <div className="flex flex-col">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white">
                {profile.display_name}
              </h1>
              {profile.is_private && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold bg-zinc-100 dark:bg-zinc-800 text-zinc-600 dark:text-zinc-300 border border-zinc-200 dark:border-zinc-700">
                  <Lock className="w-3 h-3" />
                  <span>Riêng tư</span>
                </span>
              )}
            </div>

            <div
              className={`flex flex-wrap items-center gap-2 text-xs sm:text-sm ${A11Y_COLORS.textMuted} mt-1`}
            >
              <span className={`font-semibold ${A11Y_COLORS.textSecondary}`}>
                @{profile.handle}
              </span>
              <span>•</span>
              <button
                type="button"
                onClick={() => setModalType('followers')}
                className="hover:underline hover:text-white transition cursor-pointer"
              >
                {formatViews(subscriberCount)} người theo dõi
              </button>
              <span>•</span>
              <button
                type="button"
                onClick={() => setModalType('following')}
                className="hover:underline hover:text-white transition cursor-pointer"
              >
                Đang theo dõi
              </button>
              <span>•</span>
              <span>{videoCount} video</span>
            </div>

            {/* Bio (Plain text strictly, no dangerouslySetInnerHTML) */}
            {profile.bio && (
              <p className="mt-2.5 text-xs sm:text-sm text-zinc-600 dark:text-zinc-300 max-w-2xl whitespace-pre-line">
                {profile.bio}
              </p>
            )}

            {/* Links list */}
            {profile.links && profile.links.length > 0 && (
              <div className="flex flex-wrap items-center gap-3 mt-3">
                {profile.links.map((link, idx) => (
                  <a
                    key={idx}
                    href={link.url}
                    target="_blank"
                    rel="nofollow noopener ugc"
                    className="inline-flex items-center gap-1 text-xs text-red-500 hover:text-red-400 hover:underline transition"
                  >
                    <ExternalLink className="w-3 h-3" />
                    <span>{link.label || link.url.replace(/^https?:\/\//, '')}</span>
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3 self-start sm:self-center">
          {!isBlocked && (
            <SubscribeButton
              channelId={profile.id}
              initialRequested={relationship?.follow_requested}
              isBlocked={isBlocked}
              mode="follow"
              onSubscriberCountChange={setSubscriberCount}
              className="px-6 py-2.5 !text-sm"
            />
          )}

          {isBlocked && (
            <span className="px-4 py-2 rounded-full text-xs font-semibold bg-red-500/10 text-red-500 border border-red-500/30">
              Đã chặn
            </span>
          )}

          {/* More menu */}
          {!isOwnChannel && (
            <div ref={menuRef} className="relative">
              <button
                type="button"
                onClick={() => setShowMenu(!showMenu)}
                aria-label="Tuỳ chọn người dùng"
                className="p-2 rounded-full text-zinc-400 hover:text-white hover:bg-zinc-800 transition"
              >
                <MoreVertical className="w-5 h-5" />
              </button>

              {showMenu && (
                <div className="absolute right-0 top-full mt-1 w-44 rounded-xl bg-[#1f1f23] border border-zinc-800 p-1 shadow-2xl z-20 text-xs">
                  <button
                    type="button"
                    onClick={handleToggleMute}
                    className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-zinc-200 hover:bg-zinc-800 transition text-left"
                  >
                    {relationship?.muting ? (
                      <>
                        <Volume2 className="w-4 h-4 text-zinc-400" />
                        <span>Bỏ tắt tiếng</span>
                      </>
                    ) : (
                      <>
                        <VolumeX className="w-4 h-4 text-zinc-400" />
                        <span>Tắt tiếng</span>
                      </>
                    )}
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setShowMenu(false);
                      setShowBlockDialog(true);
                    }}
                    className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-red-400 hover:bg-red-500/10 transition text-left"
                  >
                    <UserX className="w-4 h-4" />
                    <span>Chặn @{profile.handle}</span>
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      setShowMenu(false);
                      setShowReportDialog(true);
                    }}
                    className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-zinc-200 hover:bg-zinc-800 transition text-left"
                  >
                    <Flag className="w-4 h-4 text-zinc-400" />
                    <span>Báo cáo</span>
                  </button>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Relations Modal */}
      {modalType && (
        <RelationsModal
          isOpen={true}
          channelId={profile.id}
          channelHandle={profile.handle}
          type={modalType}
          onClose={() => setModalType(null)}
        />
      )}

      {/* Block Confirm Dialog */}
      <BlockConfirmDialog
        isOpen={showBlockDialog}
        targetUser={{ handle: profile.handle, display_name: profile.display_name }}
        onClose={() => setShowBlockDialog(false)}
        onConfirmBlock={handleConfirmBlock}
      />

      {/* Report Dialog */}
      <ReportDialog
        isOpen={showReportDialog}
        onClose={() => setShowReportDialog(false)}
        targetType="USER"
        targetId={profile.id}
        targetTitle={profile.display_name}
      />
    </div>
  );
}

'use client';

import React, { useState } from 'react';
import type { PublicProfile } from '@winkey/api-client';
import { formatViews } from '../../../../lib/format';
import { SubscribeButton } from '../../../../components/social/subscribe-button';

export function ChannelClientHeader({
  profile,
  videoCount,
}: {
  profile: PublicProfile;
  videoCount: number;
}) {
  const [subscriberCount, setSubscriberCount] = useState<number>(0);

  return (
    <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 px-2">
      <div className="flex items-center gap-4 sm:gap-6">
        {profile.avatar_url ? (
          <img
            src={profile.avatar_url}
            alt={profile.display_name}
            className="h-20 w-20 sm:h-28 sm:w-28 rounded-full object-cover ring-4 ring-[#272727]"
          />
        ) : (
          <div className="flex h-20 w-20 sm:h-28 sm:w-28 items-center justify-center rounded-full bg-red-600 text-white font-bold text-3xl">
            {profile.display_name.charAt(0)}
          </div>
        )}

        <div className="flex flex-col">
          <h1 className="text-xl sm:text-2xl font-bold text-gray-900 dark:text-white">
            {profile.display_name}
          </h1>
          <div className="flex flex-wrap items-center gap-2 text-xs sm:text-sm text-gray-500 dark:text-gray-400 mt-1">
            <span className="font-semibold text-gray-700 dark:text-gray-300">
              @{profile.handle}
            </span>
            <span>•</span>
            <span>{formatViews(subscriberCount)} người đăng ký</span>
            <span>•</span>
            <span>{videoCount} video</span>
          </div>
        </div>
      </div>

      <SubscribeButton
        channelId={profile.id}
        onSubscriberCountChange={setSubscriberCount}
        className="self-start sm:self-center px-6 py-2.5 !text-sm"
      />
    </div>
  );
}

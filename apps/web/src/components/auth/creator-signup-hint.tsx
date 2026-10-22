'use client';

import React, { useState, useEffect } from 'react';
import { useAuth } from '../../lib/auth/auth-context';
import { computePermissions } from '../../lib/auth';
import { Link } from '../../i18n/routing';
import { Sparkles, X } from 'lucide-react';

export function CreatorSignupHintBanner() {
  const [showHint, setShowHint] = useState(false);
  const { can: rawCan, user, isAuthenticated } = useAuth();
  const can = rawCan ?? computePermissions(user, isAuthenticated);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      const isNewSignup =
        sessionStorage.getItem('winkey_new_signup_hint') === '1' ||
        new URLSearchParams(window.location.search).get('registered') === '1';

      if (isNewSignup && can.requestCreator) {
        setShowHint(true);
        sessionStorage.removeItem('winkey_new_signup_hint');
      }
    }
  }, [can.requestCreator]);

  if (!showHint) return null;

  return (
    <div
      data-testid="creator-signup-hint"
      className="bg-gradient-to-r from-red-600/90 to-amber-600/90 text-white px-4 py-2.5 text-xs flex items-center justify-between gap-3 shadow-lg z-40 relative animate-in fade-in slide-in-from-top-2 duration-300"
    >
      <div className="flex items-center gap-2 max-w-4xl mx-auto flex-1">
        <Sparkles className="h-4 w-4 shrink-0 text-yellow-300" />
        <span className="font-medium">Muốn đăng video? Gửi yêu cầu trở thành nhà sáng tạo.</span>
        <Link
          href="/nang-cap"
          className="ml-2 font-bold underline hover:text-yellow-200 transition"
        >
          Gửi yêu cầu ngay &rarr;
        </Link>
      </div>
      <button
        type="button"
        onClick={() => setShowHint(false)}
        aria-label="Đóng thông báo"
        className="p-1 hover:bg-white/20 rounded-md transition shrink-0"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

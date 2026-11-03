'use client';

import React, { useState, useEffect, useCallback } from 'react';
import { useRouter } from '../../../../i18n/routing';
import { useAuth } from '../../../../lib/auth/auth-context';
import { api } from '../../../../lib/api-client';
import type { SecuritySummary } from '@winkey/api-client';
import { ShieldCheck, ArrowLeft } from 'lucide-react';
import { Link } from '../../../../i18n/routing';

import { SecurityStatusCard } from '../../../../components/settings/security/security-status-card';
import { TotpSection } from '../../../../components/settings/security/totp-section';
import { PasskeysSection } from '../../../../components/settings/security/passkeys-section';
import { RecoveryCodesSection } from '../../../../components/settings/security/recovery-codes-section';
import { SessionsSection } from '../../../../components/settings/security/sessions-section';
import { ChatDevicesSection } from '../../../../components/settings/security/chat-devices-section';
import { ChatBackupSection } from '../../../../components/settings/security/chat-backup-section';
import { SecurityLogSection } from '../../../../components/settings/security/security-log-section';
import { StepUpDialog } from '../../../../components/auth/step-up-dialog';

export default function SecuritySettingsPage() {
  const router = useRouter();
  const { user, isAuthenticated, isLoading: authLoading } = useAuth();

  const [summary, setSummary] = useState<SecuritySummary | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [retryCallback, setRetryCallback] = useState<(() => Promise<void>) | null>(null);

  const fetchSecuritySummary = useCallback(async () => {
    try {
      const { data, response } = await api.auth.GET('/v1/auth/me/security');
      if (response.ok && data) {
        setSummary(data);
      }
    } catch (err) {
      console.error('Failed to load security summary', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!authLoading && !isAuthenticated) {
      router.push('/login?return_to=/cai-dat/bao-mat');
      return;
    }

    if (isAuthenticated) {
      fetchSecuritySummary();
    }
  }, [authLoading, isAuthenticated, router, fetchSecuritySummary]);

  const handleRequireStepUp = useCallback((onSuccessRetry: () => Promise<void>) => {
    setRetryCallback(() => onSuccessRetry);
    setStepUpOpen(true);
  }, []);

  const handleStepUpSuccess = useCallback(async () => {
    await fetchSecuritySummary();
    if (retryCallback) {
      try {
        await retryCallback();
      } catch (err) {
        console.error('Failed to execute retry action after step-up', err);
      }
      setRetryCallback(null);
    }
  }, [fetchSecuritySummary, retryCallback]);

  if (authLoading || isLoading || !user) {
    return (
      <div className="min-h-[60vh] flex items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-red-500 border-t-transparent" />
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 lg:px-8 py-8 space-y-8">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-zinc-200 dark:border-[#272727]">
        <div className="flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-2xl bg-red-500/10 text-red-500 border border-red-500/20">
            <ShieldCheck className="h-6 w-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-zinc-900 dark:text-white">
              Cài đặt bảo mật tài khoản
            </h1>
            <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-0.5">
              Quản lý xác thực hai lớp (2FA), khóa truy cập passkey, phiên đăng nhập và nhật ký bảo
              mật.
            </p>
          </div>
        </div>

        <div>
          <Link
            href="/settings/account"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs text-zinc-300 hover:text-white transition-colors"
          >
            <ArrowLeft className="w-3.5 h-3.5" />
            <span>Tài khoản & Hồ sơ</span>
          </Link>
        </div>
      </div>

      {summary && (
        <div className="space-y-8">
          {/* Summary Overview */}
          <SecurityStatusCard summary={summary} />

          {/* TOTP 2FA */}
          <TotpSection
            totpEnabled={summary.totp_enabled}
            onRefresh={fetchSecuritySummary}
            onRequireStepUp={handleRequireStepUp}
          />

          {/* Passkeys */}
          <PasskeysSection onRefresh={fetchSecuritySummary} onRequireStepUp={handleRequireStepUp} />

          {/* Recovery Codes */}
          <RecoveryCodesSection
            remainingCount={summary.recovery_codes_remaining}
            onRefresh={fetchSecuritySummary}
            onRequireStepUp={handleRequireStepUp}
          />

          {/* Sessions */}
          <SessionsSection onRequireStepUp={handleRequireStepUp} />

          {/* E2EE Chat Devices */}
          <ChatDevicesSection />

          {/* SOC-3b: passphrase key backup */}
          <ChatBackupSection />

          {/* Security Event Log */}
          <SecurityLogSection />
        </div>
      )}

      {/* Step-up Dialog */}
      <StepUpDialog
        isOpen={stepUpOpen}
        onClose={() => {
          setStepUpOpen(false);
          setRetryCallback(null);
        }}
        onSuccess={handleStepUpSuccess}
        securitySummary={summary}
      />
    </div>
  );
}

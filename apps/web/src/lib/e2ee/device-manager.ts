/**
 * Device Lifecycle Manager for Winkey E2EE Chat (ADR-049 §5 / SOC-3a)
 *
 * Responsibilities:
 * - Ensure local device is registered with chat-svc upon chat access
 * - Upload initial 50 one-time keys and fallback key
 * - Top up one-time keys when count < 20
 * - Unregister device on logout and wipe IndexedDB
 */

import { api } from '../api-client';
import { getE2eeClient, type E2eeClient } from './client';
import { clearConversationPreviews } from '../chat/preview-cache';

export function getDeviceDisplayName(): string {
  if (typeof navigator === 'undefined') {
    return 'Thiết bị Web';
  }

  const ua = navigator.userAgent;
  let browser = 'Trình duyệt Web';
  if (ua.includes('Edg/')) browser = 'Edge';
  else if (ua.includes('Chrome/')) browser = 'Chrome';
  else if (ua.includes('Firefox/')) browser = 'Firefox';
  else if (ua.includes('Safari/')) browser = 'Safari';

  let os = 'thiết bị';
  if (ua.includes('Windows')) os = 'Windows';
  else if (ua.includes('Macintosh') || ua.includes('Mac OS')) os = 'macOS';
  else if (ua.includes('Linux') && !ua.includes('Android')) os = 'Linux';
  else if (ua.includes('Android')) os = 'Android';
  else if (ua.includes('iPhone') || ua.includes('iPad')) os = 'iOS';

  return `${browser} trên ${os}`;
}

export class DeviceManager {
  private client: E2eeClient;
  private currentDeviceId: string | null = null;
  private initializedPromise: Promise<string> | null = null;

  constructor(client = getE2eeClient()) {
    this.client = client;
  }

  getDeviceId(): string | null {
    return this.currentDeviceId;
  }

  /**
   * Ensures the local browser device is initialized and registered with the server.
   * If new, registers device keys and uploads initial 50 OTKs + fallback key.
   * If existing, checks OTK count and tops up if count < 20.
   */
  async ensureDeviceRegistered(userId: string): Promise<string> {
    if (this.currentDeviceId) {
      return this.currentDeviceId;
    }

    if (this.initializedPromise) {
      return this.initializedPromise;
    }

    this.initializedPromise = (async () => {
      // 1. Initialize local Web Worker session (generates or restores from IDB)
      const initResult = await this.client.initSession(userId);
      this.currentDeviceId = initResult.deviceId;

      if (initResult.isNewDevice) {
        await this.register(initResult, initResult.oneTimeKeys);
      } else {
        // Existing device: check if OTK top-up is needed. A device that chat-svc does not know (404) was created
        // here but never registered, e.g. the page navigated away between saving the account and the PUT: register
        // it now with its own keys, or every send from it fails with 403 for the life of this browser profile.
        const known = await this.checkAndTopUpKeys(initResult.deviceId);
        if (known === false) {
          console.warn(
            '[DeviceManager] Local chat device is unknown to chat-svc; registering it again',
          );
          await this.register(initResult, await this.client.generateOneTimeKeys(50));
        }
      }

      return initResult.deviceId;
    })();

    // A failed attempt must not stick: the next call tries again.
    this.initializedPromise.catch(() => {
      this.initializedPromise = null;
      this.currentDeviceId = null;
    });

    return this.initializedPromise;
  }

  /** PUT the device (idempotent on chat-svc) and upload its one-time keys. */
  private async register(
    initResult: Awaited<ReturnType<E2eeClient['initSession']>>,
    oneTimeKeys: Awaited<ReturnType<E2eeClient['initSession']>>['oneTimeKeys'],
  ): Promise<void> {
    const { error: regError } = await api.chat.PUT('/v1/chat/devices/{device_id}', {
      params: { path: { device_id: initResult.deviceId } },
      body: {
        display_name: getDeviceDisplayName(),
        curve25519_key: initResult.curve25519Key,
        ed25519_key: initResult.ed25519Key,
        signature: initResult.signature,
        fallback_key: initResult.fallbackKey || undefined,
      },
    });

    if (regError) {
      console.error('[DeviceManager] Failed to register device with chat-svc:', regError);
      throw new Error('Không thể đăng ký thiết bị nhắn tin bảo mật.');
    }

    if (oneTimeKeys.length > 0) {
      const { error: otkError } = await api.chat.POST(
        '/v1/chat/devices/{device_id}/one-time-keys',
        {
          params: { path: { device_id: initResult.deviceId } },
          body: { keys: oneTimeKeys },
        },
      );

      if (otkError) {
        console.warn('[DeviceManager] Failed to upload initial one-time keys:', otkError);
      } else {
        await this.client.markKeysPublished();
      }
    }
  }

  /**
   * Tops up one-time keys when count on server falls below 20.
   */
  /** Returns false when chat-svc does not know this device (404), true or null (could not tell) otherwise. */
  async checkAndTopUpKeys(deviceId: string): Promise<boolean | null> {
    try {
      const { data, error, response } = await api.chat.GET(
        '/v1/chat/devices/{device_id}/one-time-keys',
        { params: { path: { device_id: deviceId } } },
      );
      if (response?.status === 404) return false;

      if (!error && data && data.count < 20) {
        const needed = 50 - data.count;
        if (needed > 0) {
          const newKeys = await this.client.generateOneTimeKeys(needed);
          const { error: uploadError } = await api.chat.POST(
            '/v1/chat/devices/{device_id}/one-time-keys',
            {
              params: { path: { device_id: deviceId } },
              body: { keys: newKeys },
            },
          );

          if (!uploadError) {
            await this.client.markKeysPublished();
          }
        }
      }
      return error ? null : true;
    } catch (err) {
      console.warn('[DeviceManager] Error checking or topping up OTKs:', err);
      return null;
    }
  }

  /**
   * Unregisters device on server and wipes local IndexedDB on logout.
   */
  async unregisterDeviceAndLogout(deviceId: string): Promise<void> {
    try {
      await api.chat.DELETE('/v1/chat/devices/{device_id}', {
        params: { path: { device_id: deviceId } },
      });
    } catch (err) {
      console.warn('[DeviceManager] Failed to unregister device from server:', err);
    }

    // Wipe local IndexedDB, and the in-memory previews decrypted with this device's keys
    await this.client.wipeDatabase();
    clearConversationPreviews();
    this.currentDeviceId = null;
    this.initializedPromise = null;
  }
}

let deviceManagerInstance: DeviceManager | null = null;

export function getDeviceManager(): DeviceManager {
  if (!deviceManagerInstance) {
    deviceManagerInstance = new DeviceManager();
  }
  return deviceManagerInstance;
}

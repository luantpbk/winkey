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
        // Register device on chat-svc
        const displayName = getDeviceDisplayName();

        const { error: regError } = await api.chat.PUT('/v1/chat/devices/{device_id}', {
          params: { path: { device_id: initResult.deviceId } },
          body: {
            display_name: displayName,
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

        // Upload initial 50 one-time keys
        if (initResult.oneTimeKeys.length > 0) {
          const { error: otkError } = await api.chat.POST(
            '/v1/chat/devices/{device_id}/one-time-keys',
            {
              params: { path: { device_id: initResult.deviceId } },
              body: {
                keys: initResult.oneTimeKeys,
              },
            },
          );

          if (otkError) {
            console.warn('[DeviceManager] Failed to upload initial one-time keys:', otkError);
          } else {
            await this.client.markKeysPublished();
          }
        }
      } else {
        // Existing device: check if OTK top-up is needed
        await this.checkAndTopUpKeys(initResult.deviceId);
      }

      return initResult.deviceId;
    })();

    return this.initializedPromise;
  }

  /**
   * Tops up one-time keys when count on server falls below 20.
   */
  async checkAndTopUpKeys(deviceId: string): Promise<void> {
    try {
      const { data, error } = await api.chat.GET('/v1/chat/devices/{device_id}/one-time-keys', {
        params: { path: { device_id: deviceId } },
      });

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
    } catch (err) {
      console.warn('[DeviceManager] Error checking or topping up OTKs:', err);
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

    // Wipe local IndexedDB
    await this.client.wipeDatabase();
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

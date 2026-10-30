/**
 * Canonical JSON serializer for Winkey E2EE (Matrix / RFC 8785 subset)
 * - Keys sorted lexicographically
 * - No whitespace
 * - UTF-8 output
 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJsonStringify).join(',')}]`;
  }

  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const pairs = sortedKeys.map((k) => `${JSON.stringify(k)}:${canonicalJsonStringify(obj[k])}`);
  return `{${pairs.join(',')}}`;
}

export interface DeviceKeysCanonicalParams {
  userId: string;
  deviceId: string;
  curve25519: string;
  ed25519: string;
}

export function buildDeviceKeysPayload(params: DeviceKeysCanonicalParams): string {
  return canonicalJsonStringify({
    algorithms: ['m.megolm.v1.aes-sha2', 'm.olm.v1.curve25519-aes-sha2'],
    curve25519: params.curve25519,
    device_id: params.deviceId,
    ed25519: params.ed25519,
    user_id: params.userId,
  });
}

export interface OneTimeKeyCanonicalParams {
  deviceId: string;
  keyId: string;
  key: string;
  fallback: boolean;
}

export function buildOneTimeKeyPayload(params: OneTimeKeyCanonicalParams): string {
  return canonicalJsonStringify({
    device_id: params.deviceId,
    fallback: params.fallback,
    key: params.key,
    key_id: params.keyId,
  });
}

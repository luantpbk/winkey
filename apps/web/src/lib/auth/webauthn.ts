import type { WebAuthnCredential } from '@winkey/api-client';

export function isWebAuthnSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    typeof navigator.credentials !== 'undefined'
  );
}

export function bufferToBase64Url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBuffer(base64url: string): ArrayBuffer {
  let base64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  while (base64.length % 4 !== 0) {
    base64 += '=';
  }
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes.buffer;
}

export function parseRequestOptions(options: any): CredentialRequestOptions {
  if (
    typeof window !== 'undefined' &&
    typeof (window.PublicKeyCredential as any)?.parseRequestOptionsFromJSON === 'function'
  ) {
    return (window.PublicKeyCredential as any).parseRequestOptionsFromJSON(options);
  }

  // Fallback conversion for WebAuthn Level 2 or test environments
  const publicKey = { ...options };
  if (typeof publicKey.challenge === 'string') {
    publicKey.challenge = base64UrlToBuffer(publicKey.challenge);
  }
  if (Array.isArray(publicKey.allowCredentials)) {
    publicKey.allowCredentials = publicKey.allowCredentials.map((c: any) => ({
      ...c,
      id: typeof c.id === 'string' ? base64UrlToBuffer(c.id) : c.id,
    }));
  }

  return { publicKey };
}

export function parseCreationOptions(options: any): CredentialCreationOptions {
  if (
    typeof window !== 'undefined' &&
    typeof (window.PublicKeyCredential as any)?.parseCreationOptionsFromJSON === 'function'
  ) {
    return (window.PublicKeyCredential as any).parseCreationOptionsFromJSON(options);
  }

  // Fallback conversion
  const publicKey = { ...options };
  if (typeof publicKey.challenge === 'string') {
    publicKey.challenge = base64UrlToBuffer(publicKey.challenge);
  }
  if (publicKey.user && typeof publicKey.user.id === 'string') {
    publicKey.user = {
      ...publicKey.user,
      id: base64UrlToBuffer(publicKey.user.id),
    };
  }
  if (Array.isArray(publicKey.excludeCredentials)) {
    publicKey.excludeCredentials = publicKey.excludeCredentials.map((c: any) => ({
      ...c,
      id: typeof c.id === 'string' ? base64UrlToBuffer(c.id) : c.id,
    }));
  }

  return { publicKey };
}

export function serializeCredential(credential: any): WebAuthnCredential {
  if (typeof credential?.toJSON === 'function') {
    return credential.toJSON() as WebAuthnCredential;
  }

  const rawId = credential.rawId ? bufferToBase64Url(credential.rawId) : credential.id;
  const resp = credential.response;

  const responseJson: Record<string, any> = {
    clientDataJSON: resp?.clientDataJSON ? bufferToBase64Url(resp.clientDataJSON) : '',
  };

  if (resp?.authenticatorData) {
    responseJson.authenticatorData = bufferToBase64Url(resp.authenticatorData);
  }
  if (resp?.signature) {
    responseJson.signature = bufferToBase64Url(resp.signature);
  }
  if (resp?.userHandle) {
    responseJson.userHandle = bufferToBase64Url(resp.userHandle);
  }
  if (resp?.attestationObject) {
    responseJson.attestationObject = bufferToBase64Url(resp.attestationObject);
  }
  if (resp?.getTransports && typeof resp.getTransports === 'function') {
    responseJson.transports = resp.getTransports();
  }

  return {
    id: credential.id,
    rawId,
    response: responseJson,
    authenticatorAttachment: credential.authenticatorAttachment ?? null,
    clientExtensionResults:
      typeof credential.getClientExtensionResults === 'function'
        ? credential.getClientExtensionResults()
        : {},
    type: 'public-key',
  } as unknown as WebAuthnCredential;
}

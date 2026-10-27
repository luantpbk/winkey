export interface TurnstileVerifyOptions {
  secret: string;
  token: string;
  ip?: string;
}

export async function verifyTurnstileToken(options: TurnstileVerifyOptions): Promise<boolean> {
  const { secret, token, ip } = options;
  if (!secret) return true; // Disabled
  if (!token) return false;

  try {
    const formData = new URLSearchParams();
    formData.append('secret', secret);
    formData.append('response', token);
    if (ip) {
      formData.append('remoteip', ip);
    }

    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      body: formData,
      signal: AbortSignal.timeout(3000),
    });

    if (!res.ok) {
      return false;
    }

    const data = (await res.json()) as { success?: boolean };
    return Boolean(data.success);
  } catch {
    return false;
  }
}

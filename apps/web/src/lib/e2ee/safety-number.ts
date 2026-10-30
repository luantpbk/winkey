/**
 * Safety Number derivation for Winkey E2EE (ADR-049 / SOC-3a)
 *
 * Algorithm derivation:
 * 1. Takes identity keys of both parties (Ed25519 public keys, unpadded Base64).
 * 2. Sorts the two keys lexicographically so initiator and receiver derive identical numbers.
 * 3. Hashes the canonical combination with SHA-512 via WebCrypto:
 *    SHA-512("winkey-safety-number:v1:" + sortedKey[0] + ":" + sortedKey[1])
 * 4. Extracts 12 chunks of 4 bytes (big-endian uint32) from the 64-byte digest.
 * 5. Maps each uint32 to a 5-digit decimal string via (val % 100000).padStart(5, '0').
 * 6. Produces 12 groups of 5 digits (60 decimal digits total), formatted with space separators:
 *    "12345 67890 ..."
 */

export async function computeSafetyNumber(
  keyA: string,
  keyB: string,
): Promise<{ rawDigits: string; formatted: string; groups: string[] }> {
  if (!keyA || !keyB) {
    throw new Error('computeSafetyNumber requires two valid identity keys');
  }

  // Symmetrical sorting ensures both devices generate the identical safety number
  const sorted = [keyA, keyB].sort();
  const input = new TextEncoder().encode(`winkey-safety-number:v1:${sorted[0]}:${sorted[1]}`);

  const digestBuffer = await crypto.subtle.digest('SHA-512', input);
  const view = new DataView(digestBuffer);

  const groups: string[] = [];
  for (let i = 0; i < 12; i++) {
    // Read 32-bit big-endian unsigned integer (uses 12 * 4 = 48 bytes out of 64 bytes)
    const uint32 = view.getUint32(i * 4, false);
    const chunk = (uint32 % 100_000).toString().padStart(5, '0');
    groups.push(chunk);
  }

  const rawDigits = groups.join('');
  const formatted = groups.join(' ');

  return {
    rawDigits,
    formatted,
    groups,
  };
}

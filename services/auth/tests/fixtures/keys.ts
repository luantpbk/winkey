import crypto from 'node:crypto';

let testKeyPair: { privateKey: string; publicKey: string } | null = null;
let previousKeyPair: { privateKey: string; publicKey: string } | null = null;

export function getTestKeys(): {
  privateKey: string;
  publicKey: string;
  previousPrivateKey: string;
  previousPublicKey: string;
} {
  if (!testKeyPair) {
    const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    testKeyPair = { privateKey, publicKey };

    const prev = crypto.generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    previousKeyPair = { privateKey: prev.privateKey, publicKey: prev.publicKey };
  }

  return {
    privateKey: testKeyPair.privateKey,
    publicKey: testKeyPair.publicKey,
    previousPrivateKey: previousKeyPair!.privateKey,
    previousPublicKey: previousKeyPair!.publicKey,
  };
}

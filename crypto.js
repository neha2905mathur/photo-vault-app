// Photo Vault - encryption helpers (WebCrypto only, runs in browser and Node 20+).
// Key = PBKDF2-SHA256(passphrase, salt) -> AES-256-GCM. Passphrase never leaves the device.
export const ITER = 210000;
const enc = new TextEncoder();

export function randBytes(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

export async function deriveKey(passphrase, salt, iterations = ITER) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// Output layout: [12-byte IV][ciphertext + 16-byte GCM tag]
// additionalData binds each blob to its own place (item id + chunk number),
// so a blob cannot be silently swapped into another file or position.
export async function encryptBytes(key, data, aad) {
  const iv = randBytes(12);
  const params = { name: 'AES-GCM', iv };
  if (aad) params.additionalData = enc.encode(aad);
  const ct = new Uint8Array(await crypto.subtle.encrypt(params, key, data));
  const out = new Uint8Array(12 + ct.length);
  out.set(iv, 0);
  out.set(ct, 12);
  return out;
}

export async function decryptBytes(key, blob, aad) {
  const params = { name: 'AES-GCM', iv: blob.subarray(0, 12) };
  if (aad) params.additionalData = enc.encode(aad);
  return new Uint8Array(await crypto.subtle.decrypt(params, key, blob.subarray(12)));
}

export const b64 = {
  encode(bytes) {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return btoa(s);
  },
  decode(str) {
    const bin = atob(str.replace(/\s/g, ''));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  },
};

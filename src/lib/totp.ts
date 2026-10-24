// RFC 6238 TOTP (30-second steps, 6 digits, HMAC-SHA1) for authenticator apps, plus secret encryption.
import { b64, fromB64 } from './crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export function base32Encode(bytes: Uint8Array): string {
  let bits = 0, value = 0, out = '';
  for (const b of bytes) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}
export function base32Decode(s: string): Uint8Array {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch); bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return new Uint8Array(out);
}

export async function hotp(secret: Uint8Array, counter: number): Promise<string> {
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) { msg[i] = c & 255; c = Math.floor(c / 256); }
  const key = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const h = new Uint8Array(await crypto.subtle.sign('HMAC', key, msg));
  const o = h[h.length - 1] & 15;
  const bin = ((h[o] & 127) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

/** Returns the matched time step (to block replays), or 0 when the code is wrong. Accepts ±1 step of clock drift. */
export async function verifyTotp(secretB32: string, code: string, lastStep: number, now = Date.now()): Promise<number> {
  if (!/^\d{6}$/.test(String(code || '').trim())) return 0;
  const secret = base32Decode(secretB32);
  const step = Math.floor(now / 30000);
  for (const s of [step, step - 1, step + 1]) {
    if (s <= lastStep) continue;
    if ((await hotp(secret, s)) === String(code).trim()) return s;
  }
  return 0;
}

export const newTotpSecret = () => base32Encode(crypto.getRandomValues(new Uint8Array(20)));
export const otpauthUri = (secret: string, account: string, issuer = 'Lab of Future CRM') =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

// ---------- AES-GCM encryption of MFA secrets at rest ----------
async function aesKey(serverSecret: string) {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serverSecret + ':mfa-secret-v1'));
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
export async function encryptSecret(plain: string, serverSecret: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await aesKey(serverSecret), new TextEncoder().encode(plain));
  return `v1.${b64(iv)}.${b64(ct)}`;
}
export async function decryptSecret(stored: string, serverSecret: string): Promise<string> {
  const [, iv, ct] = String(stored).split('.');
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, await aesKey(serverSecret), fromB64(ct));
  return new TextDecoder().decode(pt);
}

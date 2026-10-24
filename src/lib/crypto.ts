const enc = new TextEncoder();

export const toHex = (buf: ArrayBuffer | Uint8Array) =>
  [...new Uint8Array(buf as ArrayBuffer)].map((b) => b.toString(16).padStart(2, '0')).join('');

export function b64(buf: ArrayBuffer | Uint8Array): string {
  let s = '';
  for (const b of new Uint8Array(buf as ArrayBuffer)) s += String.fromCharCode(b);
  return btoa(s);
}
export function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export const b64url = (buf: ArrayBuffer | Uint8Array | string) =>
  (typeof buf === 'string' ? btoa(unescape(encodeURIComponent(buf))) : b64(buf)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
export const fromB64url = (s: string) => fromB64(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));

export async function hmacSha256(secret: string, data: string | Uint8Array): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', key, typeof data === 'string' ? enc.encode(data) : data);
}
export const hmacSha256Hex = async (secret: string, data: string | Uint8Array) => toHex(await hmacSha256(secret, data));

export async function sha256Hex(data: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', enc.encode(data)));
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ab = enc.encode(a), bb = enc.encode(b);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < Math.max(ab.length, bb.length); i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

// ---------- passwords (PBKDF2-SHA256, 100k iterations = Workers maximum) ----------
export async function hashPassword(password: string, iterations = 100000): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, iterations);
  return `pbkdf2_sha256$${iterations}$${b64(salt)}$${b64(hash)}`;
}
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, iter, salt, hash] = String(stored).split('$');
  if (alg !== 'pbkdf2_sha256') return false;
  const h = await pbkdf2(password, fromB64(salt), +iter);
  return safeEqual(b64(h), hash);
}
async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<ArrayBuffer> {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
}

// ---------- JWT (HS256) ----------
export async function signJwt(payload: Record<string, unknown>, secret: string, ttlSec = 12 * 3600): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const body = { iat: now, exp: now + ttlSec, ...payload };
  const head = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const pl = b64url(JSON.stringify(body));
  const sig = b64url(await hmacSha256(secret, `${head}.${pl}`));
  return `${head}.${pl}.${sig}`;
}
export async function verifyJwt<T = any>(token: string, secret: string): Promise<T | null> {
  const [h, p, s] = String(token).split('.');
  if (!h || !p || !s) return null;
  const expected = b64url(await hmacSha256(secret, `${h}.${p}`));
  if (!safeEqual(expected, s)) return null;
  try {
    const body = JSON.parse(new TextDecoder().decode(fromB64url(p)));
    if (body.exp && body.exp < Math.floor(Date.now() / 1000)) return null;
    return body;
  } catch {
    return null;
  }
}

// ---------- RS256 (Google service-account JWT) ----------
export async function signRs256(payload: Record<string, unknown>, pemPrivateKey: string): Promise<string> {
  const pem = pemPrivateKey.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const key = await crypto.subtle.importKey('pkcs8', fromB64(pem), { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const pl = b64url(JSON.stringify(payload));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(`${head}.${pl}`));
  return `${head}.${pl}.${b64url(sig)}`;
}

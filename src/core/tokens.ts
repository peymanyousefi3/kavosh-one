import { createHash, randomBytes } from 'node:crypto';

export function mintToken() { return `kvo_${randomBytes(32).toString('base64url')}`; }
export function hashToken(token: string) { return createHash('sha256').update(token).digest('hex'); }
export function parseBearer(header: string | null) {
  const match = /^Bearer (kvo_[A-Za-z0-9_-]{43})$/.exec(header ?? '');
  if (!match) return null;
  return match[1];
}

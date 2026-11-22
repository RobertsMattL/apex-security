import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

/**
 * Server secrets, derived from one random master key kept in data/secret.key (mode 0600).
 * - enc:  AES-256-GCM for camera credentials at rest
 * - jwt:  HS256 signing key for access/stream tokens
 * - url:  HMAC key for signed image URLs
 */
export class Secrets {
  readonly jwtKey: Uint8Array;
  private readonly encKey: Buffer;
  private readonly urlKey: Buffer;
  /** Random per-process credentials the server's own RTSP readers (detector, snapshots) use. */
  readonly internalRtspUser = 'internal';
  readonly internalRtspPass = randomBytes(18).toString('base64url');

  constructor(master: Buffer) {
    const derive = (info: string) => Buffer.from(hkdfSync('sha256', master, Buffer.alloc(0), info, 32));
    this.encKey = derive('camera-credentials');
    this.jwtKey = new Uint8Array(derive('jwt'));
    this.urlKey = derive('signed-urls');
  }

  static load(path: string): Secrets {
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, randomBytes(32).toString('base64'), { mode: 0o600 });
    }
    chmodSync(path, 0o600);
    return new Secrets(Buffer.from(readFileSync(path, 'utf8').trim(), 'base64'));
  }

  encrypt(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.encKey, iv);
    const data = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
  }

  decrypt(blob: string): string {
    const [v, iv, tag, data] = blob.split('.');
    if (v !== 'v1') throw new Error('unknown ciphertext version');
    const d = createDecipheriv('aes-256-gcm', this.encKey, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]).toString('utf8');
  }

  sign(value: string): string {
    return createHmac('sha256', this.urlKey).update(value).digest('base64url');
  }

  verify(value: string, sig: string): boolean {
    const a = Buffer.from(this.sign(value));
    const b = Buffer.from(sig);
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, salt, key] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(key, 'base64url');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64url'), expected.length);
  return timingSafeEqual(actual, expected);
}

export function sha256(s: string): string {
  return createHmac('sha256', 'refresh').update(s).digest('base64url');
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

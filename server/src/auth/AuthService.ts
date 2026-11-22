import { randomUUID, timingSafeEqual } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { DB } from '../db/database.js';
import { hashPassword, randomToken, sha256, verifyPassword, type Secrets } from '../util/secrets.js';

export interface Principal {
  userId: string;
  deviceId: string;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  deviceId: string;
  userId: string;
}

const ACCESS_TTL_SEC = 15 * 60;
const STREAM_TTL_SEC = 10 * 60;

export class AuthError extends Error {
  constructor(message: string, readonly status = 401) {
    super(message);
  }
}

/**
 * Users, devices and tokens.
 * Every client is a device: login creates (or re-keys) a device row, and notification
 * delivery is tracked per device. Refresh tokens are stored hashed and rotated on use.
 */
export class AuthService {
  constructor(private db: DB, private secrets: Secrets) {}

  hasUsers(): boolean {
    return !!this.db.prepare('SELECT 1 FROM users LIMIT 1').get();
  }

  async createUser(username: string, password: string): Promise<string> {
    if (password.length < 8) throw new AuthError('password must be at least 8 characters', 400);
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO users (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run(id, username, await hashPassword(password), Date.now());
    return id;
  }

  async login(username: string, password: string, device: { name: string; platform?: string; deviceId?: string }): Promise<TokenPair> {
    const user = this.db.prepare('SELECT id, password_hash FROM users WHERE username = ?').get(username) as
      | { id: string; password_hash: string }
      | undefined;
    // Always run a hash so response timing doesn't reveal whether the user exists.
    const ok = user ? await verifyPassword(password, user.password_hash) : (await hashPassword(password), false);
    if (!user || !ok) throw new AuthError('invalid credentials');

    const refresh = randomToken();
    let deviceId = device.deviceId;
    const existing = deviceId
      ? (this.db.prepare('SELECT id FROM devices WHERE id = ? AND user_id = ?').get(deviceId, user.id) as { id: string } | undefined)
      : undefined;
    if (existing) {
      this.db.prepare('UPDATE devices SET refresh_hash = ?, revoked = 0, name = ?, last_seen_at = ? WHERE id = ?')
        .run(sha256(refresh), device.name, Date.now(), existing.id);
    } else {
      deviceId = randomUUID();
      this.db
        .prepare('INSERT INTO devices (id, user_id, name, platform, refresh_hash, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(deviceId, user.id, device.name, device.platform ?? 'unknown', sha256(refresh), Date.now(), Date.now());
    }
    return { accessToken: await this.accessToken(user.id, deviceId!), refreshToken: `${deviceId}.${refresh}`, expiresIn: ACCESS_TTL_SEC, deviceId: deviceId!, userId: user.id };
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const dot = refreshToken.indexOf('.');
    const deviceId = refreshToken.slice(0, dot);
    const secret = refreshToken.slice(dot + 1);
    const row = this.db.prepare('SELECT user_id, refresh_hash, revoked FROM devices WHERE id = ?').get(deviceId) as
      | { user_id: string; refresh_hash: string | null; revoked: number }
      | undefined;
    if (!row || row.revoked || !row.refresh_hash || row.refresh_hash !== sha256(secret)) throw new AuthError('invalid refresh token');
    const next = randomToken();
    this.db.prepare('UPDATE devices SET refresh_hash = ?, last_seen_at = ? WHERE id = ?').run(sha256(next), Date.now(), deviceId);
    return { accessToken: await this.accessToken(row.user_id, deviceId), refreshToken: `${deviceId}.${next}`, expiresIn: ACCESS_TTL_SEC, deviceId, userId: row.user_id };
  }

  revokeDevice(userId: string, deviceId: string) {
    this.db.prepare('UPDATE devices SET revoked = 1, refresh_hash = NULL WHERE id = ? AND user_id = ?').run(deviceId, userId);
  }

  listDevices(userId: string) {
    return this.db
      .prepare('SELECT id, name, platform, created_at AS createdAt, last_seen_at AS lastSeenAt FROM devices WHERE user_id = ? AND revoked = 0 ORDER BY created_at')
      .all(userId);
  }

  touchDevice(deviceId: string) {
    this.db.prepare('UPDATE devices SET last_seen_at = ? WHERE id = ?').run(Date.now(), deviceId);
  }

  private accessToken(userId: string, deviceId: string) {
    return new SignJWT({ did: deviceId, typ: 'access' })
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject(userId)
      .setIssuedAt()
      .setExpirationTime(`${ACCESS_TTL_SEC}s`)
      .sign(this.secrets.jwtKey);
  }

  async verifyAccess(token: string): Promise<Principal> {
    try {
      const { payload } = await jwtVerify(token, this.secrets.jwtKey, { algorithms: ['HS256'] });
      if (payload.typ !== 'access' || !payload.sub || typeof payload.did !== 'string') throw new Error('wrong token type');
      const dev = this.db.prepare('SELECT revoked FROM devices WHERE id = ?').get(payload.did) as { revoked: number } | undefined;
      if (!dev || dev.revoked) throw new Error('device revoked');
      return { userId: payload.sub, deviceId: payload.did };
    } catch {
      throw new AuthError('invalid or expired token');
    }
  }

  /**
   * Short-lived token a client uses as its RTSP password to play one camera through MediaMTX.
   * Deliberately compact (`<exp base36>.<hmac>`, ~35 chars): many RTSP clients, including
   * ffmpeg-based ones, truncate credentials longer than ~127 bytes, so a JWT won't fit.
   */
  async streamToken(_principal: Principal, cameraId: string): Promise<string> {
    const exp = Math.floor(Date.now() / 1000) + STREAM_TTL_SEC;
    return `${exp.toString(36)}.${this.secrets.sign(`stream:${cameraId}:${exp}`).slice(0, 27)}`;
  }

  async verifyStream(token: string, cameraId: string): Promise<boolean> {
    const [e, sig] = token.split('.');
    const exp = parseInt(e ?? '', 36);
    if (!sig || !Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
    const expected = this.secrets.sign(`stream:${cameraId}:${exp}`).slice(0, 27);
    return expected.length === sig.length && timingSafeEqual(Buffer.from(expected), Buffer.from(sig));
  }
}

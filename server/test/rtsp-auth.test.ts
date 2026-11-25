import { describe, expect, it } from 'vitest';
import type { Config } from '../src/config.js';
import { TacticalRtspAdapter } from '../src/rtsp/TacticalRtspAdapter.js';
import type { Secrets } from '../src/util/secrets.js';

const secrets = { internalRtspUser: 'internal', internalRtspPass: 'pw' } as Secrets;
const config = { mediamtx: { apiPort: 1, rtspPort: 8564 }, ffmpeg: 'ffmpeg' } as unknown as Config;
const adapter = new TacticalRtspAdapter(config, secrets, async (cam, token) => cam === 'c1' && token === 'good');
const internal = { user: 'internal', password: 'pw', ip: '127.0.0.1' };

describe('MediaMTX auth hook', () => {
  it('lets clients read camera and viewer paths only with a valid stream token', async () => {
    for (const path of ['cam_c1', 'live_c1']) {
      expect(await adapter.authorize({ action: 'read', path, user: 'stream', password: 'good', ip: '192.168.1.5' })).toBe(true);
      expect(await adapter.authorize({ action: 'read', path, user: 'stream', password: 'bad', ip: '192.168.1.5' })).toBe(false);
    }
    expect(await adapter.authorize({ action: 'read', path: 'live_c2', user: 'stream', password: 'good', ip: '192.168.1.5' })).toBe(false);
    expect(await adapter.authorize({ action: 'read', path: 'other', user: 'stream', password: 'good', ip: '192.168.1.5' })).toBe(false);
  });

  it('allows publishing only into viewer paths, from localhost, with the internal credentials', async () => {
    expect(await adapter.authorize({ action: 'publish', path: 'live_c1', ...internal })).toBe(true);
    expect(await adapter.authorize({ action: 'publish', path: 'cam_c1', ...internal })).toBe(false);
    expect(await adapter.authorize({ action: 'publish', path: 'live_c1', ...internal, ip: '192.168.1.5' })).toBe(false);
    expect(await adapter.authorize({ action: 'publish', path: 'live_c1', ...internal, password: 'x' })).toBe(false);
    expect(await adapter.authorize({ action: 'publish', path: 'live_c1', user: 'stream', password: 'good', ip: '127.0.0.1' })).toBe(false);
  });

  it('hands clients the viewer path', () => {
    expect(adapter.clientReadUrl('c1', 'h', 't')).toBe('rtsp://stream:t@h:8564/live_c1');
  });
});

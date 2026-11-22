import type { ListenerSettings } from '../detection/types.js';

export type CameraStatus = {
  /** Stream health as seen by MediaMTX. */
  stream: 'online' | 'connecting' | 'offline' | 'disabled';
  /** Detection worker health. */
  detector: 'off' | 'starting' | 'running' | 'error';
  /** Source details when online (codec/resolution) from MediaMTX. */
  tracks?: string[];
  readers?: number;
  since: number;
  message?: string;
};

/** What clients see. Credentials are never returned, only whether they exist. */
export interface CameraDto {
  id: string;
  name: string;
  rtspUrl: string;
  hasCredentials: boolean;
  transport: 'automatic' | 'tcp' | 'udp';
  enabled: boolean;
  notificationsEnabled: boolean;
  listeners: ListenerSettings[];
  status: CameraStatus;
  createdAt: number;
  updatedAt: number;
}

export interface CameraInput {
  name: string;
  rtspUrl: string;
  username?: string | null;
  password?: string | null;
  transport?: 'automatic' | 'tcp' | 'udp';
  enabled?: boolean;
}

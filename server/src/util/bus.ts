import { EventEmitter } from 'node:events';
import type { CameraDto, CameraStatus } from '../cameras/types.js';
import type { ListenerSettings } from '../detection/types.js';
import type { NotificationDto } from '../notifications/types.js';

/** In-process event bus: modules publish domain events; the WebSocket gateway fans them out. */
export interface BusEvents {
  'camera.status': [cameraId: string, status: CameraStatus];
  'camera.upserted': [camera: CameraDto];
  'camera.removed': [cameraId: string];
  'settings.updated': [cameraId: string, settings: { notificationsEnabled: boolean; listeners: ListenerSettings[] }];
  'notification.read': [notificationId: string, userId: string, readAt: number];
  'event.created': [event: { id: string; cameraId: string; kind: string }];
  'notification.created': [n: NotificationDto];
  'event.clip': [e: { id: string; cameraId: string; clipState: 'ready' | 'failed'; clipDurationSec: number | null }];
  'events.deleted': [eventIds: string[], notificationIds: string[]];
}

export class Bus extends EventEmitter<BusEvents> {}

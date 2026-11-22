export type DeliveryState = 'pending' | 'delivered' | 'received' | 'read' | 'expired';

/** Notification as sent to one device. `imageUrl` is a signed, expiring path on this server. */
export interface NotificationDto {
  id: string;
  eventId: string;
  cameraId: string;
  cameraName: string;
  kind: string;
  label: string;
  confidence: number;
  title: string;
  body: string;
  createdAt: number;
  imageUrl: string | null;
  state?: DeliveryState;
  readAt?: number | null;
}

/** How the notification service reaches devices (the WebSocket gateway implements this). */
export interface DeliveryTransport {
  connectedDevices(): string[];
  isConnected(deviceId: string): boolean;
  /** Returns false if the message could not be written to the device's socket. */
  send(deviceId: string, msg: unknown): boolean;
}

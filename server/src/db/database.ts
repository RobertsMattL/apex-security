import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Persistence layer: SQLite via Node's built-in node:sqlite (no native addon to build).
 * Schema is applied as ordered migrations tracked in PRAGMA user_version.
 */
const MIGRATIONS: string[] = [
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE devices (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT 'unknown',
    refresh_hash TEXT,
    revoked INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER
  );
  CREATE TABLE cameras (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    rtsp_url TEXT NOT NULL,          -- without credentials
    username_enc TEXT,               -- AES-GCM, see crypto/secrets.ts
    password_enc TEXT,
    transport TEXT NOT NULL DEFAULT 'automatic',
    enabled INTEGER NOT NULL DEFAULT 1,
    notifications_enabled INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  -- One row per (camera, detection kind). New kinds need no schema change.
  CREATE TABLE detection_listeners (
    camera_id TEXT NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    notify INTEGER NOT NULL DEFAULT 1,
    min_confidence REAL NOT NULL DEFAULT 0.5,
    cooldown_sec INTEGER NOT NULL DEFAULT 60,  -- also the event clip length (see migration 2)
    PRIMARY KEY (camera_id, kind)
  );
  CREATE TABLE events (
    id TEXT PRIMARY KEY,
    camera_id TEXT NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    label TEXT NOT NULL,
    confidence REAL NOT NULL,
    track_id INTEGER,
    box TEXT,
    frame_w INTEGER,
    frame_h INTEGER,
    image_path TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX events_camera_time ON events(camera_id, created_at DESC);
  CREATE INDEX events_time ON events(created_at DESC);
  CREATE TABLE notifications (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
    camera_id TEXT NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX notifications_time ON notifications(created_at DESC);
  -- Delivery tracked independently per intended device.
  -- state: pending (not yet sent) -> delivered (written to socket) -> received (client ack) -> read (viewed)
  CREATE TABLE deliveries (
    notification_id TEXT NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
    device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL,
    last_sent_at INTEGER,
    received_at INTEGER,
    read_at INTEGER,
    PRIMARY KEY (notification_id, device_id)
  );
  CREATE INDEX deliveries_due ON deliveries(device_id, state, next_attempt_at);
  `,
  // Event video clips. The cooldown now doubles as the clip length, so the old long
  // defaults (60 s / 120 s) become 10 s.
  `
  ALTER TABLE events ADD COLUMN clip_state TEXT;
  ALTER TABLE events ADD COLUMN clip_path TEXT;
  ALTER TABLE events ADD COLUMN clip_duration REAL;
  UPDATE detection_listeners SET cooldown_sec = 10;
  `,
];

export type DB = DatabaseSync;

export function openDatabase(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  const version = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let v = version; v < MIGRATIONS.length; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
  return db;
}

export function tx<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

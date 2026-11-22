import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { logger } from './util/log.js';

const log = logger('main');
const app = await createApp(loadConfig());

let stopping = false;
const shutdown = async (sig: string) => {
  if (stopping) return;
  stopping = true;
  log.info(`${sig}: shutting down`);
  const force = setTimeout(() => process.exit(1), 8000);
  force.unref();
  await app.stop().catch((e) => log.error('shutdown error', e));
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.start();

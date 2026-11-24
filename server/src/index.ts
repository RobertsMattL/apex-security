import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { logger } from './util/log.js';

const log = logger('main');

// Never die silently: record the cause with its stack. A failed async task is logged
// and the server keeps running; a synchronous crash exits so the supervisor
// (scripts/run-server.sh under launchd) restarts it.
const describe = (e: unknown) => (e instanceof Error ? e.stack ?? e.message : String(e));
process.on('unhandledRejection', (e) => log.error(`unhandled rejection: ${describe(e)}`));
process.on('uncaughtException', (e) => {
  log.error(`uncaught exception, exiting: ${describe(e)}`);
  process.exitCode = 1;
  setTimeout(() => process.exit(1), 100).unref();
  void app?.stop().catch(() => {});
});
process.on('exit', (code) => log.info(`process exit (code ${code})`));
let app: Awaited<ReturnType<typeof createApp>> | undefined;
app = await createApp(loadConfig());

let stopping = false;
const shutdown = async (sig: string) => {
  if (stopping) return;
  stopping = true;
  log.info(`${sig}: shutting down`);
  const force = setTimeout(() => process.exit(1), 8000);
  force.unref();
  await app!.stop().catch((e) => log.error('shutdown error', e));
  process.exit(0);
};
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.start();

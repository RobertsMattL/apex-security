/** Minimal structured logger: `[scope] message` to stderr, quiet under tests. */
const quiet = process.env.VITEST === 'true' && !process.env.DEBUG;
export function logger(scope: string) {
  const out = (level: string, msg: string, extra?: unknown) => {
    if (quiet && level !== 'error') return;
    const line = `${new Date().toISOString()} ${level.padEnd(5)} [${scope}] ${msg}`;
    console.error(extra === undefined ? line : `${line} ${extra instanceof Error ? extra.message : JSON.stringify(extra)}`);
  };
  return {
    info: (m: string, x?: unknown) => out('info', m, x),
    warn: (m: string, x?: unknown) => out('warn', m, x),
    error: (m: string, x?: unknown) => out('error', m, x),
    debug: (m: string, x?: unknown) => process.env.DEBUG && out('debug', m, x),
  };
}
export type Logger = ReturnType<typeof logger>;

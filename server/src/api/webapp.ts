import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { projectRoot } from '../config.js';

const root = join(projectRoot, 'web');
const types: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

/** Serves the browser console (web/) at /. Files are read per request so edits apply without a restart. */
export function registerWebApp(app: FastifyInstance) {
  const serve = async (rel: string, reply: import('fastify').FastifyReply) => {
    const file = normalize(join(root, rel));
    if (!file.startsWith(root)) return reply.code(404).send();
    try {
      const body = await readFile(file);
      return reply
        .header('Cache-Control', 'no-cache')
        .header('X-Content-Type-Options', 'nosniff')
        .header('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'")
        .type(types[extname(file)] ?? 'application/octet-stream')
        .send(body);
    } catch {
      return reply.code(404).send({ error: 'not found' });
    }
  };
  app.get('/', (_req, reply) => serve('index.html', reply));
  app.get('/web/*', (req, reply) => serve((req.params as { '*': string })['*'], reply));
}

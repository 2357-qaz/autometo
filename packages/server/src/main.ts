// Entry point: `automedo-server`. Configuration via environment variables.
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { createApp, VERSION } from './app';
import { openDb } from './db';

const env = process.env;
const token = env.AUTOMEDO_TOKEN?.trim() || null;
const insecure = env.AUTOMEDO_INSECURE === '1';
if (!token && !insecure) {
  console.error('AUTOMEDO_TOKEN is required (a long random string). For local testing only: AUTOMEDO_INSECURE=1.');
  process.exit(1);
}
if (token && token.length < 16) {
  console.error('AUTOMEDO_TOKEN must be at least 16 characters.');
  process.exit(1);
}
// Relative paths are relative to where the user launched from (npm -w changes cwd).
const cwd = env.INIT_CWD ?? process.cwd();
const dbPath = resolve(cwd, env.AUTOMEDO_DB ?? './data/automedo.db');
mkdirSync(dirname(dbPath), { recursive: true });
const db = openDb(dbPath);
const host = env.HOST ?? '127.0.0.1';
const port = Number(env.PORT ?? 8787);
const webDir = env.AUTOMEDO_WEB_DIR ? resolve(cwd, env.AUTOMEDO_WEB_DIR) : undefined;

const server = createApp({ db, token, webDir });
server.listen(port, host, () => {
  console.log(`✻ AuTomeDo server ${VERSION} on http://${host}:${port}`);
  console.log(`  db: ${dbPath}${webDir ? `\n  web: ${webDir}` : ''}${token ? '' : '\n  ⚠ auth disabled (AUTOMEDO_INSECURE=1)'}`);
});
const shutdown = () => {
  server.close(() => {
    db.close();
    process.exit(0);
  });
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

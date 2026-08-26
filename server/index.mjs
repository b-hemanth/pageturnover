import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createApp } from './app.mjs';

const serverDir = path.dirname(fileURLToPath(import.meta.url));
const projectDir = path.resolve(serverDir, '..');
const isProduction = process.env.NODE_ENV === 'production';
const defaultPort = isProduction ? 3006 : 4174;
const parsedPort = Number(process.env.PORT || process.env.API_PORT || defaultPort);
const port = Number.isInteger(parsedPort) && parsedPort > 0 && parsedPort < 65_536 ? parsedPort : defaultPort;
const host = process.env.HOST || '0.0.0.0';
const isLoopback = ['127.0.0.1', '::1', 'localhost'].includes(host);

const runtime = await createApp({
  workspacesDir: process.env.WORKSPACES_DIR || path.join(projectDir, 'workspaces'),
  templatesDir: process.env.TEMPLATES_DIR || path.join(projectDir, 'templates'),
  distDir: process.env.DIST_DIR || path.join(projectDir, 'dist'),
  watch: process.env.DISABLE_FILE_WATCHER !== '1',
});

const server = runtime.app.listen(port, host, () => {
  const mode = isProduction ? 'production' : 'development API';
  console.log(`TeX desk ${mode} listening on http://${host}:${port}`);
  if (process.env.ACCESS_TOKEN) console.log('Access-token protection is enabled.');
  else if (!isLoopback) {
    console.warn('WARNING: TeX desk is listening beyond localhost without ACCESS_TOKEN protection.');
  }
});

let closing = false;
async function shutdown(signal) {
  if (closing) return;
  closing = true;
  console.log(`Received ${signal}; closing TeX desk.`);
  server.close(async () => {
    await runtime.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

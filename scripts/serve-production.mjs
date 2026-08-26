#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distIndex = path.join(root, 'dist', 'index.html');
const runtimeDir = path.join(root, '.runtime');
const tokenFile = path.join(runtimeDir, 'access-token');

try {
  await fs.access(distIndex);
} catch {
  process.stderr.write('Production bundle missing. Run npm run setup (or npm run build) first.\n');
  process.exit(1);
}

await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
const runtimeStat = await fs.lstat(runtimeDir);
if (!runtimeStat.isDirectory() || runtimeStat.isSymbolicLink()) {
  throw new Error(`Unsafe runtime directory: ${runtimeDir}`);
}
let token = (await fs.readFile(tokenFile, 'utf8').catch(() => '')).trim();
if (token && !/^[a-f0-9]{48}$/.test(token)) {
  throw new Error(`Invalid access token in ${tokenFile}; move that file aside and restart.`);
}
if (!token) {
  token = randomBytes(24).toString('hex');
  const tokenStat = await fs.lstat(tokenFile).catch(() => null);
  if (tokenStat?.isSymbolicLink() || (tokenStat && !tokenStat.isFile())) {
    throw new Error(`Unsafe access-token path: ${tokenFile}`);
  }
  await fs.writeFile(tokenFile, `${token}\n`, {
    encoding: 'utf8',
    flag: tokenStat ? 'w' : 'wx',
    mode: 0o600,
  });
}
await fs.chmod(tokenFile, 0o600).catch(() => {});

const configuredPort = process.env.TEX_DESK_PORT || process.env.PAGETURNOVER_PORT
  || process.env.JHANA_TEX_PORT || '3006';
const parsedPort = Number(configuredPort);
const port = Number.isInteger(parsedPort) && parsedPort >= 1024 && parsedPort <= 65_535
  ? parsedPort
  : 3006;
const host = process.env.TEX_DESK_HOST || process.env.PAGETURNOVER_HOST
  || process.env.JHANA_TEX_HOST || '127.0.0.1';

process.env.NODE_ENV = 'production';
process.env.HOST = host;
process.env.PORT = String(port);
process.env.ACCESS_TOKEN = token;

const browserHost = ['0.0.0.0', '::'].includes(host) ? '127.0.0.1' : host;
if (process.env.PAGETURNOVER_NO_CONFIG !== '1') {
  const configBase = process.env.PAGETURNOVER_CONFIG_DIR
    || process.env.XDG_CONFIG_HOME
    || (process.platform === 'win32' ? process.env.APPDATA : '')
    || path.join(os.homedir(), '.config');
  const configFile = path.join(configBase, 'pageturnover', 'config.json');
  let previous = {};
  try {
    previous = JSON.parse(await fs.readFile(configFile, 'utf8'));
  } catch {
    // A missing or malformed discovery record is repaired by the active server.
  }
  const next = {
    ...(previous && typeof previous === 'object' && !Array.isArray(previous) ? previous : {}),
    schemaVersion: 1,
    repo: root,
    port,
    url: `http://${browserHost}:${port}`,
    tokenFile,
    updatedAt: new Date().toISOString(),
  };
  await fs.mkdir(path.dirname(configFile), { recursive: true, mode: 0o700 });
  const temporary = `${configFile}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, configFile);
  await fs.chmod(configFile, 0o600).catch(() => {});
}
if (process.env.PAGETURNOVER_SUPPRESS_ACCESS_URL === '1') {
  process.stdout.write(`PageTurnover ready at http://${browserHost}:${port}/ (protected).\n`);
} else {
  process.stdout.write(`Open http://${browserHost}:${port}/?access=${token}\n`);
}
await import('../server/index.mjs');

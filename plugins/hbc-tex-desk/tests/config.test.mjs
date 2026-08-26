import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  configFilePath,
  doctor,
  initializeConfig,
  resolveConfig,
  workspacePath,
} from '../scripts/texdesk-client.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function makeRepo(root) {
  await fs.mkdir(path.join(root, '.runtime'), { recursive: true });
  await fs.writeFile(path.join(root, 'package.json'), '{"name":"pageturnover"}\n');
  await fs.writeFile(path.join(root, '.runtime', 'access-token'), 'test-token\n');
}

test('config path matches setup.mjs conventions', () => {
  const actual = configFilePath({
    env: { PAGETURNOVER_CONFIG_DIR: '/tmp/pt-config-root' },
    platform: 'linux',
    homedir: '/home/tester',
  });
  assert.equal(actual, path.resolve('/tmp/pt-config-root/pageturnover/config.json'));
});

test('PageTurnover environment wins over legacy environment and config', async () => {
  const base = await tempDir('pageturnover-config-');
  const configPath = path.join(base, 'pageturnover', 'config.json');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    repo: '/config/repo',
    port: 7000,
    url: 'http://config.invalid:7000',
    tokenFile: '/config/token',
  }));
  const resolved = await resolveConfig({
    env: {
      PAGETURNOVER_CONFIG_DIR: base,
      PAGETURNOVER_REPO: '/primary/repo',
      PAGETURNOVER_PORT: '7444',
      PAGETURNOVER_TOKEN: 'primary-token',
      HBC_TEX_REPO: '/legacy/repo',
      HBC_TEX_URL: 'http://legacy.invalid:7333',
      HBC_TEX_TOKEN: 'legacy-token',
    },
  });
  assert.equal(resolved.repo, path.resolve('/primary/repo'));
  assert.equal(resolved.baseUrl, 'http://127.0.0.1:7444');
  assert.equal(resolved.inlineToken, 'primary-token');
});

test('legacy environment wins over config when PageTurnover variables are absent', async () => {
  const base = await tempDir('pageturnover-legacy-config-');
  const configPath = path.join(base, 'pageturnover', 'config.json');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({
    schemaVersion: 1,
    repo: '/config/repo',
    url: 'http://config.invalid:7000',
    tokenFile: '/config/token',
  }));
  const resolved = await resolveConfig({
    env: {
      PAGETURNOVER_CONFIG_DIR: base,
      HBC_TEX_REPO: '/legacy/repo',
      HBC_TEX_URL: 'http://legacy.invalid:7333',
      HBC_TEX_TOKEN_FILE: '/legacy/token',
    },
  });
  assert.equal(resolved.repo, path.resolve('/legacy/repo'));
  assert.equal(resolved.baseUrl, 'http://legacy.invalid:7333');
  assert.equal(resolved.tokenFile, path.resolve('/legacy/token'));
});

test('setup-compatible config resolves repo, port, and runtime token', async () => {
  const base = await tempDir('pageturnover-config-');
  const repo = path.join(base, 'checkout');
  await makeRepo(repo);
  const configPath = path.join(base, 'config-home', 'pageturnover', 'config.json');
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify({ schemaVersion: 1, repo, port: 38173 }));
  const resolved = await resolveConfig({ env: { PAGETURNOVER_CONFIG_DIR: path.join(base, 'config-home') } });
  assert.equal(resolved.repo, repo);
  assert.equal(resolved.baseUrl, 'http://127.0.0.1:38173');
  assert.equal(resolved.tokenFile, path.join(repo, '.runtime', 'access-token'));
});

test('missing discovery state returns an actionable init error', async () => {
  const base = await tempDir('pageturnover-empty-config-');
  await assert.rejects(
    resolveConfig({ env: { PAGETURNOVER_CONFIG_DIR: base } }),
    /texdesk\.mjs init --repo/,
  );
});

test('init writes a portable private config', async () => {
  const base = await tempDir('pageturnover-init-');
  const repo = path.join(base, 'random-checkout');
  await makeRepo(repo);
  const result = await initializeConfig({
    repo,
    url: 'http://127.0.0.1:38173',
    env: { PAGETURNOVER_CONFIG_DIR: path.join(base, 'config-home') },
  });
  const saved = JSON.parse(await fs.readFile(result.configPath, 'utf8'));
  assert.equal(saved.repo, await fs.realpath(repo));
  assert.equal(saved.port, 38173);
  assert.equal(saved.url, 'http://127.0.0.1:38173');
  if (process.platform !== 'win32') {
    assert.equal((await fs.stat(result.configPath)).mode & 0o777, 0o600);
  }
});

test('doctor validates service identity without exposing the token', async (t) => {
  const base = await tempDir('pageturnover-doctor-');
  const repo = path.join(base, 'checkout');
  await makeRepo(repo);
  const server = http.createServer((request, response) => {
    if (request.headers.authorization !== 'Bearer test-token') {
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end('{"error":{"message":"auth required"}}');
      return;
    }
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (request.url === '/api/health') response.end('{"ok":true,"service":"tex-desk","version":"test"}');
    else if (request.url === '/api/system/status') response.end(JSON.stringify({ workspacePath: path.join(base, 'remote-only-workspaces') }));
    else response.end(JSON.stringify({ project: { id: 'paper', rootFile: 'main.tex' } }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const port = server.address().port;
  const configHome = path.join(base, 'config-home');
  await fs.mkdir(path.join(configHome, 'pageturnover'), { recursive: true });
  await fs.writeFile(path.join(configHome, 'pageturnover', 'config.json'), JSON.stringify({ schemaVersion: 1, repo, port }));
  const result = await doctor({ env: { PAGETURNOVER_CONFIG_DIR: configHome } });
  assert.equal(result.ok, true);
  assert.equal(result.server.service, 'tex-desk');
  assert.equal(result.workspace.localAccessible, false);
  assert.equal(JSON.stringify(result).includes('test-token'), false);

  const location = await workspacePath('paper', { env: { PAGETURNOVER_CONFIG_DIR: configHome } });
  assert.equal(location.serverPath, path.join(base, 'remote-only-workspaces', 'paper'));
  assert.equal(location.localAccessible, false);
  assert.equal(location.localPath, null);
  assert.equal(location.path, null);
});

test('MCP initialize reports the manifest version', async (t) => {
  const manifest = JSON.parse(await fs.readFile(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
  const child = spawn(process.execPath, [path.join(pluginRoot, 'mcp', 'server.mjs')], {
    cwd: pluginRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill());
  const response = new Promise((resolve, reject) => {
    let buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline >= 0) resolve(JSON.parse(buffer.slice(0, newline)));
    });
    child.on('error', reject);
  });
  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
  })}\n`);
  assert.equal((await response).result.serverInfo.version, manifest.version);
});

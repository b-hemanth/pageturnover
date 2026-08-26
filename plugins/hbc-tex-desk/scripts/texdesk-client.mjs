import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_PORT = 3006;
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/;

function clean(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function validatedPort(value, label) {
  if (value === undefined || value === null || value === '') return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${label} must be an integer between 1 and 65535.`);
  }
  return port;
}

function normalizedUrl(value, label) {
  const input = clean(value);
  if (!input) return null;
  let parsed;
  try {
    parsed = new URL(input);
  } catch {
    throw new Error(`${label} must be an absolute http:// or https:// URL.`);
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) {
    throw new Error(`${label} must be an absolute http:// or https:// URL without credentials.`);
  }
  parsed.hash = '';
  parsed.search = '';
  return parsed.toString().replace(/\/$/, '');
}

export function configFilePath({
  env = process.env,
  platform = process.platform,
  homedir = os.homedir(),
} = {}) {
  const base = clean(env.PAGETURNOVER_CONFIG_DIR)
    || clean(env.XDG_CONFIG_HOME)
    || (platform === 'win32' ? clean(env.APPDATA) : null)
    || path.join(homedir, '.config');
  return path.resolve(base, 'pageturnover', 'config.json');
}

async function readConfigRecord(options = {}) {
  const file = configFilePath(options);
  let raw;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { file, exists: false, value: null };
    throw error;
  }
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error(`PageTurnover config is not valid JSON: ${file}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`PageTurnover config must contain a JSON object: ${file}`);
  }
  if (value.schemaVersion !== undefined && value.schemaVersion !== 1) {
    throw new Error(`Unsupported PageTurnover config schemaVersion in ${file}.`);
  }
  return { file, exists: true, value };
}

function initMessage(file) {
  return `PageTurnover is not initialized on this machine. Run "node <plugin-root>/scripts/texdesk.mjs init --repo /path/to/pageturnover" or run "npm run setup" in the PageTurnover checkout. Expected config: ${file}`;
}

export async function resolveConfig(options = {}) {
  const env = options.env || process.env;
  const record = await readConfigRecord(options);
  const stored = record.value || {};

  const primaryRepo = clean(env.PAGETURNOVER_REPO);
  const legacyRepo = clean(env.HBC_TEX_REPO);
  const configRepo = clean(stored.repo);
  const repoValue = primaryRepo || legacyRepo || configRepo;
  const repo = repoValue ? path.resolve(repoValue) : null;

  const primaryUrl = clean(env.PAGETURNOVER_URL);
  const primaryPort = validatedPort(env.PAGETURNOVER_PORT, 'PAGETURNOVER_PORT');
  const legacyUrl = clean(env.HBC_TEX_URL);
  const legacyPort = validatedPort(env.HBC_TEX_PORT, 'HBC_TEX_PORT');
  const configUrl = clean(stored.url);
  const configPort = validatedPort(stored.port, 'config.port');

  let baseUrl;
  let endpointSource;
  let port;
  if (primaryUrl) {
    baseUrl = normalizedUrl(primaryUrl, 'PAGETURNOVER_URL');
    endpointSource = 'PAGETURNOVER_URL';
  } else if (primaryPort !== null) {
    port = primaryPort;
    baseUrl = `http://127.0.0.1:${port}`;
    endpointSource = 'PAGETURNOVER_PORT';
  } else if (legacyUrl) {
    baseUrl = normalizedUrl(legacyUrl, 'HBC_TEX_URL');
    endpointSource = 'HBC_TEX_URL';
  } else if (legacyPort !== null) {
    port = legacyPort;
    baseUrl = `http://127.0.0.1:${port}`;
    endpointSource = 'HBC_TEX_PORT';
  } else if (configUrl) {
    baseUrl = normalizedUrl(configUrl, 'config.url');
    endpointSource = 'config.url';
  } else if (configPort !== null) {
    port = configPort;
    baseUrl = `http://127.0.0.1:${port}`;
    endpointSource = 'config.port';
  } else if (repo) {
    port = DEFAULT_PORT;
    baseUrl = `http://127.0.0.1:${port}`;
    endpointSource = 'default port';
  } else {
    throw new Error(initMessage(record.file));
  }

  const primaryToken = clean(env.PAGETURNOVER_TOKEN);
  const legacyToken = clean(env.HBC_TEX_TOKEN);
  const primaryTokenFile = clean(env.PAGETURNOVER_TOKEN_FILE);
  const legacyTokenFile = clean(env.HBC_TEX_TOKEN_FILE);
  let tokenFileValue = primaryTokenFile || legacyTokenFile;
  let tokenSource = primaryToken ? 'PAGETURNOVER_TOKEN' : legacyToken ? 'HBC_TEX_TOKEN' : null;
  if (!primaryToken && !legacyToken) {
    if (!tokenFileValue && (primaryRepo || legacyRepo)) tokenFileValue = path.join(repo, '.runtime', 'access-token');
    if (!tokenFileValue) tokenFileValue = clean(stored.tokenFile);
    if (!tokenFileValue && repo) tokenFileValue = path.join(repo, '.runtime', 'access-token');
    if (tokenFileValue) tokenSource = primaryTokenFile
      ? 'PAGETURNOVER_TOKEN_FILE'
      : legacyTokenFile
        ? 'HBC_TEX_TOKEN_FILE'
        : clean(stored.tokenFile) === tokenFileValue
          ? 'config.tokenFile'
          : 'repo runtime';
  }

  if (!repo && !record.exists && !primaryRepo && !legacyRepo && !primaryUrl && primaryPort === null && !legacyUrl && legacyPort === null) {
    throw new Error(initMessage(record.file));
  }

  return {
    baseUrl,
    configPath: record.file,
    configExists: record.exists,
    endpointSource,
    inlineToken: primaryToken || legacyToken,
    port: port || Number(new URL(baseUrl).port) || (baseUrl.startsWith('https:') ? 443 : 80),
    repo,
    repoSource: primaryRepo ? 'PAGETURNOVER_REPO' : legacyRepo ? 'HBC_TEX_REPO' : configRepo ? 'config.repo' : null,
    tokenFile: tokenFileValue ? path.resolve(tokenFileValue) : null,
    tokenSource,
  };
}

async function tokenFor(resolved) {
  if (resolved.inlineToken) return resolved.inlineToken;
  if (!resolved.tokenFile) return '';
  return (await fs.readFile(resolved.tokenFile, 'utf8').catch(() => '')).trim();
}

async function writeConfig(value, options = {}) {
  const destination = configFilePath(options);
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  try {
    await fs.rename(temporary, destination);
    await fs.chmod(destination, 0o600).catch(() => {});
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
  return destination;
}

export async function initializeConfig({ repo, url, ...options } = {}) {
  if (!clean(repo)) throw new Error('init requires --repo /path/to/pageturnover.');
  const requested = path.resolve(repo);
  const realRepo = await fs.realpath(requested).catch(() => null);
  const stat = realRepo ? await fs.stat(realRepo).catch(() => null) : null;
  if (!realRepo || !stat?.isDirectory()) throw new Error(`PageTurnover repository not found: ${requested}`);
  let manifest;
  try {
    manifest = JSON.parse(await fs.readFile(path.join(realRepo, 'package.json'), 'utf8'));
  } catch {
    throw new Error(`Not a PageTurnover checkout (package.json is missing or invalid): ${realRepo}`);
  }
  if (!['pageturnover', 'tex-desk'].includes(manifest.name)) {
    throw new Error(`Not a PageTurnover checkout: ${realRepo}`);
  }

  const normalized = url ? normalizedUrl(url, '--url') : null;
  const parsed = normalized ? new URL(normalized) : null;
  const port = parsed
    ? Number(parsed.port) || (parsed.protocol === 'https:' ? 443 : 80)
    : DEFAULT_PORT;
  const value = {
    schemaVersion: 1,
    repo: realRepo,
    port,
    ...(normalized ? { url: normalized } : {}),
    updatedAt: new Date().toISOString(),
  };
  const destination = await writeConfig(value, options);
  return {
    ok: true,
    configPath: destination,
    config: value,
    next: 'Start PageTurnover with "npm run serve", then run "texdesk.mjs doctor".',
  };
}

export function assertProjectId(projectId) {
  if (!PROJECT_ID.test(String(projectId || ''))) throw new Error('Invalid project_id.');
  return projectId;
}

function endpoint(baseUrl, value) {
  return new URL(value, `${baseUrl}/`).toString();
}

async function responseError(response) {
  const raw = await response.text().catch(() => '');
  try {
    const body = JSON.parse(raw);
    const message = body?.error?.message || body?.message;
    if (message) return new Error(`${message} (HTTP ${response.status})`);
  } catch {
    // The response was not JSON.
  }
  return new Error(`${raw || response.statusText || 'Request failed'} (HTTP ${response.status})`);
}

async function requestJsonWithConfig(resolved, route, { method = 'GET', body, timeoutMs = 65_000 } = {}) {
  const token = await tokenFor(resolved);
  const response = await fetch(endpoint(resolved.baseUrl, route), {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!response.ok) throw await responseError(response);
  return response.json();
}

export async function requestJson(route, { configOptions, ...requestOptions } = {}) {
  const resolved = await resolveConfig(configOptions);
  return requestJsonWithConfig(resolved, route, requestOptions);
}

function contentDispositionFilename(value, fallback) {
  const encoded = String(value || '').match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  if (encoded) return path.basename(decodeURIComponent(encoded));
  const plain = String(value || '').match(/filename="?([^";]+)"?/i)?.[1];
  return path.basename(plain || fallback);
}

export async function download(route, { outputPath, fallbackName, prefix, configOptions } = {}) {
  const resolved = await resolveConfig(configOptions);
  const token = await tokenFor(resolved);
  const response = await fetch(endpoint(resolved.baseUrl, route), {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw await responseError(response);

  const filename = contentDispositionFilename(response.headers.get('content-disposition'), fallbackName);
  let destination;
  if (outputPath) {
    if (!path.isAbsolute(outputPath)) throw new Error('output_path must be absolute.');
    destination = path.resolve(outputPath);
    const parent = path.dirname(destination);
    const parentStat = await fs.stat(parent).catch(() => null);
    if (!parentStat?.isDirectory()) throw new Error(`Output directory does not exist: ${parent}`);
    if (await fs.stat(destination).catch(() => null)) throw new Error(`Refusing to overwrite: ${destination}`);
  } else {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
    destination = path.join(directory, filename);
  }
  await fs.writeFile(destination, Buffer.from(await response.arrayBuffer()), { flag: 'wx' });
  return {
    path: destination,
    filename,
    bytes: (await fs.stat(destination)).size,
    contentType: response.headers.get('content-type') || null,
  };
}

export async function workspacePath(projectId, configOptions) {
  assertProjectId(projectId);
  const status = await requestJson('/api/system/status', { configOptions });
  const project = await requestJson(`/api/projects/${encodeURIComponent(projectId)}`, { configOptions });
  if (typeof status.workspacePath !== 'string' || !status.workspacePath) {
    throw new Error('The PageTurnover server did not report a workspace path.');
  }
  const separator = status.workspacePath.includes('\\') && !status.workspacePath.includes('/') ? '\\' : '/';
  const serverPath = `${status.workspacePath.replace(/[\\/]+$/, '')}${separator}${projectId}`;
  const localStat = await fs.stat(serverPath).catch(() => null);
  const localPath = localStat?.isDirectory() ? await fs.realpath(serverPath).catch(() => serverPath) : null;
  return {
    project: project.project,
    path: localPath,
    localPath,
    localAccessible: Boolean(localPath),
    serverPath,
  };
}

export async function doctor(options = {}) {
  const issues = [];
  const warnings = [];
  let resolved;
  try {
    resolved = await resolveConfig(options);
  } catch (error) {
    return {
      ok: false,
      configPath: configFilePath(options),
      issues: [error instanceof Error ? error.message : String(error)],
      warnings,
    };
  }

  const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
  const nodeReady = Number.isInteger(nodeMajor) && (nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 13));
  if (!nodeReady) issues.push(`Node.js 22.13 or newer is required; found ${process.versions.node}.`);

  let repoReady = false;
  if (resolved.repo) {
    try {
      const manifest = JSON.parse(await fs.readFile(path.join(resolved.repo, 'package.json'), 'utf8'));
      repoReady = ['pageturnover', 'tex-desk'].includes(manifest.name);
      if (!repoReady) issues.push(`Configured repository is not PageTurnover: ${resolved.repo}`);
    } catch {
      issues.push(`Configured repository is unavailable: ${resolved.repo}`);
    }
  } else {
    warnings.push('No local repository is configured; API tools can work, but local workspace paths may be unavailable.');
  }

  const token = await tokenFor(resolved);
  if (!token) warnings.push(`No access token was found${resolved.tokenFile ? ` at ${resolved.tokenFile}` : ''}.`);

  let health = null;
  let system = null;
  try {
    health = await requestJsonWithConfig(resolved, '/api/health', { timeoutMs: 5_000 });
    if (health?.service !== 'tex-desk') issues.push(`Unexpected service at ${resolved.baseUrl}.`);
    system = await requestJsonWithConfig(resolved, '/api/system/status', { timeoutMs: 5_000 });
  } catch (error) {
    issues.push(error instanceof Error ? error.message : String(error));
  }

  const workspacePath = typeof system?.workspacePath === 'string' ? system.workspacePath : null;
  const workspaceStat = workspacePath ? await fs.stat(workspacePath).catch(() => null) : null;
  if (workspacePath && !workspaceStat?.isDirectory()) {
    warnings.push('The server workspace path is not accessible on this host; use API tools or connect Codex on the server host.');
  }

  return {
    ok: issues.length === 0,
    configPath: resolved.configPath,
    configExists: resolved.configExists,
    endpoint: { url: resolved.baseUrl, source: resolved.endpointSource },
    node: { version: process.versions.node, ready: nodeReady },
    repo: { path: resolved.repo, ready: repoReady, source: resolved.repoSource },
    token: { configured: Boolean(token), file: resolved.tokenFile, source: resolved.tokenSource },
    server: health ? { reachable: true, service: health.service, version: health.version || null } : { reachable: false },
    workspace: { serverPath: workspacePath, localAccessible: Boolean(workspaceStat?.isDirectory()) },
    issues,
    warnings,
  };
}

export async function callOperation(name, args = {}) {
  const projectId = args.project_id;
  if (!['tex_doctor', 'tex_status', 'tex_projects'].includes(name)) assertProjectId(projectId);
  switch (name) {
    case 'tex_doctor':
      return doctor();
    case 'tex_status':
      return requestJson('/api/system/status');
    case 'tex_projects':
      return requestJson('/api/projects');
    case 'tex_workspace_path':
      return workspacePath(projectId);
    case 'tex_tree':
      return requestJson(`/api/projects/${encodeURIComponent(projectId)}/tree`);
    case 'tex_read':
      return requestJson(`/api/projects/${encodeURIComponent(projectId)}/file?path=${encodeURIComponent(args.path)}`);
    case 'tex_save':
      if (typeof args.content !== 'string') throw new Error('content must be a string.');
      if (typeof args.base_version !== 'string') throw new Error('base_version is required; call tex_read first.');
      return requestJson(`/api/projects/${encodeURIComponent(projectId)}/file`, {
        method: 'PUT',
        body: { path: args.path, content: args.content, baseVersion: args.base_version },
      });
    case 'tex_lint':
      return requestJson(`/api/projects/${encodeURIComponent(projectId)}/lint`, {
        method: 'POST',
        body: { path: args.path, ...(typeof args.content === 'string' ? { content: args.content } : {}) },
      });
    case 'tex_compile':
      return requestJson(`/api/projects/${encodeURIComponent(projectId)}/compile`, {
        method: 'POST',
        body: { ...(args.root_file ? { rootFile: args.root_file } : {}) },
        timeoutMs: 90_000,
      });
    case 'tex_proof':
      return download(
        `/api/projects/${encodeURIComponent(projectId)}/pdf${args.root_file ? `?rootFile=${encodeURIComponent(args.root_file)}` : ''}`,
        { outputPath: args.output_path, fallbackName: `${projectId}.pdf`, prefix: 'hbc-tex-proof-' },
      );
    case 'tex_arxiv_export':
      return download(`/api/projects/${encodeURIComponent(projectId)}/export/arxiv`, {
        outputPath: args.output_path,
        fallbackName: `${projectId}-arxiv-source.tar.gz`,
        prefix: 'hbc-tex-arxiv-',
      });
    default:
      throw new Error(`Unknown operation: ${name}`);
  }
}

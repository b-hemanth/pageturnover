import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import chokidar from 'chokidar';
import express from 'express';

import { aiStatus, createHandoff, runAiAction } from './lib/ai.mjs';
import { createArxivSourceArchive, inspectArxivSource } from './lib/arxiv.mjs';
import {
  compileProject,
  compiledPdfPath,
  extractOutline,
  lintLatex,
  synctexEdit,
  synctexView,
} from './lib/latex.mjs';
import { getToolStatus } from './lib/processes.mjs';
import { StoreError, WorkspaceStore, validateProjectId } from './lib/store.mjs';

const packageManifest = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
const appVersion = typeof packageManifest.version === 'string' ? packageManifest.version : '0.0.0';

function secureEqual(left, right) {
  const leftDigest = createHash('sha256').update(String(left)).digest();
  const rightDigest = createHash('sha256').update(String(right)).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of String(header).split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const key = part.slice(0, separator).trim();
    try {
      cookies[key] = decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      cookies[key] = '';
    }
  }
  return cookies;
}

function accessMiddleware(accessToken) {
  return (request, response, next) => {
    if (!accessToken) return next();

    const queryToken = typeof request.query.access === 'string' ? request.query.access : '';
    const cookieToken = parseCookies(request.headers.cookie).jhana_tex_access || '';
    const authorization = String(request.headers.authorization || '');
    const bearerToken = authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
    const candidate = queryToken || cookieToken || bearerToken;
    if (!candidate || !secureEqual(candidate, accessToken)) {
      return response.status(401).json({
        error: { code: 'AUTH_REQUIRED', message: 'A valid editor access token is required.' },
      });
    }

    if (queryToken) {
      const forwardedProto = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
      const secure = request.secure || forwardedProto === 'https';
      response.cookie('jhana_tex_access', accessToken, {
        httpOnly: true,
        sameSite: 'strict',
        secure,
        path: '/',
        maxAge: 30 * 24 * 60 * 60 * 1000,
      });
      if (request.method === 'GET' || request.method === 'HEAD') {
        const cleaned = new URL(request.originalUrl, 'http://local.invalid');
        cleaned.searchParams.delete('access');
        const location = `${cleaned.pathname}${cleaned.search}${cleaned.hash}`;
        return response.redirect(303, location || '/');
      }
    }
    return next();
  };
}

function corsMiddleware(request, response, next) {
  const origin = request.headers.origin;
  if (origin) {
    try {
      const url = new URL(origin);
      const requestHost = String(request.headers.host || '').split(':')[0];
      if (['localhost', '127.0.0.1', '0.0.0.0', '::1', requestHost].includes(url.hostname)) {
        response.setHeader('Access-Control-Allow-Origin', origin);
        response.setHeader('Vary', 'Origin');
        response.setHeader('Access-Control-Allow-Credentials', 'true');
      }
    } catch {
      // Invalid origins get no CORS permission.
    }
  }
  response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, If-Match');
  response.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (request.method === 'OPTIONS') return response.sendStatus(204);
  return next();
}

class EventHub {
  constructor() {
    this.clients = new Map();
  }

  add(projectId, response) {
    if (!this.clients.has(projectId)) this.clients.set(projectId, new Set());
    this.clients.get(projectId).add(response);
  }

  remove(projectId, response) {
    const clients = this.clients.get(projectId);
    clients?.delete(response);
    if (clients?.size === 0) this.clients.delete(projectId);
  }

  send(projectId, payload) {
    const data = `event: ${payload.type || 'change'}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const response of this.clients.get(projectId) || []) response.write(data);
  }

  close() {
    for (const clients of this.clients.values()) {
      for (const response of clients) response.end();
    }
    this.clients.clear();
  }
}

function asyncRoute(handler) {
  return (request, response, next) => Promise.resolve(handler(request, response, next)).catch(next);
}

function inputTargets(content) {
  const targets = [];
  for (const rawLine of String(content || '').split(/\r?\n/)) {
    const line = rawLine.replace(/(^|[^\\])%.*/, '$1');
    const expression = /\\(?:input|include|subfile)\s*\{([^{}]+)\}/g;
    let match;
    while ((match = expression.exec(line))) {
      const target = match[1].trim();
      if (target && !/[\\#{}]/.test(target)) targets.push(target.endsWith('.tex') ? target : `${target}.tex`);
    }
  }
  return targets;
}

async function projectOutline(store, projectId, rootFile) {
  const visited = new Set();
  const result = [];
  const visit = async (filePath, depth = 0) => {
    if (depth > 20 || visited.size >= 100) return;
    const resolved = await store.resolveProjectPath(projectId, filePath, { allowMissing: true });
    if (visited.has(resolved.relativePath)) return;
    visited.add(resolved.relativePath);
    const record = await store.readFile(projectId, resolved.relativePath);
    result.push(...extractOutline(record.content, resolved.relativePath));
    for (const child of inputTargets(record.content)) {
      await visit(child, depth + 1).catch((error) => {
        if (error instanceof StoreError && ['FILE_NOT_FOUND', 'INVALID_PATH'].includes(error.code)) return;
        throw error;
      });
    }
  };
  await visit(rootFile);
  return result;
}

export async function createApp({
  workspacesDir,
  templatesDir,
  distDir,
  watch = true,
  accessToken = process.env.ACCESS_TOKEN || '',
} = {}) {
  if (!workspacesDir || !templatesDir || !distDir) throw new Error('createApp requires workspacesDir, templatesDir, and distDir.');
  const app = express();
  const store = new WorkspaceStore({ workspacesDir, templatesDir });
  const eventHub = new EventHub();
  await store.init();

  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(corsMiddleware);
  app.use(accessMiddleware(accessToken));
  // 8 MiB editor files can expand substantially when JSON escapes TeX
  // backslashes; keep the transport ceiling above the validated file ceiling.
  app.use(express.json({ limit: '20mb' }));

  let toolsCache = null;
  let toolsCacheAt = 0;
  const tools = async () => {
    if (!toolsCache || Date.now() - toolsCacheAt > 30_000) {
      toolsCache = await getToolStatus();
      toolsCacheAt = Date.now();
    }
    return toolsCache;
  };

  app.get('/api/health', asyncRoute(async (_request, response) => {
    response.json({
      ok: true,
      service: 'tex-desk',
      version: appVersion,
      time: new Date().toISOString(),
      authRequired: Boolean(accessToken),
    });
  }));

  app.get('/api/system/status', asyncRoute(async (_request, response) => {
    const toolStatus = await tools();
    response.json({
      ok: true,
      latexmk: Boolean(toolStatus.latexmk?.available),
      xelatex: Boolean(toolStatus.xelatex?.available),
      chktex: Boolean(toolStatus.chktex?.available),
      synctex: Boolean(toolStatus.synctex?.available),
      pdfinfo: Boolean(toolStatus.pdfinfo?.available),
      latexAvailable: Boolean(toolStatus.latexmk?.available && toolStatus.xelatex?.available),
      workspacePath: store.workspacesDir,
      tools: toolStatus,
      ai: await aiStatus(),
      limits: {
        compileTimeoutMs: 45_000,
        maxEditorFileBytes: 8 * 1024 * 1024,
        maxJsonRequestBytes: 20 * 1024 * 1024,
      },
    });
  }));

  app.get('/api/templates', asyncRoute(async (_request, response) => {
    response.json({ templates: await store.listTemplates() });
  }));

  app.get('/api/projects', asyncRoute(async (_request, response) => {
    response.json({ projects: await store.listProjects() });
  }));

  app.post('/api/projects', asyncRoute(async (request, response) => {
    const body = request.body || {};
    const project = await store.createProject({
      name: body.name,
      templateId: body.templateId || body.template || 'blank',
    });
    response.status(201).json({ project });
  }));

  app.get('/api/projects/:id', asyncRoute(async (request, response) => {
    response.json({ project: await store.getProject(request.params.id) });
  }));

  app.get('/api/projects/:id/tree', asyncRoute(async (request, response) => {
    response.json({ tree: await store.tree(request.params.id) });
  }));

  app.get('/api/projects/:id/file', asyncRoute(async (request, response) => {
    response.json(await store.readFile(request.params.id, request.query.path));
  }));

  app.put('/api/projects/:id/file', asyncRoute(async (request, response) => {
    const { path: filePath, content, baseVersion } = request.body || {};
    response.json(await store.saveFile(request.params.id, filePath, content, baseVersion));
  }));

  app.post('/api/projects/:id/files', asyncRoute(async (request, response) => {
    const { path: filePath, type, content } = request.body || {};
    response.status(201).json(await store.createPath(request.params.id, filePath, type, content));
  }));

  app.patch('/api/projects/:id/file', asyncRoute(async (request, response) => {
    const { path: filePath, newPath } = request.body || {};
    response.json(await store.renamePath(request.params.id, filePath, newPath));
  }));

  app.delete('/api/projects/:id/file', asyncRoute(async (request, response) => {
    response.json(await store.deletePath(request.params.id, request.query.path));
  }));

  app.post('/api/projects/:id/compile', asyncRoute(async (request, response) => {
    const project = await store.getProject(request.params.id);
    const result = await compileProject({
      store,
      projectId: request.params.id,
      rootFile: request.body?.rootFile || project.rootFile,
      timeoutMs: process.env.COMPILE_TIMEOUT_MS,
    });
    response.status(200).json(result);
  }));

  app.get('/api/projects/:id/pdf', asyncRoute(async (request, response) => {
    const project = await store.getProject(request.params.id);
    const pdfPath = await compiledPdfPath({
      store,
      projectId: request.params.id,
      rootFile: request.query.rootFile || project.rootFile,
    });
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.setHeader('Content-Disposition', `inline; filename="${path.basename(pdfPath)}"`);
    response.sendFile(pdfPath, { dotfiles: 'allow' });
  }));

  app.get('/api/projects/:id/export/arxiv', asyncRoute(async (request, response) => {
    const project = await store.getProject(request.params.id);
    let inspection = await inspectArxivSource({
      store,
      projectId: request.params.id,
      rootFile: project.rootFile,
    });
    let bibliographyBuild = inspection.bibliographyRequested ? 'source-only' : 'not-needed';
    if (inspection.bibliographyRequested && !inspection.hasBbl && request.query.generateBbl !== '0') {
      try {
        const result = await compileProject({
          store,
          projectId: request.params.id,
          rootFile: project.rootFile,
          timeoutMs: process.env.COMPILE_TIMEOUT_MS,
        });
        bibliographyBuild = result.success ? 'generated' : 'compile-failed';
        inspection = await inspectArxivSource({
          store,
          projectId: request.params.id,
          rootFile: project.rootFile,
        });
      } catch (error) {
        if (!(error instanceof StoreError) || error.code !== 'LATEXMK_UNAVAILABLE') throw error;
        bibliographyBuild = 'compiler-unavailable';
      }
    } else if (inspection.hasBbl) {
      bibliographyBuild = 'included';
    }

    const archive = await createArxivSourceArchive({
      store,
      projectId: request.params.id,
      rootFile: project.rootFile,
    });
    response.setHeader('Cache-Control', 'no-store, max-age=0');
    response.setHeader('X-arXiv-Source-Files', String(archive.files.length));
    response.setHeader('X-arXiv-Bibliography', archive.hasBbl ? 'bbl-included' : bibliographyBuild);
    try {
      await new Promise((resolve, reject) => {
        response.download(archive.path, archive.filename, { dotfiles: 'deny' }, (error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    } finally {
      await archive.cleanup().catch(() => {});
    }
  }));

  app.post('/api/projects/:id/synctex/view', asyncRoute(async (request, response) => {
    const project = await store.getProject(request.params.id);
    response.json(await synctexView({
      store,
      projectId: request.params.id,
      rootFile: request.body?.rootFile || project.rootFile,
      file: request.body?.file,
      line: request.body?.line,
      column: request.body?.column,
    }));
  }));

  app.post('/api/projects/:id/synctex/edit', asyncRoute(async (request, response) => {
    const project = await store.getProject(request.params.id);
    response.json(await synctexEdit({
      store,
      projectId: request.params.id,
      rootFile: request.body?.rootFile || project.rootFile,
      page: request.body?.page,
      x: request.body?.x,
      y: request.body?.y,
    }));
  }));

  app.post('/api/projects/:id/lint', asyncRoute(async (request, response) => {
    const requestedPath = request.body?.path || 'main.tex';
    const filePath = (await store.resolveProjectPath(request.params.id, requestedPath, { allowMissing: true })).relativePath;
    const record = typeof request.body?.content === 'string'
      ? { content: request.body.content }
      : await store.readFile(request.params.id, filePath);
    const cwd = await store.projectRoot(request.params.id);
    const project = await store.getProject(request.params.id);
    response.json(await lintLatex({
      content: record.content,
      file: filePath,
      cwd,
      requireDocument: filePath === project.rootFile,
    }));
  }));

  app.get('/api/projects/:id/outline', asyncRoute(async (request, response) => {
    const filePath = request.query.path || (await store.getProject(request.params.id)).rootFile;
    response.json({ outline: await projectOutline(store, request.params.id, filePath) });
  }));

  app.post('/api/projects/:id/outline', asyncRoute(async (request, response) => {
    const content = typeof request.body?.content === 'string'
      ? request.body.content
      : (await store.readFile(request.params.id, request.body?.path || 'main.tex')).content;
    response.json({ outline: extractOutline(content, request.body?.path) });
  }));

  const sseHandler = asyncRoute(async (request, response) => {
    const projectId = validateProjectId(request.params.id || request.query.projectId);
    await store.projectRoot(projectId);
    response.status(200);
    response.setHeader('Content-Type', 'text/event-stream');
    response.setHeader('Cache-Control', 'no-cache, no-transform');
    response.setHeader('Connection', 'keep-alive');
    response.flushHeaders();
    eventHub.add(projectId, response);
    response.write(`event: ready\ndata: ${JSON.stringify({ type: 'ready', projectId })}\n\n`);
    const heartbeat = setInterval(() => response.write(': heartbeat\n\n'), 20_000);
    heartbeat.unref();
    request.on('close', () => {
      clearInterval(heartbeat);
      eventHub.remove(projectId, response);
    });
  });
  app.get('/api/projects/:id/events', sseHandler);
  app.get('/api/events', sseHandler);

  app.get('/api/ai/status', asyncRoute(async (_request, response) => {
    response.json(await aiStatus());
  }));

  app.post('/api/ai/action', asyncRoute(async (request, response) => {
    const payload = { ...(request.body || {}) };
    if (typeof payload.content !== 'string' && payload.projectId && payload.path) {
      payload.content = (await store.readFile(payload.projectId, payload.path)).content;
    }
    response.json(await runAiAction(payload));
  }));

  app.post('/api/ai/handoff', asyncRoute(async (request, response) => {
    const payload = { ...(request.body || {}) };
    if (typeof payload.content !== 'string' && payload.projectId && payload.path) {
      payload.content = (await store.readFile(payload.projectId, payload.path)).content;
    }
    response.status(202).json(await createHandoff(store, payload));
  }));

  app.use('/api', (_request, response) => {
    response.status(404).json({ error: { code: 'NOT_FOUND', message: 'API route not found.' } });
  });

  app.use(express.static(distDir, {
    etag: true,
    fallthrough: true,
    maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
  }));
  app.use(asyncRoute(async (request, response, next) => {
    if (!['GET', 'HEAD'].includes(request.method) || !request.accepts('html')) return next();
    const indexPath = path.join(path.resolve(distDir), 'index.html');
    if (!await fs.stat(indexPath).catch(() => null)) return next();
    return response.sendFile(indexPath);
  }));
  app.use((_request, response) => response.status(404).send('Not found.'));

  let watcher = null;
  if (watch) {
    watcher = chokidar.watch(path.resolve(workspacesDir), {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 40 },
      ignored: (candidate) => {
        const normalized = candidate.split(path.sep).join('/');
        return normalized.includes('/.jhana-build/')
          || normalized.endsWith('/.jhana-build')
          || normalized.includes('/.jhana-ai/')
          || normalized.endsWith('/.jhana-project.json')
          || /\/\.[^/]+\.[0-9a-f-]+\.tmp$/.test(normalized);
      },
    });
    const onDiskEvent = async (kind, absolutePath) => {
      const relative = path.relative(path.resolve(workspacesDir), absolutePath).split(path.sep).join('/');
      const [projectId, ...pieces] = relative.split('/');
      if (!projectId || !pieces.length || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(projectId)) return;
      const filePath = pieces.join('/');
      let version = null;
      if (kind === 'add' || kind === 'change') {
        version = (await store.readFile(projectId, filePath).catch(() => null))?.version || null;
      }
      eventHub.send(projectId, {
        type: kind === 'unlink' || kind === 'unlinkDir' ? 'delete' : kind === 'add' || kind === 'addDir' ? 'create' : 'change',
        path: filePath,
        version,
        origin: 'disk',
        at: new Date().toISOString(),
      });
    };
    for (const kind of ['add', 'addDir', 'change', 'unlink', 'unlinkDir']) {
      watcher.on(kind, (filePath) => { onDiskEvent(kind, filePath).catch(() => {}); });
    }
  }

  app.use((error, _request, response, _next) => {
    if (process.env.DEBUG_SERVER_ERRORS === '1') console.error(error);
    if (response.headersSent) return response.end();
    const status = error instanceof StoreError ? error.status : error?.type === 'entity.too.large' ? 413 : 500;
    const code = error instanceof StoreError ? error.code : status === 413 ? 'REQUEST_TOO_LARGE' : 'INTERNAL_ERROR';
    const message = error instanceof StoreError ? error.message : 'The local editor server encountered an error.';
    response.status(status).json({
      error: { code, message },
      ...(error instanceof StoreError && error.details ? error.details : {}),
    });
  });

  return {
    app,
    store,
    close: async () => {
      eventHub.close();
      if (watcher) await watcher.close();
    },
  };
}

import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const PROJECT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const HIDDEN_TREE_NAMES = new Set([
  '.DS_Store',
  '.jhana-build',
  '.jhana-ai',
  '.jhana-project.json',
]);
const RESERVED_PROJECT_NAMES = new Set(['.jhana-build', '.jhana-ai', '.jhana-project.json']);

export class StoreError extends Error {
  constructor(message, status = 400, code = 'BAD_REQUEST', details = undefined) {
    super(message);
    this.name = 'StoreError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function hashContent(content) {
  return createHash('sha256').update(content).digest('hex');
}

export function validateProjectId(id) {
  if (typeof id !== 'string' || !PROJECT_ID_RE.test(id)) {
    throw new StoreError('Invalid project id.', 400, 'INVALID_PROJECT_ID');
  }
  return id;
}

export function normalizeRelativePath(input, { allowRoot = false } = {}) {
  if (typeof input !== 'string') {
    throw new StoreError('A relative path is required.', 400, 'INVALID_PATH');
  }
  if (input.includes('\0') || input.includes('\\')) {
    throw new StoreError('Invalid path.', 400, 'INVALID_PATH');
  }

  const trimmed = input.trim();
  if (!trimmed && allowRoot) return '';
  if (!trimmed || path.posix.isAbsolute(trimmed)) {
    throw new StoreError('Path must be relative to the project.', 400, 'INVALID_PATH');
  }

  const pieces = trimmed.split('/');
  if (pieces.some((piece) => !piece || piece === '.' || piece === '..')) {
    throw new StoreError('Path traversal is not allowed.', 400, 'INVALID_PATH');
  }

  const normalized = path.posix.normalize(trimmed);
  if (normalized === '..' || normalized.startsWith('../')) {
    throw new StoreError('Path traversal is not allowed.', 400, 'INVALID_PATH');
  }
  return normalized;
}

function slugify(value) {
  return String(value || 'untitled-paper')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 54) || 'untitled-paper';
}

async function exists(filePath) {
  try {
    await fs.access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function assertNoSymlinks(root, relativePath, { allowMissing = false } = {}) {
  let cursor = root;
  for (const piece of relativePath.split('/').filter(Boolean)) {
    cursor = path.join(cursor, piece);
    try {
      const stat = await fs.lstat(cursor);
      if (stat.isSymbolicLink()) {
        throw new StoreError('Symbolic links are not allowed in project paths.', 400, 'SYMLINK_BLOCKED');
      }
    } catch (error) {
      if (error instanceof StoreError) throw error;
      if (error?.code === 'ENOENT' && allowMissing) return;
      throw error;
    }
  }
}

async function newestMtime(directory, depth = 0) {
  const stat = await fs.stat(directory);
  let newest = stat.mtimeMs;
  if (depth > 8) return newest;
  const entries = await fs.readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    if (HIDDEN_TREE_NAMES.has(entry.name) || entry.isSymbolicLink()) continue;
    const entryPath = path.join(directory, entry.name);
    const childStat = await fs.stat(entryPath);
    newest = Math.max(newest, childStat.mtimeMs);
    if (entry.isDirectory()) newest = Math.max(newest, await newestMtime(entryPath, depth + 1));
  }
  return newest;
}

export class WorkspaceStore {
  constructor({ workspacesDir, templatesDir }) {
    this.workspacesDir = path.resolve(workspacesDir);
    this.templatesDir = path.resolve(templatesDir);
  }

  async init() {
    await Promise.all([
      fs.mkdir(this.workspacesDir, { recursive: true }),
      fs.mkdir(this.templatesDir, { recursive: true }),
    ]);
  }

  async projectRoot(projectId) {
    validateProjectId(projectId);
    const root = path.join(this.workspacesDir, projectId);
    let stat;
    try {
      stat = await fs.lstat(root);
    } catch (error) {
      if (error?.code === 'ENOENT') {
        throw new StoreError('Project not found.', 404, 'PROJECT_NOT_FOUND');
      }
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new StoreError('Project is not a safe directory.', 400, 'UNSAFE_PROJECT');
    }
    return fs.realpath(root);
  }

  async resolveProjectPath(projectId, input, options = {}) {
    const root = await this.projectRoot(projectId);
    const relativePath = normalizeRelativePath(input, { allowRoot: options.allowRoot });
    if (!options.allowInternal && RESERVED_PROJECT_NAMES.has(relativePath.split('/')[0])) {
      throw new StoreError('That path is reserved for editor state.', 400, 'RESERVED_PATH');
    }
    const target = path.resolve(root, relativePath);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw new StoreError('Path traversal is not allowed.', 400, 'INVALID_PATH');
    }
    try {
      await assertNoSymlinks(root, relativePath, { allowMissing: options.allowMissing });
    } catch (error) {
      if (error?.code === 'ENOENT') throw new StoreError('Path not found.', 404, 'FILE_NOT_FOUND');
      throw error;
    }
    return { root, target, relativePath };
  }

  async listTemplates() {
    const entries = await fs.readdir(this.templatesDir, { withFileTypes: true });
    const templates = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const id = entry.name;
      if (!PROJECT_ID_RE.test(id)) continue;
      const templateRoot = path.join(this.templatesDir, id);
      const meta = await readJson(path.join(templateRoot, 'template.json'));
      if (!meta) continue;
      templates.push({
        id,
        name: meta.name || id,
        description: meta.description || '',
        rootFile: normalizeRelativePath(meta.rootFile || 'main.tex'),
        accent: meta.accent || '#00AB55',
        tags: Array.isArray(meta.tags) ? meta.tags : [],
        order: Number(meta.order) || 99,
      });
    }
    return templates.sort((a, b) => (a.order || 99) - (b.order || 99) || a.name.localeCompare(b.name));
  }

  async templateRecord(templateId) {
    validateProjectId(templateId);
    const templateRoot = path.join(this.templatesDir, templateId);
    const stat = await fs.lstat(templateRoot).catch(() => null);
    if (!stat?.isDirectory() || stat.isSymbolicLink()) {
      throw new StoreError('Template not found.', 404, 'TEMPLATE_NOT_FOUND');
    }
    const meta = await readJson(path.join(templateRoot, 'template.json'));
    if (!meta) throw new StoreError('Template metadata is invalid.', 500, 'INVALID_TEMPLATE');
    return { templateRoot, meta };
  }

  async listProjects() {
    const entries = await fs.readdir(this.workspacesDir, { withFileTypes: true });
    const projects = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || !PROJECT_ID_RE.test(entry.name)) continue;
      const root = path.join(this.workspacesDir, entry.name);
      const meta = await readJson(path.join(root, '.jhana-project.json'), {});
      projects.push({
        id: entry.name,
        name: meta.name || entry.name,
        description: meta.description || '',
        rootFile: meta.rootFile || 'main.tex',
        templateId: meta.templateId || null,
        template: meta.templateId || null,
        createdAt: meta.createdAt || (await fs.stat(root)).birthtime.toISOString(),
        updatedAt: new Date(await newestMtime(root)).toISOString(),
      });
    }
    return projects.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async getProject(projectId) {
    const root = await this.projectRoot(projectId);
    const meta = await readJson(path.join(root, '.jhana-project.json'), {});
    return {
      id: projectId,
      name: meta.name || projectId,
      description: meta.description || '',
      rootFile: meta.rootFile || 'main.tex',
      templateId: meta.templateId || null,
      template: meta.templateId || null,
      createdAt: meta.createdAt || (await fs.stat(root)).birthtime.toISOString(),
      updatedAt: new Date(await newestMtime(root)).toISOString(),
    };
  }

  async createProject({ name, templateId = 'blank' }) {
    if (typeof name !== 'string' || !name.trim()) {
      throw new StoreError('Project name is required.', 400, 'INVALID_PROJECT_NAME');
    }
    const safeName = name.trim().slice(0, 120);
    const { templateRoot, meta: templateMeta } = await this.templateRecord(templateId);
    const base = slugify(safeName);
    let id = base;
    let suffix = 2;
    while (await exists(path.join(this.workspacesDir, id))) {
      id = `${base.slice(0, 58)}-${suffix}`;
      suffix += 1;
    }

    const projectRoot = path.join(this.workspacesDir, id);
    await fs.mkdir(projectRoot, { recursive: false });
    try {
      const entries = await fs.readdir(templateRoot);
      for (const entry of entries) {
        if (entry === 'template.json') continue;
        await fs.cp(path.join(templateRoot, entry), path.join(projectRoot, entry), {
          recursive: true,
          errorOnExist: true,
          dereference: false,
        });
      }
      const now = new Date().toISOString();
      await fs.writeFile(path.join(projectRoot, '.jhana-project.json'), `${JSON.stringify({
        name: safeName,
        description: templateMeta.projectDescription || '',
        rootFile: templateMeta.rootFile || 'main.tex',
        templateId,
        createdAt: now,
      }, null, 2)}\n`, 'utf8');
    } catch (error) {
      await fs.rm(projectRoot, { recursive: true, force: true });
      throw error;
    }
    return this.getProject(id);
  }

  async tree(projectId) {
    const root = await this.projectRoot(projectId);
    const walk = async (directory, relative = '') => {
      const entries = await fs.readdir(directory, { withFileTypes: true });
      const nodes = [];
      for (const entry of entries) {
        if (HIDDEN_TREE_NAMES.has(entry.name) || entry.isSymbolicLink()) continue;
        const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
        const childPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          nodes.push({
            name: entry.name,
            path: childRelative,
            type: 'directory',
            children: await walk(childPath, childRelative),
          });
        } else if (entry.isFile()) {
          const stat = await fs.stat(childPath);
          nodes.push({
            name: entry.name,
            path: childRelative,
            type: 'file',
            size: stat.size,
            mtime: stat.mtime.toISOString(),
          });
        }
      }
      return nodes.sort((a, b) => {
        if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    };
    return walk(root);
  }

  async readFile(projectId, input) {
    const { target, relativePath } = await this.resolveProjectPath(projectId, input, { allowMissing: true });
    const stat = await fs.stat(target).catch((error) => {
      if (error?.code === 'ENOENT') throw new StoreError('File not found.', 404, 'FILE_NOT_FOUND');
      throw error;
    });
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) {
      throw new StoreError('Path is not a readable editor file.', 400, 'INVALID_FILE');
    }
    const content = await fs.readFile(target, 'utf8');
    return {
      path: relativePath,
      content,
      version: hashContent(content),
      mtime: stat.mtime.toISOString(),
      size: stat.size,
    };
  }

  async saveFile(projectId, input, content, baseVersion) {
    if (typeof content !== 'string') {
      throw new StoreError('File content must be text.', 400, 'INVALID_CONTENT');
    }
    if (Buffer.byteLength(content, 'utf8') > 8 * 1024 * 1024) {
      throw new StoreError('File is too large for the editor.', 413, 'FILE_TOO_LARGE');
    }
    const { target, relativePath } = await this.resolveProjectPath(projectId, input, { allowMissing: true });
    const currentStat = await fs.stat(target).catch(() => null);
    if (currentStat?.isDirectory()) throw new StoreError('Path is a directory.', 400, 'INVALID_FILE');

    let current = null;
    if (currentStat) current = await this.readFile(projectId, relativePath);
    if (baseVersion !== undefined && baseVersion !== null) {
      const currentVersion = current?.version ?? null;
      if (baseVersion !== currentVersion) {
        throw new StoreError('File changed on disk.', 409, 'VERSION_CONFLICT', { current });
      }
    }

    await fs.mkdir(path.dirname(target), { recursive: true });
    const temporary = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
    try {
      await fs.writeFile(temporary, content, { encoding: 'utf8', flag: 'wx' });
      await fs.rename(temporary, target);
    } finally {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
    return this.readFile(projectId, relativePath);
  }

  async createPath(projectId, input, type = 'file', content = '') {
    const { target, relativePath } = await this.resolveProjectPath(projectId, input, { allowMissing: true });
    if (await exists(target)) throw new StoreError('Path already exists.', 409, 'PATH_EXISTS');
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (type === 'directory') {
      await fs.mkdir(target);
      return { path: relativePath, type: 'directory' };
    }
    if (type !== 'file') throw new StoreError('Type must be file or directory.', 400, 'INVALID_TYPE');
    if (typeof content !== 'string') throw new StoreError('File content must be text.', 400, 'INVALID_CONTENT');
    await fs.writeFile(target, content, { encoding: 'utf8', flag: 'wx' });
    return { ...(await this.readFile(projectId, relativePath)), type: 'file' };
  }

  async renamePath(projectId, input, newInput) {
    const source = await this.resolveProjectPath(projectId, input);
    const destination = await this.resolveProjectPath(projectId, newInput, { allowMissing: true });
    if (destination.target.startsWith(`${source.target}${path.sep}`)) {
      throw new StoreError('A directory cannot be moved inside itself.', 400, 'INVALID_PATH');
    }
    if (await exists(destination.target)) throw new StoreError('Destination already exists.', 409, 'PATH_EXISTS');
    await fs.mkdir(path.dirname(destination.target), { recursive: true });
    await fs.rename(source.target, destination.target);
    return { path: destination.relativePath, previousPath: source.relativePath };
  }

  async deletePath(projectId, input) {
    const { target, relativePath } = await this.resolveProjectPath(projectId, input);
    const stat = await fs.lstat(target).catch((error) => {
      if (error?.code === 'ENOENT') throw new StoreError('Path not found.', 404, 'FILE_NOT_FOUND');
      throw error;
    });
    if (stat.isSymbolicLink()) throw new StoreError('Symbolic links are not allowed.', 400, 'SYMLINK_BLOCKED');
    await fs.rm(target, { recursive: stat.isDirectory(), force: false });
    return { path: relativePath, deleted: true, ok: true };
  }
}

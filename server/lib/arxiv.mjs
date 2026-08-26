import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { findExecutable, runProcess } from './processes.mjs';
import { StoreError, normalizeRelativePath } from './store.mjs';

const SOURCE_EXTENSIONS = new Set(['.tex', '.sty', '.cls', '.ltx']);
const IMAGE_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.eps', '.ps', '.tif', '.tiff', '.gif', '.svg'];
const FONT_EXTENSIONS = ['.otf', '.ttf', '.pfb', '.pfm', '.afm', '.enc', '.map'];
const DATA_EXTENSIONS = ['.txt', '.csv', '.tsv', '.dat', '.json', '.yaml', '.yml', '.py', '.r', '.c', '.cc', '.cpp', '.h'];
const BLOCKED_DIRECTORIES = new Set(['collaboration', 'node_modules', 'build', 'dist', 'out', 'output']);
const GENERATED_EXTENSIONS = new Set([
  '.aux', '.log', '.toc', '.lof', '.lot', '.fls', '.fdb_latexmk', '.synctex',
  '.xdv', '.dvi', '.blg', '.bcf', '.run.xml', '.nav', '.snm', '.vrb', '.tmp',
]);
const BACKUP_SUFFIXES = ['~', '.bak', '.backup', '.old', '.orig', '.rej', '.swp', '.swo', '.temp'];
const MAX_FILES = 4_000;
const MAX_SOURCE_BYTES = 512 * 1024 * 1024;

function stripComments(content) {
  return String(content || '').split(/\r?\n/).map((line) => {
    for (let index = 0; index < line.length; index += 1) {
      if (line[index] !== '%') continue;
      let slashes = 0;
      for (let back = index - 1; back >= 0 && line[back] === '\\'; back -= 1) slashes += 1;
      if (slashes % 2 === 0) return line.slice(0, index);
    }
    return line;
  }).join('\n');
}

function pathSegments(relativePath) {
  return relativePath.split('/').filter(Boolean);
}

function assertExportablePath(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  const pieces = pathSegments(normalized);
  if (pieces.some((piece) => piece.startsWith('.'))) {
    throw new StoreError(
      `arXiv source cannot depend on hidden path “${normalized}”.`,
      422,
      'ARXIV_HIDDEN_DEPENDENCY',
    );
  }
  if (pieces.some((piece) => BLOCKED_DIRECTORIES.has(piece.toLowerCase()))) {
    throw new StoreError(
      `arXiv source cannot depend on generated or collaboration path “${normalized}”.`,
      422,
      'ARXIV_BLOCKED_DEPENDENCY',
    );
  }
  return normalized;
}

function isBackupName(relativePath) {
  const name = path.posix.basename(relativePath).toLowerCase();
  return name.startsWith('#')
    || name.endsWith('#')
    || BACKUP_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

function isGeneratedFile(relativePath) {
  const lower = relativePath.toLowerCase();
  if (lower.endsWith('.synctex.gz')) return true;
  return GENERATED_EXTENSIONS.has(path.posix.extname(lower));
}

function cleanDependency(value) {
  return String(value || '').trim().replace(/^['"]|['"]$/g, '');
}

function candidateBases(sourcePath, dependency) {
  const sourceDirectory = path.posix.dirname(sourcePath);
  const local = sourceDirectory === '.' ? dependency : path.posix.join(sourceDirectory, dependency);
  return [...new Set([local, dependency])];
}

function normalizeCandidate(sourcePath, dependency) {
  const value = cleanDependency(dependency);
  if (!value || /[\\#{}\0]/.test(value)) return [];
  if (path.posix.isAbsolute(value) || value.startsWith('~/')) {
    throw new StoreError(
      `arXiv source references a file outside the project: “${value}”.`,
      422,
      'ARXIV_EXTERNAL_DEPENDENCY',
    );
  }
  const candidates = [];
  let escapedProject = false;
  for (const base of candidateBases(sourcePath, value)) {
    const normalized = path.posix.normalize(base);
    if (normalized === '..' || normalized.startsWith('../')) {
      escapedProject = true;
      continue;
    }
    candidates.push(assertExportablePath(normalized));
  }
  if (candidates.length === 0 && escapedProject) {
    throw new StoreError(
      `arXiv source references a file outside the project: “${value}”.`,
      422,
      'ARXIV_EXTERNAL_DEPENDENCY',
    );
  }
  return [...new Set(candidates)];
}

async function firstExisting(store, projectId, sourcePath, dependency, extensions = ['']) {
  const bases = normalizeCandidate(sourcePath, dependency);
  for (const base of bases) {
    const hasExtension = Boolean(path.posix.extname(base));
    for (const extension of hasExtension ? [''] : extensions) {
      const relativePath = assertExportablePath(`${base}${extension}`);
      const resolved = await store.resolveProjectPath(projectId, relativePath, { allowMissing: true });
      const stat = await fs.lstat(resolved.target).catch((error) => {
        if (error?.code === 'ENOENT') return null;
        throw error;
      });
      if (!stat) continue;
      if (stat.isSymbolicLink()) {
        throw new StoreError('Symbolic links are not allowed in arXiv source.', 400, 'SYMLINK_BLOCKED');
      }
      if (stat.isFile()) return resolved.relativePath;
    }
  }
  return null;
}

function matches(content, expression) {
  const values = [];
  let match;
  while ((match = expression.exec(content))) values.push(match[1]);
  return values;
}

function graphicDirectories(content) {
  const directories = [];
  const expression = /\\graphicspath\s*\{((?:\s*\{[^{}]+\}\s*)+)\}/g;
  let match;
  while ((match = expression.exec(content))) {
    const nested = /\{([^{}]+)\}/g;
    let directory;
    while ((directory = nested.exec(match[1]))) directories.push(directory[1]);
  }
  return directories;
}

function fontFiles(content) {
  const results = [];
  const expression = /\\(?:setmainfont|setsansfont|setmonofont|newfontfamily)(?:\s*\\[A-Za-z@]+)?\s*\[([^\]]+)\]\s*\{[^{}]+\}/g;
  let match;
  while ((match = expression.exec(content))) {
    const options = match[1];
    const directory = options.match(/(?:^|,)\s*Path\s*=\s*\{?([^,}\s]+)\}?/i)?.[1] || '';
    const filePattern = /(?:^|,)\s*(?:UprightFont|BoldFont|ItalicFont|BoldItalicFont|Font)\s*=\s*\{?([^,}]+)\}?/gi;
    let file;
    while ((file = filePattern.exec(options))) {
      const value = cleanDependency(file[1]);
      if (FONT_EXTENSIONS.includes(path.posix.extname(value).toLowerCase())) results.push(`${directory}${value}`);
    }
  }
  return results;
}

function rootPdfPath(rootFile) {
  const extension = path.posix.extname(rootFile);
  return `${rootFile.slice(0, -extension.length)}.pdf`;
}

async function collectProjectDependencies({ store, projectId, rootFile }) {
  const normalizedRoot = assertExportablePath(rootFile);
  if (!normalizedRoot.toLowerCase().endsWith('.tex')) {
    throw new StoreError('The arXiv root file must be a .tex file.', 400, 'INVALID_ROOT_FILE');
  }

  const files = new Set();
  const scanned = new Set();
  const queue = [normalizedRoot];
  const rootPdf = rootPdfPath(normalizedRoot).toLowerCase();
  let bibliographyRequested = false;

  const add = (relativePath) => {
    if (!relativePath) return;
    const normalized = assertExportablePath(relativePath);
    if (isBackupName(normalized) || isGeneratedFile(normalized)) return;
    if (normalized.toLowerCase() === rootPdf) return;
    files.add(normalized);
    if (SOURCE_EXTENSIONS.has(path.posix.extname(normalized).toLowerCase()) && !scanned.has(normalized)) {
      queue.push(normalized);
    }
  };

  add(normalizedRoot);
  while (queue.length) {
    const sourcePath = queue.shift();
    if (scanned.has(sourcePath)) continue;
    scanned.add(sourcePath);
    const record = await store.readFile(projectId, sourcePath);
    const content = stripComments(record.content);

    for (const dependency of matches(content, /\\(?:input|include|subfile)\s*\{([^{}]+)\}/g)) {
      add(await firstExisting(store, projectId, sourcePath, dependency, ['.tex', '.ltx']));
    }
    for (const dependencyList of matches(content, /\\(?:usepackage|RequirePackage)(?:\s*\[[^\]]*\])?\s*\{([^{}]+)\}/g)) {
      for (const dependency of dependencyList.split(',')) {
        add(await firstExisting(store, projectId, sourcePath, dependency.trim(), ['.sty']));
      }
    }
    for (const dependencyList of matches(content, /\\documentclass(?:\s*\[[^\]]*\])?\s*\{([^{}]+)\}/g)) {
      for (const dependency of dependencyList.split(',')) {
        add(await firstExisting(store, projectId, sourcePath, dependency.trim(), ['.cls']));
      }
    }

    const bibliographies = [
      ...matches(content, /\\bibliography\s*\{([^{}]+)\}/g).flatMap((value) => value.split(',')),
      ...matches(content, /\\addbibresource(?:\s*\[[^\]]*\])?\s*\{([^{}]+)\}/g),
    ];
    if (bibliographies.length) bibliographyRequested = true;
    for (const dependency of bibliographies) {
      add(await firstExisting(store, projectId, sourcePath, dependency.trim(), ['.bib']));
    }
    for (const dependency of matches(content, /\\bibliographystyle\s*\{([^{}]+)\}/g)) {
      add(await firstExisting(store, projectId, sourcePath, dependency, ['.bst']));
    }

    const imagePaths = matches(content, /\\(?:includegraphics\*?|includepdf|includesvg)(?:\s*\[[^\]]*\])?\s*\{([^{}]+)\}/g);
    const graphicsPaths = graphicDirectories(content);
    for (const dependency of imagePaths) {
      const candidates = [dependency, ...graphicsPaths.map((directory) => `${directory}${dependency}`)];
      let resolved = null;
      for (const candidate of candidates) {
        resolved = await firstExisting(store, projectId, sourcePath, candidate, IMAGE_EXTENSIONS);
        if (resolved) break;
      }
      add(resolved);
    }
    for (const dependency of fontFiles(content)) {
      add(await firstExisting(store, projectId, sourcePath, dependency, FONT_EXTENSIONS));
    }
    for (const dependency of matches(content, /\\(?:lstinputlisting|verbatiminput)(?:\s*\[[^\]]*\])?\s*\{([^{}]+)\}/g)) {
      add(await firstExisting(store, projectId, sourcePath, dependency, DATA_EXTENSIONS));
    }
    for (const dependency of matches(content, /\\inputminted(?:\s*\[[^\]]*\])?\s*\{[^{}]+\}\s*\{([^{}]+)\}/g)) {
      add(await firstExisting(store, projectId, sourcePath, dependency, DATA_EXTENSIONS));
    }
  }

  let generatedBbl = null;
  if (bibliographyRequested) {
    const stem = path.posix.basename(normalizedRoot, path.posix.extname(normalizedRoot));
    for (const candidate of [
      path.posix.join(path.posix.dirname(normalizedRoot), `${stem}.bbl`),
      `${stem}.bbl`,
    ]) {
      const existing = await firstExisting(store, projectId, normalizedRoot, candidate, ['']);
      if (existing) {
        add(existing);
        break;
      }
    }

    if (![...files].some((item) => item.toLowerCase().endsWith('.bbl'))) {
      const root = await store.projectRoot(projectId);
      const buildDirectory = path.join(root, '.jhana-build');
      const buildStat = await fs.lstat(buildDirectory).catch(() => null);
      if (buildStat?.isDirectory() && !buildStat.isSymbolicLink()) {
        const source = path.join(buildDirectory, `${stem}.bbl`);
        const stat = await fs.lstat(source).catch(() => null);
        if (stat?.isFile() && !stat.isSymbolicLink()) generatedBbl = {
          source,
          archivePath: `${stem}.bbl`,
          size: stat.size,
          mtimeMs: stat.mtimeMs,
        };
      }
    }
  }

  const records = [];
  let totalBytes = 0;
  let newestProjectSourceMtime = 0;
  for (const relativePath of [...files].sort((left, right) => left.localeCompare(right))) {
    const resolved = await store.resolveProjectPath(projectId, relativePath);
    const stat = await fs.lstat(resolved.target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new StoreError('arXiv source may contain regular files only.', 400, 'SYMLINK_BLOCKED');
    }
    totalBytes += stat.size;
    newestProjectSourceMtime = Math.max(newestProjectSourceMtime, stat.mtimeMs);
    records.push({ source: resolved.target, archivePath: relativePath, size: stat.size, mtimeMs: stat.mtimeMs });
  }
  if (generatedBbl && generatedBbl.mtimeMs >= newestProjectSourceMtime) {
    totalBytes += generatedBbl.size;
    records.push(generatedBbl);
  }
  if (records.length > MAX_FILES || totalBytes > MAX_SOURCE_BYTES) {
    throw new StoreError('The arXiv source set is too large to archive safely.', 413, 'ARXIV_SOURCE_TOO_LARGE');
  }

  return {
    rootFile: normalizedRoot,
    files: records,
    totalBytes,
    bibliographyRequested,
    hasBbl: records.some((record) => record.archivePath.toLowerCase().endsWith('.bbl')),
  };
}

async function safeCopy(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true });
  const noFollow = fsConstants.O_NOFOLLOW || 0;
  let sourceHandle;
  let destinationHandle;
  try {
    sourceHandle = await fs.open(source, fsConstants.O_RDONLY | noFollow);
    const stat = await sourceHandle.stat();
    if (!stat.isFile()) throw new StoreError('arXiv source may contain regular files only.', 400, 'SYMLINK_BLOCKED');
    destinationHandle = await fs.open(destination, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL, 0o600);
    const buffer = Buffer.allocUnsafe(128 * 1024);
    let readPosition = 0;
    while (true) {
      const { bytesRead } = await sourceHandle.read(buffer, 0, buffer.length, readPosition);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await destinationHandle.write(buffer, written, bytesRead - written);
        written += result.bytesWritten;
      }
      readPosition += bytesRead;
    }
  } catch (error) {
    if (error?.code === 'ELOOP') {
      throw new StoreError('Symbolic links are not allowed in arXiv source.', 400, 'SYMLINK_BLOCKED');
    }
    throw error;
  } finally {
    await destinationHandle?.close().catch(() => {});
    await sourceHandle?.close().catch(() => {});
  }
}

export async function inspectArxivSource(options) {
  return collectProjectDependencies(options);
}

export async function createArxivSourceArchive(options) {
  const inspection = await collectProjectDependencies(options);
  const tar = await findExecutable('tar');
  if (!tar) throw new StoreError('tar is required to create an arXiv source archive.', 503, 'TAR_UNAVAILABLE');
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'pageturnover-arxiv-'));
  const stagingDirectory = path.join(temporaryRoot, 'source');
  const archivePath = path.join(temporaryRoot, 'arxiv-source.tar.gz');
  await fs.mkdir(stagingDirectory);
  try {
    for (const record of inspection.files) {
      const destination = path.resolve(stagingDirectory, record.archivePath);
      if (!destination.startsWith(`${stagingDirectory}${path.sep}`)) {
        throw new StoreError('Invalid arXiv archive path.', 400, 'INVALID_PATH');
      }
      await safeCopy(record.source, destination);
    }
    const result = await runProcess(tar, ['-czf', archivePath, '-C', stagingDirectory, '.'], {
      timeoutMs: 30_000,
      maxOutput: 100_000,
      env: { LC_ALL: 'C', LANG: 'C', COPYFILE_DISABLE: '1' },
    });
    const stat = await fs.stat(archivePath).catch(() => null);
    if (result.code !== 0 || result.timedOut || !stat?.isFile()) {
      throw new StoreError('Could not create the arXiv source archive.', 500, 'ARXIV_ARCHIVE_FAILED');
    }
    return {
      path: archivePath,
      filename: `${options.projectId}-arxiv-source.tar.gz`,
      files: inspection.files.map((record) => record.archivePath),
      totalBytes: inspection.totalBytes,
      archiveBytes: stat.size,
      bibliographyRequested: inspection.bibliographyRequested,
      hasBbl: inspection.hasBbl,
      cleanup: () => fs.rm(temporaryRoot, { recursive: true, force: true }),
    };
  } catch (error) {
    await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

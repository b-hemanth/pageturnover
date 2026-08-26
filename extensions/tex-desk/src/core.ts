import path from 'node:path';

const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface ProjectContext {
  id: string;
  relativeFile: string;
  projectRoot: string;
}

export function normalizePort(value: unknown, fallback = 3006): number {
  const port = Number(value);
  return Number.isInteger(port) && port >= 1024 && port <= 65_535 ? port : fallback;
}

export function isProjectId(value: unknown): value is string {
  return typeof value === 'string' && PROJECT_ID_PATTERN.test(value);
}

export function normalizeProjectRootFile(value: unknown, fallback = 'main.tex'): string {
  if (typeof value !== 'string') return fallback;
  const candidate = value.trim().replaceAll('\\', '/');
  if (
    !candidate
    || candidate.includes('\0')
    || path.posix.isAbsolute(candidate)
    || /^[a-zA-Z]:\//.test(candidate)
  ) return fallback;
  const normalized = path.posix.normalize(candidate);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) return fallback;
  return normalized;
}

export function projectContextForPath(repoRoot: string, filePath: string): ProjectContext | undefined {
  const workspacesRoot = path.resolve(repoRoot, 'workspaces');
  const relative = path.relative(workspacesRoot, path.resolve(filePath));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  const pieces = relative.split(path.sep).filter(Boolean);
  const id = pieces[0];
  if (!id || pieces.length < 2 || !PROJECT_ID_PATTERN.test(id)) return undefined;
  return {
    id,
    relativeFile: pieces.slice(1).join('/'),
    projectRoot: path.join(workspacesRoot, id),
  };
}

export function safeArchiveFilename(contentDisposition: string | null, projectId: string): string {
  const encoded = contentDisposition?.match(/filename\*=UTF-8''([^;]+)/i)?.[1];
  const plain = contentDisposition?.match(/filename="?([^";]+)"?/i)?.[1];
  let candidate = plain;
  if (encoded) {
    try {
      candidate = decodeURIComponent(encoded);
    } catch {
      candidate = plain;
    }
  }
  if (!candidate) candidate = `${projectId}-arxiv-source.tar.gz`;
  candidate = path.basename(candidate).replace(/[^a-zA-Z0-9._-]+/g, '-');
  return candidate.endsWith('.tar.gz') ? candidate : `${candidate}.tar.gz`;
}

export function pdfFilename(rootFile: string): string {
  const extension = path.extname(rootFile);
  const stem = path.basename(rootFile, extension);
  return `${stem || 'main'}.pdf`;
}

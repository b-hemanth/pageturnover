import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../server/app.mjs';

const sourceTemplates = path.resolve('templates');
const packageManifest = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8'));
const cleanups = [];
const execFileAsync = promisify(execFile);

async function startRuntime({ accessToken = '', watch = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pageturnover-server-test-'));
  const workspacesDir = path.join(root, 'workspaces');
  const templatesDir = path.join(root, 'templates');
  const distDir = path.join(root, 'dist');
  await Promise.all([
    fs.mkdir(workspacesDir, { recursive: true }),
    fs.cp(sourceTemplates, templatesDir, { recursive: true }),
    fs.mkdir(distDir, { recursive: true }),
  ]);
  await fs.writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>TeX desk</title>', 'utf8');
  const runtime = await createApp({ workspacesDir, templatesDir, distDir, accessToken, watch });
  const server = await new Promise((resolve) => {
    const instance = runtime.app.listen(0, '127.0.0.1', () => resolve(instance));
  });
  const address = server.address();
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const cleanup = async () => {
    await new Promise((resolve) => server.close(resolve));
    await runtime.close();
    await fs.rm(root, { recursive: true, force: true });
  };
  cleanups.push(cleanup);
  return { baseUrl, root, workspacesDir };
}

async function json(response) {
  const body = await response.json();
  return { response, body };
}

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

describe.sequential('TeX desk local API', () => {
  it('reports the application package version from the health endpoint', async () => {
    const { baseUrl } = await startRuntime();
    const health = await json(await fetch(`${baseUrl}/api/health`));
    expect(health.response.status).toBe(200);
    expect(health.body.version).toBe(packageManifest.version);
  });

  it('creates template projects and enforces optimistic saves and path boundaries', async () => {
    const { baseUrl } = await startRuntime();
    const templates = await json(await fetch(`${baseUrl}/api/templates`));
    expect(templates.response.status).toBe(200);
    expect(templates.body.templates.map((item) => item.id)).toEqual([
      'arxiv-alpoge',
      'research-paper',
      'jhana-paper',
      'blank',
    ]);

    const created = await json(await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'API Paper', template: 'blank' }),
    }));
    expect(created.response.status).toBe(201);
    expect(created.body.project.rootFile).toBe('main.tex');
    const projectId = created.body.project.id;

    const original = await json(await fetch(`${baseUrl}/api/projects/${projectId}/file?path=main.tex`));
    expect(original.body.version).toMatch(/^[a-f0-9]{64}$/);
    const saved = await json(await fetch(`${baseUrl}/api/projects/${projectId}/file`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'main.tex',
        content: original.body.content.replace('Untitled Document', 'API Paper'),
        baseVersion: original.body.version,
      }),
    }));
    expect(saved.response.status).toBe(200);
    expect(saved.body.version).not.toBe(original.body.version);

    const conflict = await json(await fetch(`${baseUrl}/api/projects/${projectId}/file`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'main.tex', content: 'stale', baseVersion: original.body.version }),
    }));
    expect(conflict.response.status).toBe(409);
    expect(conflict.body.error.code).toBe('VERSION_CONFLICT');
    expect(conflict.body.current.version).toBe(saved.body.version);

    const traversal = await json(await fetch(`${baseUrl}/api/projects/${projectId}/file?path=${encodeURIComponent('../outside')}`));
    expect(traversal.response.status).toBe(400);
    expect(traversal.body.error.code).toBe('INVALID_PATH');
  });

  it('returns expected TeX failures as data and retains the last good PDF', async () => {
    const { baseUrl } = await startRuntime();
    const created = await (await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Compile Proof', template: 'blank' }),
    })).json();
    const projectId = created.project.id;

    const firstCompile = await json(await fetch(`${baseUrl}/api/projects/${projectId}/compile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rootFile: 'main.tex' }),
    }));
    expect(firstCompile.response.status).toBe(200);
    expect(firstCompile.body.success).toBe(true);
    expect(firstCompile.body.pdfUrl).toContain('/pdf?');

    const original = await (await fetch(`${baseUrl}/api/projects/${projectId}/file?path=main.tex`)).json();
    await fetch(`${baseUrl}/api/projects/${projectId}/file`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        path: 'main.tex',
        content: original.content.replace('Start writing here.', '\\definitelyUndefinedCommand'),
        baseVersion: original.version,
      }),
    });
    const failedCompile = await json(await fetch(`${baseUrl}/api/projects/${projectId}/compile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rootFile: 'main.tex' }),
    }));
    expect(failedCompile.response.status).toBe(200);
    expect(failedCompile.body.success).toBe(false);
    expect(failedCompile.body.lastGoodPdf).toBe(true);
    expect(failedCompile.body.pdfUrl).toContain('/pdf?');
    expect(failedCompile.body.diagnostics.some((item) => item.severity === 'error')).toBe(true);

    const pdf = await fetch(`${baseUrl}${failedCompile.body.pdfUrl}`);
    expect(pdf.status).toBe(200);
    expect(pdf.headers.get('content-type')).toBe('application/pdf');
    expect((await pdf.arrayBuffer()).byteLength).toBeGreaterThan(1_000);
  }, 30_000);

  it('exports a dependency-only arXiv archive without hidden state, stale assets, or symlinks', async () => {
    const { baseUrl, root, workspacesDir } = await startRuntime();
    const created = await (await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Archive Proof', template: 'blank' }),
    })).json();
    const projectId = created.project.id;
    const projectRoot = path.join(workspacesDir, projectId);
    await Promise.all([
      fs.mkdir(path.join(projectRoot, 'sections'), { recursive: true }),
      fs.mkdir(path.join(projectRoot, 'figures'), { recursive: true }),
      fs.mkdir(path.join(projectRoot, 'assets'), { recursive: true }),
      fs.mkdir(path.join(projectRoot, 'collaboration'), { recursive: true }),
    ]);
    await Promise.all([
      fs.writeFile(path.join(projectRoot, 'main.tex'), String.raw`\documentclass{article}
\usepackage{local}
\usepackage{graphicx}
\begin{document}
\input{sections/body}
\includegraphics{figures/plot}
\end{document}
`, 'utf8'),
      fs.writeFile(path.join(projectRoot, 'local.sty'), '\\ProvidesPackage{local}\n\\RequirePackage{amsmath}\n', 'utf8'),
      fs.writeFile(path.join(projectRoot, 'sections/body.tex'), 'Archive body.\\input{../shared}\n', 'utf8'),
      fs.writeFile(path.join(projectRoot, 'shared.tex'), 'Shared source.\n', 'utf8'),
      fs.writeFile(path.join(projectRoot, 'figures/plot.png'), Buffer.from('89504e470d0a1a0a', 'hex')),
      fs.writeFile(path.join(projectRoot, 'jhana.sty'), '\\ProvidesPackage{jhana}\n', 'utf8'),
      fs.writeFile(path.join(projectRoot, 'assets/stale-logo.png'), Buffer.from('stale')),
      fs.writeFile(path.join(projectRoot, 'notes.md'), 'private notes\n', 'utf8'),
      fs.writeFile(path.join(projectRoot, 'main.pdf'), Buffer.from('%PDF-stale')),
      fs.writeFile(path.join(projectRoot, '.hidden.tex'), 'hidden\n', 'utf8'),
      fs.writeFile(path.join(projectRoot, 'collaboration/request.json'), '{}\n', 'utf8'),
    ]);
    const outside = path.join(root, 'outside.tex');
    await fs.writeFile(outside, 'outside\n', 'utf8');
    await fs.symlink(outside, path.join(projectRoot, 'leak.tex'));

    const response = await fetch(`${baseUrl}/api/projects/${projectId}/export/arxiv?generateBbl=0`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-disposition')).toContain(`${projectId}-arxiv-source.tar.gz`);
    const archivePath = path.join(root, 'source.tar.gz');
    await fs.writeFile(archivePath, Buffer.from(await response.arrayBuffer()));
    const listing = await execFileAsync('tar', ['-tzf', archivePath], { env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
    const files = listing.stdout.split(/\r?\n/)
      .map((entry) => entry.replace(/^\.\//, ''))
      .filter((entry) => entry && !entry.endsWith('/'))
      .sort();
    expect(files).toEqual([
      'figures/plot.png',
      'local.sty',
      'main.tex',
      'sections/body.tex',
      'shared.tex',
    ]);

    await fs.writeFile(path.join(projectRoot, 'main.tex'), String.raw`\documentclass{article}
\begin{document}\input{leak}\end{document}
`, 'utf8');
    const unsafe = await json(await fetch(`${baseUrl}/api/projects/${projectId}/export/arxiv?generateBbl=0`));
    expect(unsafe.response.status).toBe(400);
    expect(unsafe.body.error.code).toBe('SYMLINK_BLOCKED');
  });

  it('generates and includes the matching bibliography output in arXiv source', async () => {
    const { baseUrl, root, workspacesDir } = await startRuntime();
    const created = await (await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Bibliography Archive', template: 'blank' }),
    })).json();
    const projectId = created.project.id;
    const projectRoot = path.join(workspacesDir, projectId);
    await fs.writeFile(path.join(projectRoot, 'main.tex'), String.raw`\documentclass{article}
\begin{document}
Source archive citation~\cite{proof}.
\bibliographystyle{plain}
\bibliography{references}
\end{document}
`, 'utf8');
    await fs.writeFile(path.join(projectRoot, 'references.bib'), `@article{proof,
  author = {Ada Example},
  title = {A Verifiable Result},
  journal = {Journal of Tests},
  year = {2026}
}\n`, 'utf8');

    const response = await fetch(`${baseUrl}/api/projects/${projectId}/export/arxiv`);
    expect(response.status).toBe(200);
    expect(response.headers.get('x-arxiv-bibliography')).toBe('bbl-included');
    const archivePath = path.join(root, 'bibliography-source.tar.gz');
    const extractionPath = path.join(root, 'bibliography-source');
    await fs.writeFile(archivePath, Buffer.from(await response.arrayBuffer()));
    await fs.mkdir(extractionPath);
    await execFileAsync('tar', ['-xzf', archivePath, '-C', extractionPath], { env: { ...process.env, LC_ALL: 'C', LANG: 'C' } });
    expect(await fs.readFile(path.join(extractionPath, 'main.tex'), 'utf8')).toContain('\\bibliography{references}');
    expect(await fs.readFile(path.join(extractionPath, 'references.bib'), 'utf8')).toContain('@article{proof');
    expect(await fs.readFile(path.join(extractionPath, 'main.bbl'), 'utf8')).toContain('\\bibitem{proof}');
    expect(await fs.readFile(path.join(projectRoot, '.jhana-build/main.bbl'), 'utf8')).toContain('\\bibitem{proof}');
    await expect(fs.stat(path.join(projectRoot, 'main.bbl'))).rejects.toMatchObject({ code: 'ENOENT' });
  }, 30_000);

  it('lints structure, extracts an outline, and completes forward/reverse SyncTeX', async () => {
    const { baseUrl } = await startRuntime();
    const created = await (await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Sync Proof', template: 'blank' }),
    })).json();
    const projectId = created.project.id;
    const original = await (await fetch(`${baseUrl}/api/projects/${projectId}/file?path=main.tex`)).json();
    const content = original.content.replace('Start writing here.', '\\section{First claim}\\label{sec:first}\nEvidence.');
    await fetch(`${baseUrl}/api/projects/${projectId}/file`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'main.tex', content, baseVersion: original.version }),
    });

    const lint = await json(await fetch(`${baseUrl}/api/projects/${projectId}/lint`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: 'main.tex', content }),
    }));
    expect(lint.response.status).toBe(200);
    expect(lint.body.outline[0]).toMatchObject({ kind: 'section', title: 'First claim' });

    const compile = await (await fetch(`${baseUrl}/api/projects/${projectId}/compile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rootFile: 'main.tex' }),
    })).json();
    expect(compile.success).toBe(true);

    const line = content.split('\n').findIndex((value) => value.includes('section{First claim}')) + 1;
    const view = await json(await fetch(`${baseUrl}/api/projects/${projectId}/synctex/view`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rootFile: 'main.tex', file: 'main.tex', line, column: 1 }),
    }));
    expect(view.response.status).toBe(200);
    expect(view.body.page).toBe(1);

    const edit = await json(await fetch(`${baseUrl}/api/projects/${projectId}/synctex/edit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ rootFile: 'main.tex', page: view.body.page, x: view.body.x, y: view.body.y }),
    }));
    expect(edit.response.status).toBe(200);
    expect(edit.body.file).toBe('main.tex');
    expect(edit.body.line).toBeGreaterThan(0);
  }, 30_000);

  it('protects API and PDF routes with the token bootstrap cookie when configured', async () => {
    const { baseUrl } = await startRuntime({ accessToken: 'test-only-secret' });
    const denied = await fetch(`${baseUrl}/api/health`);
    expect(denied.status).toBe(401);

    const bootstrap = await fetch(`${baseUrl}/?access=test-only-secret`, { redirect: 'manual' });
    expect(bootstrap.status).toBe(303);
    expect(bootstrap.headers.get('location')).toBe('/');
    const setCookie = bootstrap.headers.get('set-cookie');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).not.toContain('test-only-secret; Path=/; Secure');
    const cookie = setCookie.split(';')[0];

    const allowed = await fetch(`${baseUrl}/api/health`, { headers: { cookie } });
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).ok).toBe(true);
  });

  it('writes an inspectable, non-mutating filesystem AI handoff', async () => {
    const { baseUrl, workspacesDir } = await startRuntime();
    const created = await (await fetch(`${baseUrl}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Handoff Proof', template: 'blank' }),
    })).json();
    const projectId = created.project.id;
    const original = await (await fetch(`${baseUrl}/api/projects/${projectId}/file?path=main.tex`)).json();
    const handoff = await json(await fetch(`${baseUrl}/api/ai/handoff`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        projectId,
        path: 'main.tex',
        action: 'tighten',
        instruction: 'Tighten the opening.',
        selection: 'Start writing here.',
        content: original.content,
      }),
    }));
    expect(handoff.response.status).toBe(202);
    expect(handoff.body.path).toMatch(/^\.jhana-ai\/requests\/.+\.json$/);
    const record = JSON.parse(await fs.readFile(path.join(workspacesDir, projectId, handoff.body.path), 'utf8'));
    expect(record).toMatchObject({ status: 'pending', projectId, path: 'main.tex', action: 'tighten' });
    const after = await (await fetch(`${baseUrl}/api/projects/${projectId}/file?path=main.tex`)).json();
    expect(after.version).toBe(original.version);
  });
});

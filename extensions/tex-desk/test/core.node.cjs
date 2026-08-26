// Named *.node.cjs so the parent Vitest suite does not collect this Node-only test.
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  isProjectId,
  normalizePort,
  normalizeProjectRootFile,
  pdfFilename,
  projectContextForPath,
  safeArchiveFilename,
} = require('../dist/core.js');

test('normalizes configured ports without allowing privileged or invalid values', () => {
  assert.equal(normalizePort(3006), 3006);
  assert.equal(normalizePort('5173'), 5173);
  assert.equal(normalizePort(80), 3006);
  assert.equal(normalizePort(70_000), 3006);
});

test('maps a disk file to its project id and project-relative path', () => {
  const root = path.resolve('fixtures', 'tex-desk');
  assert.deepEqual(
    projectContextForPath(root, path.join(root, 'workspaces', 'welcome-paper', 'sections', 'proof.tex')),
    {
      id: 'welcome-paper',
      relativeFile: 'sections/proof.tex',
      projectRoot: path.join(root, 'workspaces', 'welcome-paper'),
    },
  );
  assert.equal(projectContextForPath(root, path.join(root, 'templates', 'main.tex')), undefined);
  assert.equal(projectContextForPath(root, path.join(root, 'workspaces', '..', 'outside.tex')), undefined);
});

test('sanitizes server-provided archive names and keeps the tar.gz suffix', () => {
  assert.equal(
    safeArchiveFilename('attachment; filename="welcome-paper-arxiv-source.tar.gz"', 'welcome-paper'),
    'welcome-paper-arxiv-source.tar.gz',
  );
  assert.equal(
    safeArchiveFilename('attachment; filename="../../unsafe name"', 'welcome-paper'),
    'unsafe-name.tar.gz',
  );
  assert.equal(safeArchiveFilename(null, 'paper'), 'paper-arxiv-source.tar.gz');
});

test('validates project ids and keeps root files inside the project', () => {
  assert.equal(isProjectId('welcome-paper'), true);
  assert.equal(isProjectId('../paper'), false);
  assert.equal(normalizeProjectRootFile('sections/article.tex'), 'sections/article.tex');
  assert.equal(normalizeProjectRootFile('sections\\article.tex'), 'sections/article.tex');
  assert.equal(normalizeProjectRootFile('../private.tex'), 'main.tex');
  assert.equal(normalizeProjectRootFile('C:\\private.tex'), 'main.tex');
});

test('derives the stable proof name from the project root file', () => {
  assert.equal(pdfFilename('main.tex'), 'main.pdf');
  assert.equal(pdfFilename('article.latex'), 'article.pdf');
});

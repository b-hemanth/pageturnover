import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { findExecutable, inheritedLocaleEnv, runProcess } from './processes.mjs';
import { StoreError, normalizeRelativePath } from './store.mjs';

const queues = new Map();

function enqueue(projectId, task) {
  const previous = queues.get(projectId) || Promise.resolve();
  const current = previous.catch(() => {}).then(task);
  queues.set(projectId, current);
  current.then(
    () => { if (queues.get(projectId) === current) queues.delete(projectId); },
    () => { if (queues.get(projectId) === current) queues.delete(projectId); },
  );
  return current;
}

function diagnosticKey(item) {
  return `${item.source}:${item.severity}:${item.file || ''}:${item.line || 0}:${item.message}`;
}

export function parseLatexDiagnostics(log, fallbackFile = 'main.tex') {
  const diagnostics = [];
  const add = (item) => diagnostics.push({
    source: 'latex',
    severity: 'error',
    file: fallbackFile,
    line: 1,
    column: 1,
    ...item,
  });
  const lines = String(log || '').split(/\r?\n/);
  let pendingError = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    let match = line.match(/^(.+?\.tex):(\d+)(?::(\d+))?:\s*(.+)$/);
    if (match) {
      add({
        severity: /warning/i.test(match[4]) ? 'warning' : 'error',
        file: path.basename(match[1]),
        line: Number(match[2]),
        column: Number(match[3] || 1),
        message: match[4].trim(),
      });
      continue;
    }

    match = line.match(/^!\s+(.+)$/);
    if (match) {
      pendingError = match[1].trim();
      const nearby = lines.slice(index + 1, index + 5).join('\n').match(/l\.(\d+)\s*(.*)/);
      add({ line: Number(nearby?.[1] || 1), message: pendingError });
      continue;
    }

    match = line.match(/^(?:LaTeX|Package\s+([^\s]+)) Warning:\s*(.+?)(?:\s+on input line\s+(\d+))?\.?$/);
    if (match) {
      add({
        source: match[1] ? `latex:${match[1]}` : 'latex',
        severity: 'warning',
        line: Number(match[3] || 1),
        message: match[2].trim(),
      });
      continue;
    }

    match = line.match(/^(Overfull|Underfull) \\[hv]box .*? at lines? (\d+)(?:--(\d+))?/);
    if (match) {
      add({
        source: 'latex:layout',
        severity: match[1] === 'Overfull' ? 'warning' : 'info',
        line: Number(match[2]),
        message: `${match[1]} box near line${match[3] ? `s ${match[2]}-${match[3]}` : ` ${match[2]}`}.`,
      });
      continue;
    }

    if (/^Latexmk: Errors, so I did not complete making targets/.test(line) && diagnostics.length === 0) {
      add({ message: pendingError || 'XeLaTeX could not compile this document.' });
    }
  }
  return [...new Map(diagnostics.map((item) => [diagnosticKey(item), item])).values()].slice(0, 300);
}

function stripComments(line) {
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] !== '%') continue;
    let slashes = 0;
    for (let back = index - 1; back >= 0 && line[back] === '\\'; back -= 1) slashes += 1;
    if (slashes % 2 === 0) return line.slice(0, index);
  }
  return line;
}

export function extractOutline(content, file = undefined) {
  const levels = { part: 0, chapter: 1, section: 2, subsection: 3, subsubsection: 4, paragraph: 5 };
  const outline = [];
  String(content || '').split(/\r?\n/).forEach((rawLine, index) => {
    const line = stripComments(rawLine);
    const expression = /\\(part|chapter|section|subsection|subsubsection|paragraph)\*?(?:\[[^\]]*\])?\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g;
    let match;
    while ((match = expression.exec(line))) {
      outline.push({
        type: match[1],
        kind: match[1],
        level: levels[match[1]],
        title: match[2].replace(/\\(?:textbf|textit|emph)\{([^{}]*)\}/g, '$1').replace(/\\[a-zA-Z@]+\*?/g, '').trim(),
        line: index + 1,
        ...(file ? { file } : {}),
      });
    }
  });
  return outline;
}

export function structuralDiagnostics(content, file = 'main.tex', { requireDocument } = {}) {
  const diagnostics = [];
  const environmentStack = [];
  const braceStack = [];
  const labels = new Map();
  const references = [];
  const lines = String(content || '').split(/\r?\n/);

  const add = (severity, line, message, source = 'structure', column = 1) => {
    diagnostics.push({ severity, line, column, message, source, file });
  };

  lines.forEach((rawLine, lineIndex) => {
    const lineNumber = lineIndex + 1;
    const line = stripComments(rawLine);
    const envPattern = /\\(begin|end)\{([^{}]+)\}/g;
    let envMatch;
    while ((envMatch = envPattern.exec(line))) {
      if (envMatch[1] === 'begin') {
        environmentStack.push({ name: envMatch[2], line: lineNumber });
      } else {
        const open = environmentStack.at(-1);
        if (!open) add('error', lineNumber, `\\end{${envMatch[2]}} has no matching \\begin.`, 'structure:environment', envMatch.index + 1);
        else if (open.name !== envMatch[2]) add('error', lineNumber, `Expected \\end{${open.name}}, found \\end{${envMatch[2]}}.`, 'structure:environment', envMatch.index + 1);
        else environmentStack.pop();
      }
    }

    for (let column = 0; column < line.length; column += 1) {
      if (line[column] !== '{' && line[column] !== '}') continue;
      let slashes = 0;
      for (let back = column - 1; back >= 0 && line[back] === '\\'; back -= 1) slashes += 1;
      if (slashes % 2 === 1) continue;
      if (line[column] === '{') braceStack.push({ line: lineNumber, column: column + 1 });
      else if (braceStack.length) braceStack.pop();
      else add('error', lineNumber, 'Unmatched closing brace.', 'structure:brace', column + 1);
    }

    const labelPattern = /\\label\{([^{}]+)\}/g;
    let labelMatch;
    while ((labelMatch = labelPattern.exec(line))) {
      const label = labelMatch[1];
      if (labels.has(label)) add('warning', lineNumber, `Duplicate label “${label}” (first defined on line ${labels.get(label)}).`, 'structure:label', labelMatch.index + 1);
      else labels.set(label, lineNumber);
    }
    const refPattern = /\\(?:ref|eqref|autoref|pageref)\{([^{}]+)\}/g;
    let refMatch;
    while ((refMatch = refPattern.exec(line))) references.push({ label: refMatch[1], line: lineNumber, column: refMatch.index + 1 });
    if (/\\cite[a-zA-Z*]*\{\s*\}/.test(line)) add('warning', lineNumber, 'Citation command has no key.', 'structure:citation');
  });

  for (const open of environmentStack) add('error', open.line, `\\begin{${open.name}} is not closed.`, 'structure:environment');
  for (const open of braceStack.slice(-25)) add('error', open.line, 'Opening brace is not closed.', 'structure:brace', open.column);
  for (const reference of references) {
    if (!labels.has(reference.label)) add('warning', reference.line, `Reference “${reference.label}” has no label in this file.`, 'structure:reference', reference.column);
  }

  const joined = lines.map(stripComments).join('\n');
  const shouldRequireDocument = requireDocument ?? /\\(?:documentclass|begin\{document\}|end\{document\})/.test(joined);
  if (shouldRequireDocument) {
    if (!/\\documentclass(?:\[[^\]]*\])?\{[^{}]+\}/.test(joined)) add('warning', 1, 'No \\documentclass declaration found.', 'structure:document');
    if (!/\\begin\{document\}/.test(joined)) add('error', 1, 'No \\begin{document} found.', 'structure:document');
    if (!/\\end\{document\}/.test(joined)) add('error', lines.length, 'No \\end{document} found.', 'structure:document');
  }

  return diagnostics.slice(0, 300);
}

export async function lintLatex({ content, file = 'main.tex', cwd, requireDocument }) {
  const diagnostics = structuralDiagnostics(content, file, { requireDocument });
  const chktex = await findExecutable('chktex');
  if (chktex) {
    try {
      const format = '%f:%l:%c:%d:%k:%n:%m\n';
      const result = await runProcess(chktex, ['-q', '-v0', '-p', file, '-f', format], {
        cwd,
        input: content,
        timeoutMs: 10_000,
        env: inheritedLocaleEnv(),
        maxOutput: 300_000,
      });
      for (const line of `${result.stdout}\n${result.stderr}`.split(/\r?\n/)) {
        const match = line.match(/^(.+?):(\d+):(\d+):(\d+):(Warning|Error|Message):(\d+):(.*)$/);
        if (!match) continue;
        diagnostics.push({
          file: match[1] || file,
          line: Number(match[2]),
          column: Number(match[3]),
          length: Number(match[4]) || 1,
          severity: match[5] === 'Error' ? 'error' : match[5] === 'Warning' ? 'warning' : 'info',
          code: Number(match[6]),
          message: match[7].trim(),
          source: 'chktex',
        });
      }
    } catch (error) {
      diagnostics.push({ file, line: 1, column: 1, severity: 'info', source: 'chktex', message: `ChkTeX unavailable: ${error.message}` });
    }
  }
  return {
    diagnostics: [...new Map(diagnostics.map((item) => [diagnosticKey(item), item])).values()],
    outline: extractOutline(content, file),
    tools: { chktex: Boolean(chktex) },
  };
}

function parsePages(output) {
  const match = String(output || '').match(/^Pages:\s+(\d+)/m);
  return match ? Number(match[1]) : undefined;
}

async function ensureSafeDirectory(directory) {
  const existing = await fs.lstat(directory).catch((error) => {
    if (error?.code === 'ENOENT') return null;
    throw error;
  });
  if (existing) {
    if (!existing.isDirectory() || existing.isSymbolicLink()) {
      throw new StoreError('Build path is not a safe directory.', 400, 'SYMLINK_BLOCKED');
    }
    return;
  }
  await fs.mkdir(directory);
  const created = await fs.lstat(directory);
  if (!created.isDirectory() || created.isSymbolicLink()) {
    throw new StoreError('Build path is not a safe directory.', 400, 'SYMLINK_BLOCKED');
  }
}

async function promoteArtifact(source, destination) {
  const temporary = path.join(path.dirname(destination), `.${path.basename(destination)}.${randomUUID()}.promote`);
  try {
    await fs.copyFile(source, temporary, fsConstants.COPYFILE_EXCL);
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function compileProject({ store, projectId, rootFile = 'main.tex', timeoutMs = 45_000 }) {
  return enqueue(projectId, async () => {
    const latexmk = await findExecutable('latexmk');
    if (!latexmk) throw new StoreError('latexmk is not installed.', 503, 'LATEXMK_UNAVAILABLE');
    const normalizedRoot = normalizeRelativePath(rootFile);
    if (!normalizedRoot.toLowerCase().endsWith('.tex')) throw new StoreError('Root file must be a .tex file.', 400, 'INVALID_ROOT_FILE');
    const { root: projectRoot, target: rootTarget } = await store.resolveProjectPath(projectId, normalizedRoot);
    const rootStat = await fs.stat(rootTarget).catch(() => null);
    if (!rootStat?.isFile()) throw new StoreError('Root TeX file not found.', 404, 'FILE_NOT_FOUND');

    const buildDir = path.join(projectRoot, '.jhana-build');
    const attemptsDir = path.join(buildDir, 'attempts');
    await ensureSafeDirectory(buildDir);
    await ensureSafeDirectory(attemptsDir);
    const attemptDir = path.join(attemptsDir, randomUUID());
    await fs.mkdir(attemptDir);
    const outputStem = path.basename(normalizedRoot, path.extname(normalizedRoot));
    const attemptPdfPath = path.join(attemptDir, `${outputStem}.pdf`);
    const stablePdfPath = path.join(buildDir, `${outputStem}.pdf`);

    const safeTimeout = Math.max(5_000, Math.min(Number(timeoutMs) || 45_000, 120_000));
    const result = await runProcess(latexmk, [
      '-norc',
      '-no-shell-escape',
      '-use-make-',
      '-recorder',
      '-xelatex',
      '-interaction=nonstopmode',
      '-file-line-error',
      '-synctex=1',
      '-halt-on-error',
      `-outdir=${attemptDir}`,
      normalizedRoot,
    ], {
      cwd: projectRoot,
      timeoutMs: safeTimeout,
      env: {
        ...inheritedLocaleEnv(),
        max_print_line: '2000',
        openin_any: 'p',
        openout_any: 'p',
      },
      maxOutput: 1_500_000,
    });
    const log = `${result.stdout}\n${result.stderr}`.trim();
    const attemptPdfStat = await fs.stat(attemptPdfPath).catch(() => null);
    const success = result.code === 0 && Boolean(attemptPdfStat?.isFile()) && !result.timedOut;
    if (success) {
      await promoteArtifact(attemptPdfPath, stablePdfPath);
      for (const extension of ['synctex.gz', 'log', 'fls', 'bbl']) {
        const source = path.join(attemptDir, `${outputStem}.${extension}`);
        const destination = path.join(buildDir, `${outputStem}.${extension}`);
        if (await fs.stat(source).catch(() => null)) await promoteArtifact(source, destination);
        else if (extension === 'bbl') await fs.rm(destination, { force: true }).catch(() => {});
      }
    }
    const stablePdfStat = await fs.stat(stablePdfPath).catch(() => null);
    const finalLog = await fs.readFile(path.join(attemptDir, `${outputStem}.log`), 'utf8').catch(() => log);
    const diagnostics = parseLatexDiagnostics(finalLog, normalizedRoot);
    if (result.timedOut) diagnostics.unshift({
      source: 'latex', severity: 'error', file: normalizedRoot, line: 1, column: 1,
      message: `Compilation exceeded the ${Math.round(safeTimeout / 1000)} second safety limit.`,
    });

    let pages;
    if (success) {
      const pdfinfo = await findExecutable('pdfinfo');
      if (pdfinfo) {
        const info = await runProcess(pdfinfo, [stablePdfPath], { cwd: projectRoot, timeoutMs: 4_000, maxOutput: 50_000 });
        pages = parsePages(`${info.stdout}\n${info.stderr}`);
      }
    }
    const compiledAt = new Date().toISOString();
    const response = {
      success,
      pdfUrl: stablePdfStat?.isFile() ? `/api/projects/${encodeURIComponent(projectId)}/pdf?rootFile=${encodeURIComponent(normalizedRoot)}&v=${encodeURIComponent(stablePdfStat.mtime.toISOString())}` : undefined,
      diagnostics,
      log: log.slice(-500_000),
      durationMs: result.durationMs,
      pages,
      compiledAt,
      timedOut: result.timedOut,
      lastGoodPdf: !success && Boolean(stablePdfStat?.isFile()),
    };
    await fs.rm(attemptDir, { recursive: true, force: true }).catch(() => {});
    return response;
  });
}

export async function compiledPdfPath({ store, projectId, rootFile = 'main.tex' }) {
  const normalizedRoot = normalizeRelativePath(rootFile);
  if (!normalizedRoot.toLowerCase().endsWith('.tex')) throw new StoreError('Root file must be a .tex file.', 400, 'INVALID_ROOT_FILE');
  const { root } = await store.resolveProjectPath(projectId, normalizedRoot);
  const buildDir = path.join(root, '.jhana-build');
  const buildStat = await fs.lstat(buildDir).catch(() => null);
  if (!buildStat?.isDirectory() || buildStat.isSymbolicLink()) throw new StoreError('Compile the document before opening its PDF.', 404, 'PDF_NOT_FOUND');
  const outputStem = path.basename(normalizedRoot, path.extname(normalizedRoot));
  const pdfPath = path.join(buildDir, `${outputStem}.pdf`);
  const stat = await fs.lstat(pdfPath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new StoreError('Compile the document before opening its PDF.', 404, 'PDF_NOT_FOUND');
  return pdfPath;
}

function numericField(fields, name, { minimum = -10_000_000, maximum = 10_000_000 } = {}) {
  const value = Number(fields[name]);
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new StoreError(`SyncTeX returned an invalid ${name} value.`, 422, 'SYNCTEX_INVALID_RESULT');
  }
  return value;
}

function firstSyncRecord(output) {
  const fields = {};
  let inResult = false;
  for (const line of String(output || '').split(/\r?\n/)) {
    if (line === 'SyncTeX result begin') {
      if (inResult && Object.keys(fields).length) break;
      inResult = true;
      continue;
    }
    if (line === 'SyncTeX result end' && Object.keys(fields).length) break;
    if (!inResult) continue;
    const separator = line.indexOf(':');
    if (separator > 0) {
      const key = line.slice(0, separator);
      if (fields[key] === undefined) fields[key] = line.slice(separator + 1);
    }
  }
  return fields;
}

function boundedInteger(value, name, minimum, maximum) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum) {
    throw new StoreError(`${name} is outside the valid range.`, 400, 'INVALID_SYNCTEX_INPUT');
  }
  return number;
}

function boundedCoordinate(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < -10_000 || number > 100_000) {
    throw new StoreError(`${name} is outside the valid range.`, 400, 'INVALID_SYNCTEX_INPUT');
  }
  return number;
}

async function pdfPageHeight(pdfPath, page) {
  const executable = await findExecutable('pdfinfo');
  if (!executable) throw new StoreError('pdfinfo is required for SyncTeX coordinates.', 503, 'PDFINFO_UNAVAILABLE');
  const result = await runProcess(executable, [
    '-f', String(page),
    '-l', String(page),
    pdfPath,
  ], {
    timeoutMs: 5_000,
    maxOutput: 200_000,
    env: inheritedLocaleEnv(),
  });
  const match = `${result.stdout}\n${result.stderr}`.match(
    /(?:Page\s+\d+\s+size|Page size):\s*[\d.]+\s+x\s+([\d.]+)\s+pts/i,
  );
  const height = Number(match?.[1]);
  if (result.code !== 0 || !Number.isFinite(height) || height <= 0) {
    throw new StoreError('The PDF page geometry could not be read.', 422, 'PDF_GEOMETRY_UNAVAILABLE');
  }
  return height;
}

export async function synctexView({ store, projectId, rootFile = 'main.tex', file, line, column = 1 }) {
  const executable = await findExecutable('synctex');
  if (!executable) throw new StoreError('SyncTeX is not installed.', 503, 'SYNCTEX_UNAVAILABLE');
  const source = await store.resolveProjectPath(projectId, file);
  const sourceStat = await fs.stat(source.target).catch(() => null);
  if (!sourceStat?.isFile()) throw new StoreError('Source file not found.', 404, 'FILE_NOT_FOUND');
  const safeLine = boundedInteger(line, 'line', 1, 10_000_000);
  const safeColumn = boundedInteger(column, 'column', 0, 10_000_000);
  const pdfPath = await compiledPdfPath({ store, projectId, rootFile });
  const buildDir = path.dirname(pdfPath);
  const result = await runProcess(executable, [
    'view',
    '-i', `${safeLine}:${safeColumn}:${source.relativePath}`,
    '-o', pdfPath,
    '-d', buildDir,
  ], {
    cwd: source.root,
    timeoutMs: 5_000,
    maxOutput: 200_000,
    env: inheritedLocaleEnv(),
  });
  const fields = firstSyncRecord(`${result.stdout}\n${result.stderr}`);
  if (result.code !== 0 || !fields.Page) throw new StoreError('No PDF position was found for this source line.', 404, 'SYNCTEX_NO_RESULT');
  const page = numericField(fields, 'Page', { minimum: 1, maximum: 100_000 });
  const syncY = numericField(fields, fields.y !== undefined ? 'y' : 'v');
  const height = Math.abs(numericField(fields, 'H'));
  const pageHeight = await pdfPageHeight(pdfPath, page);
  return {
    page,
    x: numericField(fields, fields.x !== undefined ? 'x' : 'h'),
    // SyncTeX measures down from the page top; PDF.js uses PDF points up from
    // the bottom. Return one explicit coordinate space at the HTTP boundary.
    y: pageHeight - syncY - height,
    width: numericField(fields, 'W', { minimum: 0 }),
    height,
  };
}

export async function synctexEdit({ store, projectId, rootFile = 'main.tex', page, x, y }) {
  const executable = await findExecutable('synctex');
  if (!executable) throw new StoreError('SyncTeX is not installed.', 503, 'SYNCTEX_UNAVAILABLE');
  const safePage = boundedInteger(page, 'page', 1, 100_000);
  const safeX = boundedCoordinate(x, 'x');
  const safeY = boundedCoordinate(y, 'y');
  const pdfPath = await compiledPdfPath({ store, projectId, rootFile });
  const pageHeight = await pdfPageHeight(pdfPath, safePage);
  const syncY = pageHeight - safeY;
  const projectRoot = await store.projectRoot(projectId);
  const buildDir = path.dirname(pdfPath);
  const result = await runProcess(executable, [
    'edit',
    '-o', `${safePage}:${safeX}:${syncY}:${pdfPath}`,
    '-d', buildDir,
  ], {
    cwd: projectRoot,
    timeoutMs: 5_000,
    maxOutput: 200_000,
    env: inheritedLocaleEnv(),
  });
  const fields = firstSyncRecord(`${result.stdout}\n${result.stderr}`);
  if (result.code !== 0 || !fields.Input || !fields.Line) throw new StoreError('No source position was found for this PDF point.', 404, 'SYNCTEX_NO_RESULT');

  let relativeInput;
  if (path.isAbsolute(fields.Input)) relativeInput = path.relative(projectRoot, fields.Input).split(path.sep).join('/');
  else relativeInput = path.posix.normalize(fields.Input.replace(/^\.\//, ''));
  const source = await store.resolveProjectPath(projectId, relativeInput);
  const sourceStat = await fs.stat(source.target).catch(() => null);
  if (!sourceStat?.isFile()) throw new StoreError('SyncTeX source is outside the project.', 400, 'SYNCTEX_UNSAFE_RESULT');

  return {
    file: source.relativePath,
    line: numericField(fields, 'Line', { minimum: 1, maximum: 10_000_000 }),
    column: Math.max(1, numericField(fields, 'Column', { minimum: -1, maximum: 10_000_000 }) + 1),
  };
}

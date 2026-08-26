import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const extensionRoot = path.join(repositoryRoot, 'extensions', 'tex-desk');
const EDITORS = ['cursor', 'code', 'codium'];
const UNUSABLE_REMOTE_MESSAGE = /only available in (?:WSL|.+editor|Visual Studio Code terminal)/i;

export function parseArgs(argv) {
  const options = {
    editor: undefined,
    help: false,
    ifAvailable: false,
    remoteOnly: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--if-available') options.ifAvailable = true;
    else if (argument === '--remote-only') options.remoteOnly = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else if (argument === '--editor') {
      const editor = argv[index + 1];
      if (!editor || !EDITORS.includes(editor)) {
        throw new Error(`--editor must be one of: ${EDITORS.join(', ')}`);
      }
      options.editor = editor;
      index += 1;
    } else {
      throw new Error(`Unknown option: ${argument}`);
    }
  }
  return options;
}

export function extensionVersionFromList(output, extensionId) {
  const wanted = extensionId.toLowerCase();
  for (const rawLine of String(output).split(/\r?\n/)) {
    const line = rawLine.replace(/\x1b\[[0-9;]*m/g, '').trim();
    const separator = line.lastIndexOf('@');
    if (separator < 1) continue;
    if (line.slice(0, separator).toLowerCase() === wanted) return line.slice(separator + 1);
  }
  return undefined;
}

export function hasExtensionManagementHelp(output) {
  const text = String(output);
  return text.includes('--list-extensions')
    && text.includes('--install-extension')
    && !UNUSABLE_REMOTE_MESSAGE.test(text);
}

export function classifyCliTarget(cliPath, remoteHint = false) {
  const normalized = String(cliPath).replaceAll('\\', '/').toLowerCase();
  return remoteHint
    || normalized.includes('/.cursor-server/')
    || normalized.includes('/.vscode-server/')
    || normalized.includes('/remote-cli/')
    ? 'remote'
    : 'local';
}

export function unavailableExitCode(ifAvailable) {
  return ifAvailable ? 0 : 1;
}

function usage() {
  return [
    'Usage: node scripts/install-cursor-extension.mjs [options]',
    '',
    'Options:',
    '  --editor cursor|code|codium  Restrict installation to one editor family',
    '  --remote-only                Require an active remote-workspace CLI',
    '  --if-available               Package successfully but do not fail if no usable CLI exists',
    '  -h, --help                   Show this help',
  ].join('\n');
}

function npmInvocation(args) {
  const npmExecPath = process.env.npm_execpath;
  if (npmExecPath && /npm-cli\.(?:c?js)$/i.test(npmExecPath)) {
    return { command: process.execPath, args: [npmExecPath, ...args] };
  }
  if (process.platform === 'win32') {
    const bundled = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
    return { command: process.execPath, args: [bundled, ...args], fallback: 'npm.cmd' };
  }
  return { command: 'npm', args };
}

function spawnShellFor(command) {
  return process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(command);
}

function editorNameFromCommand(command, fallback = 'cursor') {
  const name = path.basename(String(command)).toLowerCase();
  if (name.includes('codium')) return 'codium';
  if (name === 'code' || name.startsWith('code.')) return 'code';
  if (name.includes('cursor')) return 'cursor';
  return fallback;
}

function runInherited(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? repositoryRoot,
      env: { ...process.env, ...(options.env ?? {}) },
      shell: spawnShellFor(command),
      stdio: 'inherit',
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${path.basename(command)} failed${signal ? ` (${signal})` : ` with exit ${code}`}.`));
    });
  });
}

function runCaptured(command, args, timeoutMs = 30_000) {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: process.env,
      shell: spawnShellFor(command),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ...result, stdout, stderr });
    };
    const append = (current, chunk) => `${current}${chunk}`.slice(-1_000_000);
    child.stdout?.on('data', (chunk) => { stdout = append(stdout, chunk); });
    child.stderr?.on('data', (chunk) => { stderr = append(stderr, chunk); });
    child.once('error', (error) => finish({ code: null, error }));
    child.once('close', (code, signal) => finish({ code, signal }));
    const timer = setTimeout(() => {
      child.kill();
      finish({ code: null, error: new Error(`Timed out after ${timeoutMs}ms`) });
    }, timeoutMs);
    timer.unref();
  });
}

async function runNpm(args, options) {
  const invocation = npmInvocation(args);
  if (invocation.fallback) {
    const bundledExists = await fs.stat(invocation.args[0]).catch(() => undefined);
    if (!bundledExists?.isFile()) {
      return await runInherited(invocation.fallback, args, options);
    }
  }
  return await runInherited(invocation.command, invocation.args, options);
}

async function resolveExecutable(command) {
  if (path.isAbsolute(command) || command.includes(path.sep) || command.includes('/')) {
    const stat = await fs.stat(command).catch(() => undefined);
    return stat?.isFile() ? path.resolve(command) : undefined;
  }
  const pathEntries = String(process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const suffixes = process.platform === 'win32'
    ? String(process.env.PATHEXT ?? '.EXE;.COM;.CMD;.BAT').split(';').map((value) => value.toLowerCase())
    : [''];
  for (const directory of pathEntries) {
    for (const suffix of suffixes) {
      const candidate = path.join(directory, `${command}${suffix}`);
      const stat = await fs.stat(candidate).catch(() => undefined);
      if (stat?.isFile()) return candidate;
    }
  }
  return undefined;
}

async function wildcardDirectories(base, segments) {
  let current = [base];
  for (const segment of segments) {
    const next = [];
    for (const directory of current) {
      if (segment === '*') {
        const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
        next.push(...entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(directory, entry.name)));
      } else {
        const candidate = path.join(directory, segment);
        const stat = await fs.stat(candidate).catch(() => undefined);
        if (stat?.isDirectory()) next.push(candidate);
      }
    }
    current = next;
  }
  return current;
}

async function remoteWrapperCandidates() {
  if (!process.env.VSCODE_IPC_HOOK_CLI && !process.env.PAGETURNOVER_REMOTE_EDITOR_CLI) return [];
  const home = os.homedir();
  const layouts = [
    ['.cursor-server', 'bin', '*', '*', 'bin', 'remote-cli'],
    ['.cursor-server', 'bin', '*', 'bin', 'remote-cli'],
    ['.cursor-server', 'cli', 'servers', '*', 'server', 'bin', 'remote-cli'],
    ['.vscode-server', 'bin', '*', 'bin', 'remote-cli'],
    ['.vscode-server', 'cli', 'servers', '*', 'server', 'bin', 'remote-cli'],
  ];
  const directories = (await Promise.all(layouts.map((layout) => wildcardDirectories(home, layout)))).flat();
  const results = [];
  for (const directory of directories) {
    for (const editor of EDITORS) {
      const candidate = path.join(directory, editor);
      const stat = await fs.stat(candidate).catch(() => undefined);
      if (stat?.isFile()) results.push({ command: candidate, editor, remoteHint: true, source: 'remote workspace server' });
    }
  }
  return results;
}

function desktopAppCandidates() {
  const candidates = [];
  if (process.platform === 'darwin') {
    const volumeRoot = path.parse(os.homedir()).root;
    const applicationRoots = [path.join(volumeRoot, 'Applications'), path.join(os.homedir(), 'Applications')];
    const apps = [
      { editor: 'cursor', bundle: 'Cursor.app', cli: 'cursor' },
      { editor: 'cursor', bundle: 'Cursor.app', cli: 'code' },
      { editor: 'code', bundle: 'Visual Studio Code.app', cli: 'code' },
      { editor: 'codium', bundle: 'VSCodium.app', cli: 'codium' },
    ];
    for (const root of applicationRoots) {
      for (const app of apps) {
        candidates.push({
          command: path.join(root, app.bundle, 'Contents', 'Resources', 'app', 'bin', app.cli),
          editor: app.editor,
          remoteHint: false,
          source: 'desktop application',
        });
      }
    }
  } else if (process.platform === 'win32') {
    const roots = [process.env.LOCALAPPDATA, process.env.ProgramFiles, process.env['ProgramFiles(x86)']].filter(Boolean);
    const apps = [
      { editor: 'cursor', pieces: ['Programs', 'Cursor', 'Cursor.exe'] },
      { editor: 'cursor', pieces: ['Cursor', 'Cursor.exe'] },
      { editor: 'code', pieces: ['Programs', 'Microsoft VS Code', 'Code.exe'] },
      { editor: 'code', pieces: ['Microsoft VS Code', 'Code.exe'] },
      { editor: 'codium', pieces: ['Programs', 'VSCodium', 'VSCodium.exe'] },
      { editor: 'codium', pieces: ['VSCodium', 'VSCodium.exe'] },
    ];
    for (const root of roots) {
      for (const app of apps) {
        candidates.push({ command: path.join(root, ...app.pieces), editor: app.editor, remoteHint: false, source: 'desktop application' });
      }
    }
  }
  return candidates;
}

async function discoverCandidates(options) {
  const raw = [];
  if (process.env.PAGETURNOVER_REMOTE_EDITOR_CLI) {
    raw.push({
      command: process.env.PAGETURNOVER_REMOTE_EDITOR_CLI,
      editor: options.editor ?? editorNameFromCommand(process.env.PAGETURNOVER_REMOTE_EDITOR_CLI),
      remoteHint: true,
      source: 'PAGETURNOVER_REMOTE_EDITOR_CLI',
    });
  }
  if (process.env.PAGETURNOVER_EDITOR_CLI) {
    raw.push({
      command: process.env.PAGETURNOVER_EDITOR_CLI,
      editor: options.editor ?? editorNameFromCommand(process.env.PAGETURNOVER_EDITOR_CLI),
      remoteHint: false,
      source: 'PAGETURNOVER_EDITOR_CLI',
    });
  }
  raw.push(...await remoteWrapperCandidates());
  for (const editor of options.editor ? [options.editor] : EDITORS) {
    const command = await resolveExecutable(editor);
    if (command) raw.push({ command, editor, remoteHint: false, source: 'PATH' });
  }
  raw.push(...desktopAppCandidates());

  const seen = new Set();
  const candidates = [];
  for (const item of raw) {
    if (options.editor && item.editor !== options.editor) continue;
    const command = await resolveExecutable(item.command);
    if (!command) continue;
    const real = await fs.realpath(command).catch(() => path.resolve(command));
    const kind = classifyCliTarget(real, item.remoteHint);
    if (options.remoteOnly && kind !== 'remote') continue;
    const key = `${kind}:${real.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ ...item, command, real, kind });
  }
  return candidates.sort((left, right) => {
    const remotePreference = Number(right.kind === 'remote') - Number(left.kind === 'remote');
    if (remotePreference) return remotePreference;
    return EDITORS.indexOf(left.editor) - EDITORS.indexOf(right.editor);
  });
}

async function packageExtension() {
  const manifest = JSON.parse(await fs.readFile(path.join(extensionRoot, 'package.json'), 'utf8'));
  const filename = `${manifest.name}-${manifest.version}.vsix`;
  const vsixPath = path.join(extensionRoot, filename);
  process.stdout.write('Installing locked extension dependencies...\n');
  await runNpm(['ci'], { cwd: extensionRoot });
  await fs.rm(vsixPath, { force: true });
  process.stdout.write('Checking and packaging the Cursor/VS Code extension...\n');
  await runNpm(['run', 'package', '--', '--out', vsixPath], { cwd: extensionRoot });
  const stat = await fs.stat(vsixPath).catch(() => undefined);
  if (!stat?.isFile() || stat.size === 0) throw new Error('VSIX packaging completed without producing the expected file.');
  return {
    extensionId: `${manifest.publisher}.${manifest.name}`,
    filename,
    version: manifest.version,
    vsixPath,
  };
}

function combinedOutput(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim();
}

function conciseFailure(result) {
  if (result.error) return result.error.message;
  const output = combinedOutput(result).split(/\r?\n/).filter(Boolean).slice(-3).join(' | ');
  return output || `exit ${result.code}`;
}

async function probeCandidate(candidate, run = runCaptured) {
  const help = await run(candidate.command, ['--help'], 15_000);
  if (help.code !== 0 || !hasExtensionManagementHelp(combinedOutput(help))) {
    return { usable: false, reason: conciseFailure(help) || 'extension-management flags are unavailable' };
  }
  const listed = await run(candidate.command, ['--list-extensions', '--show-versions'], 30_000);
  if (listed.code !== 0 || UNUSABLE_REMOTE_MESSAGE.test(combinedOutput(listed))) {
    return { usable: false, reason: conciseFailure(listed) };
  }
  return { usable: true, listed };
}

export async function installOnCandidate(candidate, packaged, run = runCaptured) {
  const probe = await probeCandidate(candidate, run);
  if (!probe.usable) return { status: 'unusable', reason: probe.reason };

  const existingVersion = extensionVersionFromList(probe.listed.stdout, packaged.extensionId);
  if (existingVersion === packaged.version) {
    return { status: 'verified', installed: false, previousVersion: existingVersion };
  }

  const installed = await run(
    candidate.command,
    ['--install-extension', packaged.vsixPath, '--force'],
    120_000,
  );
  if (installed.code !== 0 || UNUSABLE_REMOTE_MESSAGE.test(combinedOutput(installed))) {
    return { status: 'failed', reason: `install failed: ${conciseFailure(installed)}` };
  }
  const verified = await run(candidate.command, ['--list-extensions', '--show-versions'], 30_000);
  const verifiedVersion = verified.code === 0
    ? extensionVersionFromList(verified.stdout, packaged.extensionId)
    : undefined;
  if (verifiedVersion !== packaged.version) {
    return {
      status: 'failed',
      reason: `post-install list reported ${verifiedVersion ?? 'no matching extension'}`,
    };
  }
  return { status: 'verified', installed: true, previousVersion: existingVersion };
}

function manualInstructions(packaged, options, reasons = []) {
  const reasonText = reasons.length ? `\nChecked CLIs:\n${reasons.map((reason) => `  - ${reason}`).join('\n')}` : '';
  const targetText = options.remoteOnly ? 'No usable active remote-workspace CLI was detected.' : 'No usable Cursor, VS Code, or VSCodium CLI was detected.';
  return [
    '',
    targetText,
    `Packaged VSIX: ${packaged.vsixPath}`,
    'Local install: open Extensions, choose “Install from VSIX…”, and select that file.',
    'Remote-SSH install: connect to the target first, run “Install from VSIX…” in that remote window, then confirm the extension under “Developer: Show Running Extensions”.',
    'You can also rerun this script inside the connected editor terminal, where a real remote-workspace CLI is available.',
    reasonText,
  ].filter(Boolean).join('\n');
}

async function install(options) {
  const packaged = await packageExtension();
  const candidates = await discoverCandidates(options);
  const unavailable = [];
  const failures = [];
  let usableCount = 0;

  for (const candidate of candidates) {
    const target = candidate.kind === 'remote' ? 'active remote workspace' : 'local editor profile';
    const label = `${candidate.editor} (${target}; ${candidate.source})`;
    const result = await installOnCandidate(candidate, packaged);
    if (result.status === 'unusable') {
      unavailable.push(`${label}: ${result.reason}`);
      continue;
    }
    usableCount += 1;
    if (result.status === 'failed') {
      failures.push(`${label}: ${result.reason}`);
      continue;
    }
    if (result.installed) {
      process.stdout.write(
        `Installed ${packaged.extensionId}@${packaged.version}${result.previousVersion ? ` over ${result.previousVersion}` : ''} via ${label}.\n`,
      );
    } else {
      process.stdout.write(`Verified ${packaged.extensionId}@${packaged.version} is already installed via ${label}.\n`);
    }
    process.stdout.write(`VSIX: ${packaged.vsixPath}\n`);
    return 0;
  }

  if (usableCount === 0) {
    process.stdout.write(`${manualInstructions(packaged, options, unavailable)}\n`);
    return unavailableExitCode(options.ifAvailable);
  }
  throw new Error(`A usable editor CLI was found, but installation could not be verified:\n${failures.map((failure) => `- ${failure}`).join('\n')}`);
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  return await install(options);
}

const invokedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : '';
if (invokedPath === import.meta.url) {
  main().then((code) => {
    process.exitCode = code;
  }).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}

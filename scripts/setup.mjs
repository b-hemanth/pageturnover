#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { WorkspaceStore } from '../server/lib/store.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const flags = new Set(process.argv.slice(2));
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || root,
      env: { ...process.env, ...(options.env || {}) },
      stdio: 'inherit',
      shell: false,
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(' ')} failed${signal ? ` (${signal})` : ` with exit ${code}`}.`));
    });
  });
}

function configFile() {
  const explicit = process.env.PAGETURNOVER_CONFIG_DIR;
  const base = explicit
    || process.env.XDG_CONFIG_HOME
    || (process.platform === 'win32' ? process.env.APPDATA : '')
    || path.join(os.homedir(), '.config');
  return path.join(base, 'pageturnover', 'config.json');
}

async function commandAvailable(command) {
  const pathEntries = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const suffixes = process.platform === 'win32' ? ['', '.cmd', '.exe', '.bat'] : [''];
  for (const directory of pathEntries) {
    for (const suffix of suffixes) {
      const stat = await fs.stat(path.join(directory, `${command}${suffix}`)).catch(() => null);
      if (stat?.isFile()) return true;
    }
  }
  return false;
}

async function initializeWorkspace() {
  const store = new WorkspaceStore({
    workspacesDir: path.join(root, 'workspaces'),
    templatesDir: path.join(root, 'templates'),
  });
  await store.init();
  const projects = await store.listProjects();
  if (projects.length) return { created: false, project: projects[0] };
  const project = await store.createProject({ name: 'Welcome Paper', templateId: 'arxiv-alpoge' });
  return { created: true, project };
}

async function writeConfig() {
  const destination = configFile();
  await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  const content = `${JSON.stringify({
    schemaVersion: 1,
    repo: root,
    port: 3006,
    url: 'http://127.0.0.1:3006',
    tokenFile: path.join(root, '.runtime', 'access-token'),
    updatedAt: new Date().toISOString(),
  }, null, 2)}\n`;
  const temporary = `${destination}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, destination);
  await fs.chmod(destination, 0o600).catch(() => {});
  return destination;
}

async function reportTools() {
  const names = ['git', 'latexmk', 'xelatex', 'pdflatex', 'bibtex', 'chktex', 'synctex', 'pdfinfo', 'tar'];
  const availability = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await commandAvailable(name)])));
  const missingCore = ['latexmk', 'xelatex', 'pdfinfo', 'tar'].filter((name) => !availability[name]);
  process.stdout.write(`TeX tools: ${names.map((name) => `${name}=${availability[name] ? 'yes' : 'no'}`).join(', ')}\n`);
  if (missingCore.length) {
    process.stdout.write(`Warning: install a TeX Live/MacTeX distribution before compiling (${missingCore.join(', ')} missing).\n`);
  }
  return availability;
}

async function main() {
  if (!Number.isInteger(nodeMajor) || nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 13)) {
    throw new Error(`Node.js 22.13 or newer is required; found ${process.versions.node}.`);
  }

  if (flags.has('--check')) {
    const workspace = await fs.stat(path.join(root, 'workspaces')).catch(() => null);
    const bundle = await fs.stat(path.join(root, 'dist', 'index.html')).catch(() => null);
    process.stdout.write(`Repository: ${root}\nWorkspace directory: ${workspace?.isDirectory() ? 'ready' : 'missing'}\nProduction bundle: ${bundle?.isFile() ? 'ready' : 'missing'}\n`);
    await reportTools();
    return;
  }

  if (!flags.has('--no-deps')) {
    process.stdout.write('Installing locked application dependencies...\n');
    await run(npmCommand, ['ci']);
  }
  if (!flags.has('--no-build')) {
    process.stdout.write('Building the production editor...\n');
    await run(npmCommand, ['run', 'build']);
  }

  const initialized = flags.has('--no-starter')
    ? { created: false, project: null }
    : await initializeWorkspace();
  const configuredAt = flags.has('--no-config') ? null : await writeConfig();

  if (!flags.has('--no-cursor')) {
    const installerArgs = [path.join(root, 'scripts', 'install-cursor-extension.mjs'), '--if-available'];
    await run(process.execPath, installerArgs);
  }

  process.stdout.write('\nPageTurnover is ready.\n');
  if (initialized.project) {
    process.stdout.write(`${initialized.created ? 'Created' : 'Using'} workspace: workspaces/${initialized.project.id}\n`);
  }
  if (configuredAt) process.stdout.write(`Codex discovery config: ${configuredAt}\n`);
  await reportTools();
  process.stdout.write('Start it with: npm run serve\n');
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
  process.exitCode = 1;
});

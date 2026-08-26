import { spawn, execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import * as vscode from 'vscode';

import {
  isProjectId,
  normalizePort,
  normalizeProjectRootFile,
  pdfFilename,
  projectContextForPath,
  safeArchiveFilename,
  type ProjectContext,
} from './core';

const execFileAsync = promisify(execFile);
const SERVER_METADATA = 'vscode-server.json';
const TOKEN_PATTERN = /^[a-f0-9]{32,128}$/i;

interface Repository {
  rootPath: string;
  rootUri: vscode.Uri;
}

interface ServiceProbe {
  state: 'running' | 'stopped' | 'unauthorized';
  version?: string;
}

interface ServerMetadata {
  pid: number;
  port: number;
  rootPath: string;
  startedAt: string;
}

interface ApiDiagnostic {
  file?: string;
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  severity?: 'error' | 'warning' | 'info';
  code?: string | number;
  message?: string;
  source?: string;
}

interface ProjectRecord {
  id: string;
  rootFile: string;
}

interface DiskProject {
  id: string;
  name: string;
  rootFile: string;
  projectRoot: string;
}

interface CompileResult {
  success: boolean;
  diagnostics?: ApiDiagnostic[];
  log?: string;
  durationMs?: number;
  pages?: number;
  lastGoodPdf?: boolean;
}

let extensionContext: vscode.ExtensionContext;
let cachedRepository: Repository | undefined;
let statusItem: vscode.StatusBarItem;
let diagnosticCollection: vscode.DiagnosticCollection;
let output: vscode.OutputChannel;
let statusTimer: NodeJS.Timeout | undefined;
const suppressedSaveActions = new Set<string>();

function configuration() {
  return vscode.workspace.getConfiguration('hbcTex');
}

function configuredPort(): number {
  return normalizePort(configuration().get<number>('serverPort'), 3006);
}

function baseUrl(): string {
  return `http://127.0.0.1:${configuredPort()}`;
}

function isInside(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function uriForPath(filePath: string): vscode.Uri {
  const absolute = path.resolve(filePath);
  const folders = [...(vscode.workspace.workspaceFolders ?? [])]
    .sort((left, right) => right.uri.fsPath.length - left.uri.fsPath.length);
  for (const folder of folders) {
    if (!isInside(folder.uri.fsPath, absolute)) continue;
    const pieces = path.relative(folder.uri.fsPath, absolute).split(path.sep).filter(Boolean);
    return vscode.Uri.joinPath(folder.uri, ...pieces);
  }
  const remoteFolder = folders.find((folder) => folder.uri.scheme !== 'file');
  if (remoteFolder) {
    return vscode.Uri.from({
      scheme: remoteFolder.uri.scheme,
      authority: remoteFolder.uri.authority,
      path: absolute.replaceAll(path.sep, '/'),
    });
  }
  return vscode.Uri.file(absolute);
}

async function hasRepositoryLayout(candidate: string): Promise<boolean> {
  const required = [
    path.join(candidate, 'package.json'),
    path.join(candidate, 'server', 'index.mjs'),
    path.join(candidate, 'scripts', 'serve-production.mjs'),
    path.join(candidate, 'workspaces'),
  ];
  return (await Promise.all(required.map(async (entry) => {
    try {
      await fsp.access(entry);
      return true;
    } catch {
      return false;
    }
  }))).every(Boolean);
}

function expandHome(input: string): string {
  if (input === '~') return os.homedir();
  if (input.startsWith(`~${path.sep}`) || input.startsWith('~/')) {
    return path.join(os.homedir(), input.slice(2));
  }
  return input;
}

async function discoverRepository(force = false): Promise<Repository> {
  if (cachedRepository && !force) return cachedRepository;
  const configured = configuration().get<string>('repoRoot')?.trim();
  if (configured) {
    const expanded = expandHome(configured);
    const base = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const rootPath = path.resolve(base, expanded);
    if (!(await hasRepositoryLayout(rootPath))) {
      throw new Error(`Configured repository is not a TeX desk root: ${rootPath}`);
    }
    cachedRepository = { rootPath, rootUri: uriForPath(rootPath) };
    return cachedRepository;
  }

  const candidates = new Set<string>();
  const activePath = vscode.window.activeTextEditor?.document.uri.fsPath;
  if (activePath) {
    let cursor = path.dirname(activePath);
    for (let depth = 0; depth < 10; depth += 1) {
      candidates.add(cursor);
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    candidates.add(folder.uri.fsPath);
  }
  for (const candidate of candidates) {
    if (await hasRepositoryLayout(candidate)) {
      cachedRepository = { rootPath: path.resolve(candidate), rootUri: uriForPath(candidate) };
      return cachedRepository;
    }
  }

  const serverEntries = await vscode.workspace.findFiles(
    '**/server/index.mjs',
    '**/{node_modules,dist,.git}/**',
    20,
  );
  for (const entry of serverEntries) {
    const candidate = path.dirname(path.dirname(entry.fsPath));
    if (await hasRepositoryLayout(candidate)) {
      cachedRepository = { rootPath: path.resolve(candidate), rootUri: uriForPath(candidate) };
      return cachedRepository;
    }
  }
  throw new Error('Could not find the TeX desk beneath the open workspace. Use “HBC TeX: Select Repository Root”.');
}

function runtimePath(repository: Repository, name: string): string {
  return path.join(repository.rootPath, '.runtime', name);
}

async function ensureAccessToken(repository: Repository): Promise<string> {
  const runtime = path.join(repository.rootPath, '.runtime');
  await fsp.mkdir(runtime, { recursive: true, mode: 0o700 });
  const tokenPath = runtimePath(repository, 'access-token');
  let token: string;
  try {
    token = (await fsp.readFile(tokenPath, 'utf8')).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    token = randomBytes(24).toString('hex');
    try {
      await fsp.writeFile(tokenPath, `${token}\n`, { flag: 'wx', mode: 0o600 });
    } catch (writeError) {
      if ((writeError as NodeJS.ErrnoException).code !== 'EEXIST') throw writeError;
      token = (await fsp.readFile(tokenPath, 'utf8')).trim();
    }
  }
  if (!TOKEN_PATTERN.test(token)) {
    throw new Error('The bootstrap token file is malformed. Refusing to expose it or replace it automatically.');
  }
  await fsp.chmod(tokenPath, 0o600).catch(() => undefined);
  return token;
}

async function responseError(response: Response): Promise<Error> {
  let message = `Request failed (${response.status})`;
  try {
    const body = await response.json() as { error?: { message?: string } | string };
    if (typeof body.error === 'string') message = body.error;
    else if (body.error?.message) message = body.error.message;
  } catch {
    // The status is still useful when the response is not JSON.
  }
  return new Error(message);
}

async function request(repository: Repository, route: string, init: RequestInit = {}): Promise<Response> {
  const token = await ensureAccessToken(repository);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 50_000);
  try {
    const response = await fetch(`${baseUrl()}${route}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
    if (!response.ok) throw await responseError(response);
    return response;
  } finally {
    clearTimeout(timer);
  }
}

async function requestJson<T>(repository: Repository, route: string, init: RequestInit = {}): Promise<T> {
  return await (await request(repository, route, init)).json() as T;
}

async function probe(repository: Repository): Promise<ServiceProbe> {
  const token = await ensureAccessToken(repository);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1_500);
  try {
    const response = await fetch(`${baseUrl()}/api/health`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    if (response.status === 401) return { state: 'unauthorized' };
    if (!response.ok) return { state: 'stopped' };
    const body = await response.json() as { ok?: boolean; version?: string };
    return body.ok ? { state: 'running', version: body.version } : { state: 'stopped' };
  } catch {
    return { state: 'stopped' };
  } finally {
    clearTimeout(timer);
  }
}

function updateStatusBar(probeResult?: ServiceProbe): void {
  if (!configuration().get<boolean>('showStatusBar', true)) {
    statusItem.hide();
    return;
  }
  const port = configuredPort();
  if (!probeResult) {
    statusItem.text = '$(file-code) TeX';
    statusItem.tooltip = 'TeX desk repository not found';
  } else if (probeResult.state === 'running') {
    statusItem.text = `$(check) TeX :${port}`;
    statusItem.tooltip = `Local TeX editor is running on the extension host at loopback port ${port}`;
  } else if (probeResult.state === 'unauthorized') {
    statusItem.text = `$(warning) TeX :${port}`;
    statusItem.tooltip = 'A server is running, but its access token does not match this repository';
  } else {
    statusItem.text = '$(circle-slash) TeX';
    statusItem.tooltip = `Local TeX editor is stopped (configured port ${port})`;
  }
  statusItem.show();
}

async function refreshStatus(): Promise<ServiceProbe | undefined> {
  try {
    const repository = await discoverRepository();
    const result = await probe(repository);
    updateStatusBar(result);
    return result;
  } catch {
    updateStatusBar();
    return undefined;
  }
}

async function tail(filePath: string, maximum = 4_000): Promise<string> {
  try {
    const content = await fsp.readFile(filePath, 'utf8');
    return content.slice(-maximum);
  } catch {
    return '';
  }
}

async function waitForProbe(repository: Repository, desired: ServiceProbe['state'], timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await probe(repository)).state === desired) return true;
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  return false;
}

async function startServer(silent = false): Promise<Repository> {
  const repository = await discoverRepository();
  const existing = await probe(repository);
  if (existing.state === 'running') {
    updateStatusBar(existing);
    if (!silent) void vscode.window.showInformationMessage(`TeX editor is already running on port ${configuredPort()}.`);
    return repository;
  }
  if (existing.state === 'unauthorized') {
    throw new Error(`Port ${configuredPort()} has a protected server with a different token. Choose another hbcTex.serverPort or stop that server.`);
  }
  const distIndex = path.join(repository.rootPath, 'dist', 'index.html');
  try {
    await fsp.access(distIndex);
  } catch {
    throw new Error(`Production bundle is missing at ${distIndex}. Run “npm run build” in the repository first.`);
  }

  await ensureAccessToken(repository);
  const logPath = runtimePath(repository, 'vscode-server.log');
  const logDescriptor = fs.openSync(logPath, 'a', 0o600);
  const serverEntry = path.join(repository.rootPath, 'scripts', 'serve-production.mjs');
  output.appendLine(`[server] starting loopback:${configuredPort()} from ${repository.rootPath}`);
  const child = spawn(process.execPath, [serverEntry], {
    cwd: repository.rootPath,
    detached: true,
    // The launcher writes the one-time bootstrap URL to stdout. Never persist it.
    stdio: ['ignore', 'ignore', logDescriptor],
    env: {
      ...process.env,
      PAGETURNOVER_SUPPRESS_ACCESS_URL: '1',
      TEX_DESK_HOST: '127.0.0.1',
      TEX_DESK_PORT: String(configuredPort()),
    },
  });
  let spawnError = '';
  child.once('error', (error) => {
    spawnError = error.message;
    output.appendLine(`[server] ${error.message}`);
  });
  child.unref();
  fs.closeSync(logDescriptor);
  const metadata: ServerMetadata = {
    pid: child.pid ?? 0,
    port: configuredPort(),
    rootPath: repository.rootPath,
    startedAt: new Date().toISOString(),
  };
  await fsp.writeFile(runtimePath(repository, SERVER_METADATA), `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });

  if (!(await waitForProbe(repository, 'running', 12_000))) {
    const log = await tail(logPath);
    output.appendLine(log || '[server] no startup log was produced');
    output.show(true);
    throw new Error(spawnError || `The local TeX editor did not start on port ${configuredPort()}. See the HBC TeX output channel.`);
  }
  updateStatusBar({ state: 'running' });
  if (!silent) void vscode.window.showInformationMessage(`TeX editor started on the extension host at port ${configuredPort()}.`);
  return repository;
}

async function readServerMetadata(repository: Repository): Promise<ServerMetadata | undefined> {
  try {
    const value = JSON.parse(await fsp.readFile(runtimePath(repository, SERVER_METADATA), 'utf8')) as Partial<ServerMetadata>;
    if (!Number.isInteger(value.pid) || !value.pid || value.rootPath !== repository.rootPath) return undefined;
    return value as ServerMetadata;
  } catch {
    return undefined;
  }
}

async function commandForPid(pid: number): Promise<string> {
  if (process.platform === 'win32') return '';
  try {
    const result = await execFileAsync('ps', ['-p', String(pid), '-o', 'command=']);
    return result.stdout.trim();
  } catch {
    return '';
  }
}

async function stopServer(): Promise<void> {
  const repository = await discoverRepository();
  const metadata = await readServerMetadata(repository);
  const result = await probe(repository);
  if (result.state === 'stopped') {
    await fsp.rm(runtimePath(repository, SERVER_METADATA), { force: true });
    updateStatusBar(result);
    void vscode.window.showInformationMessage('TeX editor is already stopped.');
    return;
  }
  if (!metadata) {
    throw new Error('The running server was not started by this extension, so it was left untouched. Stop it from its original terminal or tmux session.');
  }
  if (metadata.port !== configuredPort()) {
    throw new Error('The saved server process belongs to a different configured port and was left untouched.');
  }
  const command = await commandForPid(metadata.pid);
  const expectedEntry = path.join(repository.rootPath, 'scripts', 'serve-production.mjs');
  if (process.platform !== 'win32' && !command.includes(expectedEntry)) {
    throw new Error('The recorded process no longer matches this repository server and was left untouched.');
  }
  try {
    process.kill(metadata.pid, 'SIGTERM');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
  await waitForProbe(repository, 'stopped', 6_000);
  await fsp.rm(runtimePath(repository, SERVER_METADATA), { force: true });
  const after = await probe(repository);
  updateStatusBar(after);
  if (after.state === 'stopped') void vscode.window.showInformationMessage('TeX editor stopped.');
  else throw new Error('The server did not stop after SIGTERM; it was not force-killed.');
}

async function ensureRunning(): Promise<Repository> {
  const repository = await discoverRepository();
  const current = await probe(repository);
  if (current.state === 'running') return repository;
  return await startServer(true);
}

async function openDesk(): Promise<void> {
  const repository = await ensureRunning();
  const token = await ensureAccessToken(repository);
  const internal = vscode.Uri.parse(`${baseUrl()}/`).with({ query: `access=${encodeURIComponent(token)}` });
  const external = await vscode.env.asExternalUri(internal);
  await vscode.env.openExternal(external);
}

function selectedUri(value?: unknown): vscode.Uri | undefined {
  if (value instanceof vscode.Uri) return value;
  return vscode.window.activeTextEditor?.document.uri;
}

async function listDiskProjects(repository: Repository): Promise<DiskProject[]> {
  const workspacesRoot = path.join(repository.rootPath, 'workspaces');
  const entries = await fsp.readdir(workspacesRoot, { withFileTypes: true });
  const projects: DiskProject[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isProjectId(entry.name)) continue;
    const projectRoot = path.join(workspacesRoot, entry.name);
    let metadata: { name?: unknown; rootFile?: unknown } = {};
    try {
      metadata = JSON.parse(
        await fsp.readFile(path.join(projectRoot, '.jhana-project.json'), 'utf8'),
      ) as { name?: unknown; rootFile?: unknown };
    } catch {
      // A plain folder containing main.tex remains a valid disk-backed project.
    }
    const rootFile = normalizeProjectRootFile(metadata.rootFile);
    const rootPath = path.resolve(projectRoot, ...rootFile.split('/'));
    const stat = isInside(projectRoot, rootPath)
      ? await fsp.stat(rootPath).catch(() => undefined)
      : undefined;
    if (!stat?.isFile()) continue;
    const name = typeof metadata.name === 'string' && metadata.name.trim()
      ? metadata.name.trim()
      : entry.name;
    projects.push({ id: entry.name, name, rootFile, projectRoot });
  }
  return projects.sort((left, right) => left.name.localeCompare(right.name));
}

class ProjectSelectionCancelled extends Error {}

async function chooseProject(repository: Repository, forcePrompt = false): Promise<DiskProject> {
  const projects = await listDiskProjects(repository);
  if (!projects.length) {
    throw new Error('No paper workspaces were found. Run “npm run setup” or create a project in the browser desk.');
  }
  const configuredId = configuration().get<string>('defaultProjectId', 'welcome-paper');
  const configuredProject = projects.find((project) => project.id === configuredId);
  if (configuredProject && !forcePrompt) return configuredProject;

  const choices = projects.map((project) => ({
    label: project.name,
    description: project.id,
    detail: project.rootFile,
    project,
  }));
  const selected = await vscode.window.showQuickPick(choices, {
    placeHolder: configuredProject
      ? 'Select the default paper workspace'
      : `Configured project “${configuredId}” is unavailable. Select a paper workspace`,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  if (!selected) throw new ProjectSelectionCancelled();
  await configuration().update('defaultProjectId', selected.project.id, vscode.ConfigurationTarget.Workspace);
  return selected.project;
}

async function projectForUri(repository: Repository, value?: unknown): Promise<ProjectContext> {
  const uri = selectedUri(value);
  if (uri) {
    const project = projectContextForPath(repository.rootPath, uri.fsPath);
    if (project) return project;
  }
  const project = await chooseProject(repository);
  return { id: project.id, relativeFile: project.rootFile, projectRoot: project.projectRoot };
}

async function projectRecord(repository: Repository, projectId: string): Promise<ProjectRecord> {
  const body = await requestJson<{ project: ProjectRecord }>(repository, `/api/projects/${encodeURIComponent(projectId)}`);
  return body.project;
}

function diagnosticSeverity(value?: ApiDiagnostic['severity']): vscode.DiagnosticSeverity {
  if (value === 'warning') return vscode.DiagnosticSeverity.Warning;
  if (value === 'info') return vscode.DiagnosticSeverity.Information;
  return vscode.DiagnosticSeverity.Error;
}

function safeDiagnosticUri(project: ProjectContext, fileName?: string): vscode.Uri {
  const candidate = path.resolve(project.projectRoot, fileName || project.relativeFile);
  return uriForPath(isInside(project.projectRoot, candidate) ? candidate : path.join(project.projectRoot, project.relativeFile));
}

function applyDiagnostics(project: ProjectContext, diagnostics: ApiDiagnostic[], clear = false): void {
  if (clear) diagnosticCollection.clear();
  const grouped = new Map<string, { uri: vscode.Uri; values: vscode.Diagnostic[] }>();
  for (const item of diagnostics) {
    const uri = safeDiagnosticUri(project, item.file);
    const key = uri.toString();
    const line = Math.max(0, Number(item.line || 1) - 1);
    const column = Math.max(0, Number(item.column || 1) - 1);
    const endLine = Math.max(line, Number(item.endLine || item.line || 1) - 1);
    const endColumn = Math.max(column + 1, Number(item.endColumn || item.column || 1));
    const diagnostic = new vscode.Diagnostic(
      new vscode.Range(line, column, endLine, endColumn),
      item.message || 'TeX diagnostic',
      diagnosticSeverity(item.severity),
    );
    diagnostic.source = item.source || 'HBC TeX';
    if (item.code !== undefined) diagnostic.code = item.code;
    const group = grouped.get(key) ?? { uri, values: [] };
    group.values.push(diagnostic);
    grouped.set(key, group);
  }
  for (const group of grouped.values()) diagnosticCollection.set(group.uri, group.values);
  if (diagnostics.length === 0) diagnosticCollection.set(safeDiagnosticUri(project), []);
}

async function lintFile(value?: unknown, quiet = false): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const uri = selectedUri(value);
  if (!uri || path.extname(uri.fsPath).toLowerCase() !== '.tex') {
    if (!quiet) void vscode.window.showWarningMessage('Open a .tex file inside a paper workspace first.');
    return;
  }
  const repository = await ensureRunning();
  const project = await projectForUri(repository, uri);
  const content = editor?.document.uri.toString() === uri.toString()
    ? editor.document.getText()
    : await fsp.readFile(uri.fsPath, 'utf8');
  const body = await requestJson<{ diagnostics: ApiDiagnostic[] }>(
    repository,
    `/api/projects/${encodeURIComponent(project.id)}/lint`,
    { method: 'POST', body: JSON.stringify({ path: project.relativeFile, content }) },
  );
  applyDiagnostics(project, body.diagnostics ?? []);
  if (!quiet) {
    const errors = (body.diagnostics ?? []).filter((item) => item.severity === 'error').length;
    const warnings = (body.diagnostics ?? []).filter((item) => item.severity === 'warning').length;
    void vscode.window.showInformationMessage(`TeX lint: ${errors} error${errors === 1 ? '' : 's'}, ${warnings} warning${warnings === 1 ? '' : 's'}.`);
  }
}

async function compileProject(value?: unknown, quiet = false): Promise<{ repository: Repository; project: ProjectContext; result: CompileResult }> {
  const repository = await ensureRunning();
  const project = await projectForUri(repository, value);
  const editor = vscode.window.activeTextEditor;
  if (editor && projectContextForPath(repository.rootPath, editor.document.uri.fsPath)?.id === project.id) {
    const documentKey = editor.document.uri.toString();
    suppressedSaveActions.add(documentKey);
    try {
      await editor.document.save();
    } finally {
      setTimeout(() => suppressedSaveActions.delete(documentKey), 250);
    }
  }
  const record = await projectRecord(repository, project.id);
  const result = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Compiling ${project.id}`, cancellable: false },
    async () => await requestJson<CompileResult>(
      repository,
      `/api/projects/${encodeURIComponent(project.id)}/compile`,
      { method: 'POST', body: JSON.stringify({ rootFile: record.rootFile }) },
    ),
  );
  applyDiagnostics(project, result.diagnostics ?? [], true);
  if (result.log) output.appendLine(`\n[compile ${project.id}]\n${result.log}`);
  if (!quiet) {
    if (result.success) {
      const pageText = result.pages ? `, ${result.pages} page${result.pages === 1 ? '' : 's'}` : '';
      const timing = result.durationMs ? ` in ${(result.durationMs / 1000).toFixed(1)}s` : '';
      void vscode.window.showInformationMessage(`Compiled ${project.id}${pageText}${timing}.`);
    } else {
      output.show(true);
      void vscode.window.showErrorMessage(`TeX compile failed for ${project.id}. Problems and compiler output were updated.`);
    }
  }
  return { repository, project, result };
}

async function openPdfProof(value?: unknown): Promise<void> {
  const compiled = await compileProject(value, true);
  const record = await projectRecord(compiled.repository, compiled.project.id);
  const pdfPath = path.join(compiled.project.projectRoot, '.jhana-build', pdfFilename(record.rootFile));
  try {
    await fsp.access(pdfPath);
  } catch {
    output.show(true);
    throw new Error('No PDF proof exists. Fix the compile errors and try again.');
  }
  if (!compiled.result.success && !compiled.result.lastGoodPdf) {
    throw new Error('Compilation failed and there is no last good PDF proof.');
  }
  if (!compiled.result.success) {
    void vscode.window.showWarningMessage('Compilation failed; opening the last good PDF proof.');
  }
  await vscode.commands.executeCommand('vscode.open', uriForPath(pdfPath), { preview: false });
}

async function openProject(forcePrompt = false): Promise<void> {
  const repository = await discoverRepository();
  const project = await chooseProject(repository, forcePrompt);
  const filePath = path.resolve(project.projectRoot, ...project.rootFile.split('/'));
  const document = await vscode.workspace.openTextDocument(uriForPath(filePath));
  await vscode.window.showTextDocument(document, { preview: false });
}

async function exportArxiv(value?: unknown): Promise<void> {
  const repository = await ensureRunning();
  const project = await projectForUri(repository, value);
  const archive = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Preparing arXiv source for ${project.id}`, cancellable: false },
    async () => {
      const response = await request(repository, `/api/projects/${encodeURIComponent(project.id)}/export/arxiv`);
      return {
        filename: safeArchiveFilename(response.headers.get('content-disposition'), project.id),
        bytes: new Uint8Array(await response.arrayBuffer()),
      };
    },
  );
  const exportDirectory = path.join(repository.rootPath, '.runtime', 'exports');
  await fsp.mkdir(exportDirectory, { recursive: true, mode: 0o700 });
  const target = await vscode.window.showSaveDialog({
    defaultUri: uriForPath(path.join(exportDirectory, archive.filename)),
    saveLabel: 'Save arXiv source',
    filters: { 'arXiv source archive': ['gz'] },
  });
  if (!target) return;
  await vscode.workspace.fs.writeFile(target, archive.bytes);
  void vscode.window.showInformationMessage(`Saved arXiv source: ${target.fsPath || target.toString()}`);
}

async function showServerStatus(): Promise<void> {
  const repository = await discoverRepository();
  const result = await probe(repository);
  updateStatusBar(result);
  const location = vscode.env.remoteName ? `remote ${vscode.env.remoteName} host` : 'local extension host';
  if (result.state === 'running') {
    void vscode.window.showInformationMessage(`TeX editor is running on the ${location}, loopback port ${configuredPort()}.`);
  } else if (result.state === 'unauthorized') {
    void vscode.window.showWarningMessage(`Port ${configuredPort()} has a server with a different access token.`);
  } else {
    void vscode.window.showInformationMessage(`TeX editor is stopped on the ${location}.`);
  }
}

async function selectRepositoryRoot(): Promise<void> {
  const selected = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri,
    openLabel: 'Use TeX desk repository',
  });
  if (!selected?.[0]) return;
  if (!(await hasRepositoryLayout(selected[0].fsPath))) {
    throw new Error('That folder does not contain the TeX desk server, scripts, and workspaces.');
  }
  await configuration().update('repoRoot', selected[0].fsPath, vscode.ConfigurationTarget.Workspace);
  cachedRepository = undefined;
  await refreshStatus();
}

async function actionMenu(): Promise<void> {
  const current = await refreshStatus();
  const options: Array<vscode.QuickPickItem & { command: string }> = [
    { label: '$(open-preview) Open browser desk', description: 'Starts and forwards the protected editor', command: 'hbcTex.openDesk' },
    { label: '$(file-code) Open project', description: 'Open the configured paper or select one if it is unavailable', command: 'hbcTex.openProject' },
    { label: '$(list-selection) Select default project', description: 'Choose which paper is used when no TeX file is active', command: 'hbcTex.selectProject' },
    { label: '$(run) Compile current paper', description: 'XeLaTeX, diagnostics, and SyncTeX', command: 'hbcTex.compileProject' },
    { label: '$(preview) Open PDF proof', description: 'Compile and open the generated PDF in the editor', command: 'hbcTex.openPdfProof' },
    { label: '$(checklist) Lint current TeX file', description: 'Structural parser and ChkTeX', command: 'hbcTex.lintFile' },
    { label: '$(package) Export arXiv source', description: 'Create and save a submission archive', command: 'hbcTex.exportArxiv' },
    current?.state === 'running'
      ? { label: '$(debug-stop) Stop local server', description: 'Only stops a server started by this extension', command: 'hbcTex.stopServer' }
      : { label: '$(server-process) Start local server', description: `Loopback port ${configuredPort()}`, command: 'hbcTex.startServer' },
    { label: '$(settings-gear) Select repository root', command: 'hbcTex.selectRepoRoot' },
  ];
  const selection = await vscode.window.showQuickPick(options, { placeHolder: 'TeX actions' });
  if (selection) await vscode.commands.executeCommand(selection.command);
}

function register(command: string, handler: (...args: unknown[]) => Promise<unknown>): void {
  extensionContext.subscriptions.push(vscode.commands.registerCommand(command, async (...args: unknown[]) => {
    try {
      return await handler(...args);
    } catch (error) {
      if (error instanceof ProjectSelectionCancelled) return undefined;
      const message = error instanceof Error ? error.message : String(error);
      output.appendLine(`[${command}] ${message}`);
      void vscode.window.showErrorMessage(message);
      return undefined;
    }
  }));
}

export function activate(context: vscode.ExtensionContext): void {
  extensionContext = context;
  output = vscode.window.createOutputChannel('HBC TeX', { log: true });
  diagnosticCollection = vscode.languages.createDiagnosticCollection('hbc-tex');
  statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 25);
  statusItem.command = 'hbcTex.actions';
  statusItem.name = 'HBC TeX';
  context.subscriptions.push(output, diagnosticCollection, statusItem);

  register('hbcTex.actions', actionMenu);
  register('hbcTex.openDesk', openDesk);
  register('hbcTex.openProject', async () => await openProject());
  register('hbcTex.selectProject', async () => await openProject(true));
  register('hbcTex.compileProject', async (value) => await compileProject(value));
  register('hbcTex.lintFile', async (value) => await lintFile(value));
  register('hbcTex.openPdfProof', openPdfProof);
  register('hbcTex.exportArxiv', exportArxiv);
  register('hbcTex.startServer', async () => await startServer());
  register('hbcTex.stopServer', stopServer);
  register('hbcTex.serverStatus', showServerStatus);
  register('hbcTex.selectRepoRoot', selectRepositoryRoot);

  context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(async (document) => {
    if (path.extname(document.uri.fsPath).toLowerCase() !== '.tex') return;
    if (suppressedSaveActions.has(document.uri.toString())) return;
    try {
      const repository = await discoverRepository();
      if (!projectContextForPath(repository.rootPath, document.uri.fsPath)) return;
      if ((await probe(repository)).state !== 'running') return;
      if (configuration().get<boolean>('lintOnSave', true)) await lintFile(document.uri, true);
      if (configuration().get<boolean>('compileOnSave', false)) await compileProject(document.uri, true);
    } catch (error) {
      output.appendLine(`[save] ${error instanceof Error ? error.message : String(error)}`);
    }
  }));

  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(async (event) => {
    if (!event.affectsConfiguration('hbcTex')) return;
    cachedRepository = undefined;
    await refreshStatus();
  }));

  void refreshStatus();
  statusTimer = setInterval(() => void refreshStatus(), 15_000);
  statusTimer.unref();
  context.subscriptions.push({ dispose: () => statusTimer && clearInterval(statusTimer) });
}

export function deactivate(): void {
  if (statusTimer) clearInterval(statusTimer);
}

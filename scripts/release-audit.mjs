#!/usr/bin/env node
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { stdout } = await execFileAsync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  { cwd: root, encoding: 'buffer' },
);
const files = stdout.toString('utf8').split('\0').filter(Boolean);
const failures = [];

if (!files.length) failures.push('repository contains no releasable files');

const forbiddenPaths = [
  [/^workspaces\/(?!\.gitkeep$)/, 'personal workspace'],
  [/^\.runtime\//, 'runtime secret/state'],
  [/(^|\/)node_modules\//, 'dependencies'],
  [/(^|\/)dist\//, 'generated build'],
  [/\.vsix$/i, 'generated VSIX'],
  [/^tmp\//, 'temporary output'],
];
const forbiddenContent = [
  [/\/Users\/hbc\//, 'absolute personal path'],
  [new RegExp(['Verifiers for Hard-to', '-Verify Domains'].join(''), 'i'), 'private paper title'],
  [new RegExp(['736291a4e8800ad921856405b3516d174', '1785c83564b729989d1d5ac2be1cb35'].join(''), 'i'), 'private paper fingerprint'],
  [/-----BEGIN (?:OPENSSH |RSA |EC |DSA )?PRIVATE KEY-----/, 'private key'],
  [/sk-[A-Za-z0-9_-]{16,}/, 'OpenAI-style secret'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/, 'GitHub token'],
  [/AIza[0-9A-Za-z_-]{20,}/, 'Google API key'],
  [/AKIA[0-9A-Z]{16}/, 'AWS access-key id'],
];

for (const file of files) {
  for (const [pattern, label] of forbiddenPaths) {
    if (pattern.test(file)) failures.push(`${file}: tracked ${label}`);
  }
  const absolute = path.join(root, file);
  const stat = await fs.lstat(absolute);
  if (stat.isSymbolicLink()) {
    failures.push(`${file}: symlinks are not release-safe`);
    continue;
  }
  if (!stat.isFile() || stat.size > 8 * 1024 * 1024) continue;
  const content = await fs.readFile(absolute, 'utf8').catch(() => '');
  for (const [pattern, label] of forbiddenContent) {
    if (pattern.test(content)) failures.push(`${file}: contains ${label}`);
  }
}

const readJson = async (file) => JSON.parse(await fs.readFile(path.join(root, file), 'utf8'));
const rootPackage = await readJson('package.json');
const extensionPackage = await readJson('extensions/tex-desk/package.json');
const pluginManifest = await readJson('plugins/hbc-tex-desk/.codex-plugin/plugin.json');
const pluginBaseVersion = String(pluginManifest.version || '').split('+')[0];
if (rootPackage.version !== extensionPackage.version || rootPackage.version !== pluginBaseVersion) {
  failures.push(`version mismatch: app=${rootPackage.version}, extension=${extensionPackage.version}, plugin=${pluginManifest.version}`);
}

const { stdout: authorEmails = '' } = await execFileAsync(
  'git',
  ['log', '--format=%ae'],
  { cwd: root, encoding: 'utf8' },
).catch(() => ({ stdout: '' }));
if (/@college\.harvard\.edu\b/i.test(authorEmails)) {
  failures.push('Git history contains a private Harvard author email');
}

if (failures.length) {
  process.stderr.write(`Release audit failed:\n${failures.map((failure) => `- ${failure}`).join('\n')}\n`);
  process.exit(1);
}
process.stdout.write(`Release audit passed for ${files.length} tracked files; no personal workspace, runtime secret, private path, or private-paper fingerprint is present.\n`);

import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

const TOOL_CANDIDATES = {
  latexmk: ['/Library/TeX/texbin/latexmk', '/opt/homebrew/bin/latexmk', '/usr/local/bin/latexmk'],
  xelatex: ['/Library/TeX/texbin/xelatex', '/opt/homebrew/bin/xelatex', '/usr/local/bin/xelatex'],
  chktex: ['/Library/TeX/texbin/chktex', '/opt/homebrew/bin/chktex', '/usr/local/bin/chktex'],
  pdfinfo: ['/opt/homebrew/bin/pdfinfo', '/Library/TeX/texbin/pdfinfo', '/usr/local/bin/pdfinfo'],
  synctex: ['/Library/TeX/texbin/synctex', '/opt/homebrew/bin/synctex', '/usr/local/bin/synctex'],
  codex: ['/opt/homebrew/bin/codex', '/usr/local/bin/codex'],
};
const DEFAULT_WINDOWS_EXECUTABLE_EXTENSIONS = ['.COM', '.EXE', '.BAT', '.CMD'];

function pathEntries(env, platform) {
  const delimiter = platform === 'win32' ? ';' : path.delimiter;
  return String(env.PATH || '')
    .split(delimiter)
    .map((directory) => directory.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

function executableSuffixes(env, platform) {
  if (platform !== 'win32') return [''];
  const configured = String(env.PATHEXT || '')
    .split(';')
    .map((extension) => extension.trim())
    .filter((extension) => /^\.[A-Za-z0-9]+$/.test(extension));
  const extensions = configured.length ? configured : DEFAULT_WINDOWS_EXECUTABLE_EXTENSIONS;
  return ['', ...new Set(extensions.map((extension) => extension.toUpperCase()))];
}

export function inheritedLocaleEnv() {
  if (process.platform === 'win32') return {};
  const configured = process.env.PAGETURNOVER_LOCALE;
  const inherited = configured || process.env.LC_ALL || process.env.LANG || '';
  const locale = process.platform === 'darwin' && /^C(?:\.UTF-?8)?$/i.test(inherited)
    ? 'en_US.UTF-8'
    : inherited && inherited !== 'C'
      ? inherited
      : 'C.UTF-8';
  return locale ? { LC_ALL: locale, LANG: locale } : {};
}

export async function findExecutable(name, {
  env = process.env,
  platform = process.platform,
} = {}) {
  const suffixes = executableSuffixes(env, platform);
  const fixedCandidates = platform === 'win32' ? [] : (TOOL_CANDIDATES[name] || []);
  const fromPath = pathEntries(env, platform).flatMap((directory) => (
    suffixes.map((suffix) => path.join(directory, `${name}${suffix}`))
  ));
  for (const candidate of [...fixedCandidates, ...fromPath]) {
    try {
      const stat = await fs.stat(candidate);
      if (!stat.isFile()) continue;
      await fs.access(candidate, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK);
      return candidate;
    } catch {
      // Keep looking.
    }
  }
  return null;
}

export function runProcess(executable, args, {
  cwd,
  env = {},
  input,
  timeoutMs = 15_000,
  maxOutput = 1_000_000,
  inheritEnv = true,
} = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(executable, args, {
      cwd,
      env: { ...(inheritEnv ? process.env : {}), ...env },
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const append = (target, chunk) => {
      const value = chunk.toString('utf8');
      if (target === 'stdout') stdout = (stdout + value).slice(-maxOutput);
      else stderr = (stderr + value).slice(-maxOutput);
    };
    child.stdout.on('data', (chunk) => append('stdout', chunk));
    child.stderr.on('data', (chunk) => append('stderr', chunk));

    const terminate = (signal) => {
      if (!child.pid) return;
      try {
        if (process.platform === 'win32') child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };

    const timer = setTimeout(() => {
      timedOut = true;
      terminate('SIGTERM');
      setTimeout(() => terminate('SIGKILL'), 1_500).unref();
    }, timeoutMs);
    timer.unref();

    child.once('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        code,
        signal,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - started,
      });
    });

    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

async function toolVersion(name, executable) {
  if (!executable) return null;
  const args = name === 'latexmk' ? ['-v'] : name === 'pdfinfo' ? ['-v'] : ['--version'];
  try {
    const result = await runProcess(executable, args, {
      timeoutMs: 3_000,
      env: inheritedLocaleEnv(),
      maxOutput: 20_000,
    });
    return `${result.stdout}\n${result.stderr}`.trim().split('\n').find(Boolean)?.trim() || null;
  } catch {
    return null;
  }
}

export async function getToolStatus() {
  const status = {};
  await Promise.all(Object.keys(TOOL_CANDIDATES).map(async (name) => {
    const executable = await findExecutable(name);
    status[name] = {
      available: Boolean(executable),
      path: executable,
      version: await toolVersion(name, executable),
    };
  }));
  return status;
}

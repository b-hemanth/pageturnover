import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { findExecutable } from '../server/lib/processes.mjs';

const temporaryDirectories = [];

afterEach(async () => {
  while (temporaryDirectories.length) {
    await fs.rm(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe('tool executable discovery', () => {
  it('resolves Windows command extensions from a quoted PATH entry', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pageturnover-processes-test-'));
    temporaryDirectories.push(directory);
    const executable = path.join(directory, 'latexmk.CMD');
    await fs.writeFile(executable, '@echo off\r\n');

    await expect(findExecutable('latexmk', {
      platform: 'win32',
      env: {
        PATH: `"${directory}"`,
        PATHEXT: '.EXE;.CMD;../UNSAFE',
      },
    })).resolves.toBe(executable);
  });

  it('uses safe default Windows command extensions and ignores directories', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'pageturnover-processes-test-'));
    temporaryDirectories.push(directory);
    await fs.mkdir(path.join(directory, 'xelatex.EXE'));
    const executable = path.join(directory, 'codex.cmd');
    await fs.writeFile(executable, '@echo off\r\n');

    await expect(findExecutable('xelatex', {
      platform: 'win32',
      env: { PATH: directory },
    })).resolves.toBeNull();
    const resolved = await findExecutable('codex', {
      platform: 'win32',
      env: { PATH: directory, PATHEXT: '.cmd' },
    });
    expect(resolved?.toLowerCase()).toBe(executable.toLowerCase());
  });
});

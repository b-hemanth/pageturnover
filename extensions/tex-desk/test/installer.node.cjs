// Named *.node.cjs so the parent Vitest suite does not collect this Node-only test.
const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { pathToFileURL } = require('node:url');

const installerModule = import(pathToFileURL(
  path.resolve(__dirname, '..', '..', '..', 'scripts', 'install-cursor-extension.mjs'),
).href);

test('parses safe and idempotent installer modes', async () => {
  const { parseArgs } = await installerModule;
  assert.deepEqual(parseArgs(['--editor', 'cursor', '--remote-only', '--if-available']), {
    editor: 'cursor',
    help: false,
    ifAvailable: true,
    remoteOnly: true,
  });
  assert.throws(() => parseArgs(['--editor', 'unknown']), /--editor must be one of/);
  assert.throws(() => parseArgs(['--unexpected']), /Unknown option/);
});

test('requires real extension-management help instead of trusting exit zero', async () => {
  const { hasExtensionManagementHelp } = await installerModule;
  assert.equal(hasExtensionManagementHelp('Options: --list-extensions --install-extension'), true);
  assert.equal(
    hasExtensionManagementHelp('Command is only available in WSL or inside a Visual Studio Code terminal.'),
    false,
  );
});

test('matches only exact id and version lines from post-install listing', async () => {
  const { extensionVersionFromList } = await installerModule;
  const output = [
    'publisher.another-extension@1.0.0',
    'hbc-local.hbc-tex-companion-extra@0.1.0',
    'hbc-local.hbc-tex-companion@0.1.1',
  ].join('\n');
  assert.equal(extensionVersionFromList(output, 'hbc-local.hbc-tex-companion'), '0.1.1');
  assert.equal(extensionVersionFromList(output, 'missing.extension'), undefined);
});

test('replaces 0.1.1 with 0.1.2 and requires an exact post-install listing', async () => {
  const { installOnCandidate } = await installerModule;
  const extensionId = 'hbc-local.hbc-tex-companion';
  const packaged = {
    extensionId,
    version: '0.1.2',
    vsixPath: path.join('artifacts', 'hbc-tex-companion-0.1.2.vsix'),
  };
  const candidate = { command: 'fake-editor' };

  const calls = [];
  let listCount = 0;
  const successfulUpgrade = async (_command, args) => {
    calls.push(args);
    if (args[0] === '--help') {
      return { code: 0, stdout: '--list-extensions --install-extension', stderr: '' };
    }
    if (args[0] === '--install-extension') return { code: 0, stdout: 'installed', stderr: '' };
    listCount += 1;
    const version = listCount === 1 ? '0.1.1' : '0.1.2';
    return { code: 0, stdout: `${extensionId}@${version}\n`, stderr: '' };
  };

  assert.deepEqual(await installOnCandidate(candidate, packaged, successfulUpgrade), {
    status: 'verified',
    installed: true,
    previousVersion: '0.1.1',
  });
  assert.deepEqual(
    calls.find((args) => args[0] === '--install-extension'),
    ['--install-extension', packaged.vsixPath, '--force'],
  );

  const staleAfterInstall = async (_command, args) => {
    if (args[0] === '--help') {
      return { code: 0, stdout: '--list-extensions --install-extension', stderr: '' };
    }
    if (args[0] === '--install-extension') return { code: 0, stdout: 'installed', stderr: '' };
    return { code: 0, stdout: `${extensionId}@0.1.1\n`, stderr: '' };
  };
  assert.deepEqual(await installOnCandidate(candidate, packaged, staleAfterInstall), {
    status: 'failed',
    reason: 'post-install list reported 0.1.1',
  });
});

test('distinguishes remote workspace wrappers from local editor CLIs', async () => {
  const { classifyCliTarget, unavailableExitCode } = await installerModule;
  assert.equal(
    classifyCliTarget(path.join('home', '.cursor-server', 'bin', 'build', 'bin', 'remote-cli', 'cursor')),
    'remote',
  );
  assert.equal(classifyCliTarget(path.join('tools', 'cursor')), 'local');
  assert.equal(classifyCliTarget(path.join('tools', 'cursor'), true), 'remote');
  assert.equal(unavailableExitCode(true), 0);
  assert.equal(unavailableExitCode(false), 1);
});

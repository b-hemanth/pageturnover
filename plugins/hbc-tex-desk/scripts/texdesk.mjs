#!/usr/bin/env node
import fs from 'node:fs/promises';

import { callOperation, doctor, initializeConfig } from './texdesk-client.mjs';

const [command = 'help', ...values] = process.argv.slice(2);

function usage() {
  return `HBC TeX Desk helper

Usage:
  texdesk.mjs init --repo /path/to/pageturnover [--url http://127.0.0.1:3006]
  texdesk.mjs doctor
  texdesk.mjs status
  texdesk.mjs projects
  texdesk.mjs path PROJECT
  texdesk.mjs tree PROJECT
  texdesk.mjs read PROJECT FILE
  texdesk.mjs save PROJECT FILE BASE_VERSION LOCAL_FILE
  texdesk.mjs lint PROJECT FILE [LOCAL_FILE]
  texdesk.mjs compile PROJECT [ROOT_FILE]
  texdesk.mjs proof PROJECT [OUTPUT_PDF]
  texdesk.mjs arxiv PROJECT [OUTPUT_ARCHIVE]

Configuration: PAGETURNOVER_CONFIG_DIR or XDG_CONFIG_HOME/APPDATA/~/.config,
then pageturnover/config.json.

Environment precedence: PAGETURNOVER_URL/TOKEN/TOKEN_FILE/REPO/PORT,
then legacy HBC_TEX_URL/TOKEN/TOKEN_FILE/REPO/PORT, then the config file.`;
}

function option(name) {
  const index = values.indexOf(name);
  if (index < 0) return undefined;
  const value = values[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}

async function run() {
  let result;
  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(`${usage()}\n`);
      return;
    case 'init':
      result = await initializeConfig({ repo: option('--repo'), url: option('--url') });
      break;
    case 'doctor':
      result = await doctor();
      if (!result.ok) process.exitCode = 1;
      break;
    case 'status':
      result = await callOperation('tex_status');
      break;
    case 'projects':
      result = await callOperation('tex_projects');
      break;
    case 'path':
      result = await callOperation('tex_workspace_path', { project_id: values[0] });
      break;
    case 'tree':
      result = await callOperation('tex_tree', { project_id: values[0] });
      break;
    case 'read':
      result = await callOperation('tex_read', { project_id: values[0], path: values[1] });
      break;
    case 'save':
      if (!values[3]) throw new Error('save requires PROJECT FILE BASE_VERSION LOCAL_FILE.');
      result = await callOperation('tex_save', {
        project_id: values[0],
        path: values[1],
        base_version: values[2],
        content: await fs.readFile(values[3], 'utf8'),
      });
      break;
    case 'lint':
      result = await callOperation('tex_lint', {
        project_id: values[0],
        path: values[1],
        ...(values[2] ? { content: await fs.readFile(values[2], 'utf8') } : {}),
      });
      break;
    case 'compile':
      result = await callOperation('tex_compile', { project_id: values[0], root_file: values[1] });
      break;
    case 'proof':
      result = await callOperation('tex_proof', { project_id: values[0], output_path: values[1] });
      break;
    case 'arxiv':
      result = await callOperation('tex_arxiv_export', { project_id: values[0], output_path: values[1] });
      break;
    default:
      throw new Error(`Unknown command: ${command}\n\n${usage()}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}

run().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});

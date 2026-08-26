#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { callOperation } from '../scripts/texdesk-client.mjs';

const pluginRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await fs.readFile(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'));
const serverVersion = typeof manifest.version === 'string' ? manifest.version : '0.0.0';

const objectSchema = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const project = { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$', description: 'TeX Desk project id.' };
const file = { type: 'string', minLength: 1, description: 'Project-relative file path.' };
const tools = [
  {
    name: 'tex_doctor',
    description: 'Diagnose PageTurnover discovery, authentication, server reachability, and local workspace access without exposing the token.',
    inputSchema: objectSchema({}),
  },
  {
    name: 'tex_status',
    description: 'Check the local TeX Desk server, compiler tools, workspace root, and AI bridge.',
    inputSchema: objectSchema({}),
  },
  {
    name: 'tex_projects',
    description: 'List the disk-native TeX projects and their recorded root files.',
    inputSchema: objectSchema({}),
  },
  {
    name: 'tex_workspace_path',
    description: 'Return the server-side project path and whether that path is accessible on this Codex host.',
    inputSchema: objectSchema({ project_id: project }, ['project_id']),
  },
  {
    name: 'tex_tree',
    description: 'List a project file tree, excluding internal build/editor state.',
    inputSchema: objectSchema({ project_id: project }, ['project_id']),
  },
  {
    name: 'tex_read',
    description: 'Read a project text file with its version token for conflict-safe editing.',
    inputSchema: objectSchema({ project_id: project, path: file }, ['project_id', 'path']),
  },
  {
    name: 'tex_save',
    description: 'Save a text file only if its current version matches base_version. Call tex_read first.',
    inputSchema: objectSchema({
      project_id: project,
      path: file,
      content: { type: 'string' },
      base_version: { type: 'string', minLength: 64, maxLength: 64, description: 'SHA-256 version returned by tex_read.' },
    }, ['project_id', 'path', 'content', 'base_version']),
  },
  {
    name: 'tex_lint',
    description: 'Run structural parsing and ChkTeX on a disk file or supplied unsaved content.',
    inputSchema: objectSchema({ project_id: project, path: file, content: { type: 'string' } }, ['project_id', 'path']),
  },
  {
    name: 'tex_compile',
    description: 'Compile a project and return diagnostics, log, duration, page count, and proof URL.',
    inputSchema: objectSchema({ project_id: project, root_file: file }, ['project_id']),
  },
  {
    name: 'tex_proof',
    description: 'Download the current compiled PDF to a fresh temporary directory or a non-existing absolute output path.',
    inputSchema: objectSchema({
      project_id: project,
      root_file: file,
      output_path: { type: 'string', description: 'Optional absolute destination; existing files are never overwritten.' },
    }, ['project_id']),
  },
  {
    name: 'tex_arxiv_export',
    description: 'Build and download the clean arXiv source archive to a fresh temp directory or a non-existing absolute output path.',
    inputSchema: objectSchema({
      project_id: project,
      output_path: { type: 'string', description: 'Optional absolute destination; existing files are never overwritten.' },
    }, ['project_id']),
  },
];

function write(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  write({ jsonrpc: '2.0', id, result: value });
}

function failure(id, code, message) {
  write({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(message) {
  if (!message || message.jsonrpc !== '2.0') return;
  const { id, method, params = {} } = message;
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'initialize') {
    result(id, {
      protocolVersion: params.protocolVersion || '2025-03-26',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'hbc-tex-desk', version: serverVersion },
    });
    return;
  }
  if (method === 'ping') {
    result(id, {});
    return;
  }
  if (method === 'tools/list') {
    result(id, { tools });
    return;
  }
  if (method === 'tools/call') {
    const name = params.name;
    if (!tools.some((tool) => tool.name === name)) {
      result(id, { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] });
      return;
    }
    try {
      const value = await callOperation(name, params.arguments || {});
      result(id, { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] });
    } catch (error) {
      result(id, {
        isError: true,
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
      });
    }
    return;
  }
  if (id !== undefined) failure(id, -32601, `Method not found: ${method}`);
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  while (true) {
    const newline = buffer.indexOf('\n');
    if (newline < 0) break;
    const raw = buffer.slice(0, newline).replace(/\r$/, '');
    buffer = buffer.slice(newline + 1);
    if (!raw.trim()) continue;
    try {
      void handle(JSON.parse(raw)).catch((error) => {
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
      });
    } catch (error) {
      failure(null, -32700, error instanceof Error ? error.message : 'Invalid JSON');
    }
  }
});

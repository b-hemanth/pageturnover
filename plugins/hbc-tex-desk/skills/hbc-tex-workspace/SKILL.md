---
name: hbc-tex-workspace
description: Collaborate on the disk-native TeX papers served by HBC TeX Desk, including safe source edits, linting, compilation, PDF proof retrieval, and arXiv source export. Use when a request refers to the local TeX editor, its workspaces, a paper inside it, or working on the same paper from Codex and Cursor, VS Code, or VSCodium.
---

# HBC TeX Workspace

Treat the PageTurnover files as the single source of truth. When Codex and the editor run on the
same host, they use the same project directories. Across an SSH tunnel, use the API tools and do
not mistake a server-side absolute path for a locally accessible path.

## Establish the paper

- Use `tex_projects` to find the actual project and its root file. Do not infer the active paper
  from a browser tab name or a stale conversation.
- Use `tex_doctor` when discovery or authentication is uncertain.
- Use `tex_workspace_path` when an editor or shell needs the project directory. Trust `localPath`
  only when `localAccessible` is true; `serverPath` may belong to another host.
- Use `tex_tree` before assuming included files, bibliography names, or asset paths.
- Use `tex_read` for a current file record. Its `version` is the concurrency token for a safe save.

## Edit without losing work

- Preserve the user's prose, mathematics, comments, macros, and local edits unless the request
  specifically authorizes changing them.
- For an API save, pass the exact `version` returned by the most recent `tex_read` as
  `base_version`. If the server reports a conflict, reread and reconcile; never retry by removing
  the version check.
- When operating directly in the same checkout, ordinary filesystem edits are immediately visible
  to the TeX Desk watcher. Use the API save when another editor may be writing concurrently.
- Do not delete, rename, or reorganize project files without explicit authorization.

## Check the result

1. Run `tex_lint` on each changed TeX source. When checking unsaved text, pass `content`;
   otherwise omit it to lint the disk copy.
2. Run `tex_compile` using the project's recorded root file unless the user names another root.
3. If compilation succeeds, use `tex_proof` to retrieve the exact current PDF and inspect the
   rendered pages when layout matters. `tex_proof` does not silently recompile stale source.
4. Use `tex_arxiv_export` only after source and bibliography checks; it downloads the server's
   clean source archive rather than the build directory.

Report the file paths changed, lint/compiler state, and the proof or archive path. State tool or
render limitations plainly.

## CLI fallback

If the MCP tools are not present in the current thread, locate this skill's installed path, remove
`/skills/hbc-tex-workspace/SKILL.md` to obtain the plugin root, and run
`node <plugin-root>/scripts/texdesk.mjs doctor`. On a new machine, initialize discovery with
`node <plugin-root>/scripts/texdesk.mjs init --repo /path/to/pageturnover`, then start the app from
that checkout. `PAGETURNOVER_*` environment variables override legacy `HBC_TEX_*` variables,
which override the per-machine `pageturnover/config.json` file.

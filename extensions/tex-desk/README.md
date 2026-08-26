# HBC TeX Companion

HBC TeX Companion connects Cursor, VS Code, or VSCodium to PageTurnover's
disk-backed paper workspaces. The IDE, its AI tools, the browser desk, and shell
tools all edit the same files under `workspaces/`; the extension adds commands,
Problems diagnostics, compilation, PDF proof opening, and arXiv export without
creating a second document store.

Source: [github.com/b-hemanth/pageturnover](https://github.com/b-hemanth/pageturnover)

## Install on a fresh device

From the repository root, the normal setup flow installs dependencies, builds
the browser desk, creates `workspaces/welcome-paper` when no projects exist, and
invokes the extension installer:

```sh
npm run setup
```

To rebuild and install only the IDE extension:

```sh
node scripts/install-cursor-extension.mjs
```

The installer runs `npm ci`, checks the TypeScript extension, produces a
versioned VSIX, discovers `cursor`, `code`, and `codium`, and verifies the exact
installed extension id and version with the selected CLI. Use `--editor cursor`
to restrict the editor family. Use `--if-available` in automation: it exits
successfully with manual instructions when no usable editor CLI exists, while a
normal invocation fails in that case.

You can also download the VSIX from a GitHub Release, then choose
**Extensions → … → Install from VSIX…** in the editor. Reload the window once.
This is the standard [VS Code VSIX installation flow](https://code.visualstudio.com/docs/configure/extensions/extension-marketplace#_install-from-a-vsix).

## Remote SSH

The manifest declares a `workspace` extension, so repository discovery, Node,
LaTeX, and filesystem access run on the host that owns the paper files. For an
SSH checkout:

1. Connect to the target in Cursor or VS Code and open the repository there.
2. Run `npm run setup` in that connected window's integrated terminal. A real
   remote-workspace CLI is preferred and accepted only after extension listing
   and installation are verified.
3. If the installer cannot see that CLI, use **Install from VSIX…** in the
   connected remote window. Confirm placement with **Developer: Show Running
   Extensions**; do not install the workspace extension only into the local UI.

The browser command passes the loopback URL through `vscode.env.asExternalUri`,
which lets the editor provide the correct forwarded URL. This follows the
official [remote extension guidance](https://code.visualstudio.com/api/advanced-topics/remote-extensions#_opening-something-in-a-local-browser-or-application).

## Daily use

Run **HBC TeX: Actions** from the command palette or click the `TeX` status
item. In Cursor, use a classic workspace window so normal extension commands are
available (`cursor --classic --new-window .` on versions that expose that flag).

- **Open Project** opens `hbcTex.defaultProjectId`, which defaults to
  `welcome-paper`. If that project is absent, the extension lists valid disk
  projects and asks you to choose one.
- **Select Default Project** always shows the project picker and remembers the
  selection for the current workspace.
- **Open Browser Desk** reuses or starts the production server, forwards the
  configured port, bootstraps the protected session, and opens it locally.
- **Lint Current TeX File** sends structural-parser and ChkTeX findings to the
  editor's Problems view. Lint-on-save is enabled by default.
- **Compile Current Paper** saves the active source, invokes the secure compiler
  endpoint, and publishes LaTeX diagnostics.
- **Open PDF Proof** compiles and opens the generated `.jhana-build` PDF with the
  editor's registered PDF viewer.
- **Export arXiv Source** produces a checked submission archive and saves it
  through the remote-aware file picker.
- **Start/Stop/Show Server Status** manages only the process recorded by this
  extension. An existing server is detected and reused.

External saves are watched by PageTurnover, so edits made by Cursor, Copilot,
Codex, or a terminal are visible to an open browser desk without copying files.

## Configuration and security

`hbcTex.serverPort` defaults to `3006` and is machine-overridable for SSH hosts.
The extension starts `node scripts/serve-production.mjs` on `127.0.0.1`, reads
or creates `.runtime/access-token` with owner-only permissions, and does not log
the launcher's token-bearing stdout. It sends the token only to the local server
and the forwarded browser bootstrap URL.

Compiling TeX and starting the repository server execute workspace tools, so
the extension is disabled in untrusted and virtual workspaces. A production
`dist/index.html` must exist; `npm run setup` creates it.

Optional settings:

```json
{
  "hbcTex.repoRoot": "",
  "hbcTex.serverPort": 3006,
  "hbcTex.defaultProjectId": "welcome-paper",
  "hbcTex.lintOnSave": true,
  "hbcTex.compileOnSave": false,
  "hbcTex.showStatusBar": true
}
```

Leave `hbcTex.repoRoot` empty for workspace discovery, or set it to the checkout
root on the extension host.

## Compatibility and development

- VS Code API `^1.95.0`, compiled against exact `@types/vscode` `1.95.0` with no
  proposed APIs.
- Cursor, VS Code, and VSCodium desktop or Remote SSH workspace hosts.
- Node and the repository's TeX toolchain on the extension host.
- A PDF viewer extension for the in-editor proof command; the browser proof uses
  PageTurnover's built-in PDF renderer.

Build and verify the package with locked dependencies:

```sh
cd extensions/tex-desk
npm ci
npm test
npm run package
```

The extension is distributed under the MIT License.

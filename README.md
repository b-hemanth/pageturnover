# PageTurnover

A private-by-default, disk-native LaTeX writing desk. The browser editor,
Cursor/VS Code, shell tools, and Codex all work on the same files under
`workspaces/`; there is no second cloud document store and no sync format to
fight.

The browser stays deliberately quiet: Monaco editing, structural LaTeX
parsing, ChkTeX diagnostics, XeLaTeX/latexmk builds, PDF.js live proofing,
SyncTeX navigation, conflict-safe saves, AI revision proposals, and clean
arXiv source export. The default mathematics template follows the compact
arXiv/Levent Alpöge preprint idiom; a jhana long-form template, a conventional
research-paper template, and a blank document are also available.

## Fresh-device setup

You need Node.js 22.13 or newer. To compile papers, install a TeX Live or MacTeX
distribution providing `latexmk` and `xelatex`; `chktex`, `bibtex`, and
`synctex` enable the full diagnostics and proof workflow.

```sh
git clone https://github.com/b-hemanth/pageturnover.git
cd pageturnover
npm run setup
npm run serve
```

`npm run setup` is idempotent. It installs the locked dependencies, builds the
production app, creates `workspaces/welcome-paper` only when no paper exists,
writes a per-machine Codex discovery record outside the repository, and
packages/installs the companion extension when a compatible editor CLI is
available. It never replaces an existing workspace.

The serve command prints the protected URL to open. It binds to loopback on
port `3006` by default. Use `PAGETURNOVER_PORT` to choose another port or
`PAGETURNOVER_HOST=0.0.0.0` for an explicitly network-reachable listener. The
browser exchanges the one-use URL parameter for an HttpOnly cookie and removes
the token from the address bar.

All papers, runtime credentials, exports, builds, and generated VSIX files are
ignored by Git. Back up `workspaces/` separately; updating the application does
not make Git a paper-backup system.

## Cursor, VS Code, and VSCodium

Open the cloned folder in a normal IDE workspace:

```sh
cursor --classic --new-window .
```

If setup could not find the editor CLI, install the extension explicitly from
the same machine that owns the workspace files:

```sh
npm run cursor:install
```

The extension is a workspace extension, so in a Remote SSH window run that
command in the remote integrated terminal (or use **Install from VSIX** on the
SSH extension host). It starts the server remotely, forwards the protected
port through the editor, and edits the same remote `workspaces/` files. Cursor
Agents' separate glass surface does not load ordinary workspace extensions;
the commands appear in the classic IDE window.

Tagged releases attach a stable `hbc-tex-companion.vsix`. It can also be
installed without a source checkout first:

```sh
curl -fLO https://github.com/b-hemanth/pageturnover/releases/latest/download/hbc-tex-companion.vsix
cursor --install-extension hbc-tex-companion.vsix --force
```

The command palette entries are intentionally plain HBC TeX helpers: open the
browser desk, lint, compile, inspect PDF proof, export arXiv source, and control
the local service. Cursor/Copilot remain the AI editor; the extension does not
replace or proxy them.

## Codex plugin

PageTurnover is a Git-backed Codex marketplace. Install it from any Codex
machine with GitHub access:

```sh
codex plugin marketplace add git@github.com:b-hemanth/pageturnover.git --ref main
codex plugin add hbc-tex-desk@pageturnover
```

Use the HTTPS Git URL instead of the SSH URL on machines without a GitHub SSH
key. Start a new Codex thread after installing or updating so its skill and MCP
tools are loaded.

The marketplace cache contains only the bridge, not your durable papers. Clone
and run `npm run setup` once on the machine hosting the app; setup records that
checkout in the per-machine configuration. The plugin can then list projects,
return their real disk paths, perform version-safe reads/saves, lint, compile,
download proof PDFs, and build arXiv archives. Run its bundled helper directly
for diagnosis:

```sh
node plugins/hbc-tex-desk/scripts/texdesk.mjs doctor
```

From a source checkout, `npm run doctor` combines the application/toolchain
check with that bridge and server diagnosis.

## Working model

- Browser saves carry SHA-256 base versions. A disk collision is surfaced
  before either editor can overwrite the other.
- External file changes appear live and trigger fresh diagnostics/proof.
- Unsaved browser text is mirrored locally in IndexedDB for crash recovery.
- AI changes are proposals scoped to a selection or file. Source changes only
  after **Apply**; an OpenAI API key is optional because the local Codex CLI is
  also supported.
- XeLaTeX runs with shell escape disabled in an isolated build directory. The
  last good PDF remains visible after a failed compile.
- The arXiv exporter follows actual TeX dependencies and excludes editor,
  collaboration, build, backup, and hidden state.

Shortcuts: `Cmd/Ctrl+S` saves, `Cmd/Ctrl+Enter` compiles, and `Cmd/Ctrl+K`
opens the Writing Desk.

## Configuration

| Variable | Purpose |
| --- | --- |
| `PAGETURNOVER_REPO` | Persistent application checkout used by the Codex bridge |
| `PAGETURNOVER_URL` | Server URL, normally `http://127.0.0.1:3006` |
| `PAGETURNOVER_TOKEN` | Explicit access token; normally read from the checkout |
| `PAGETURNOVER_PORT` | Production listener port |
| `PAGETURNOVER_HOST` | Production listener host |
| `PAGETURNOVER_LOCALE` | Override the UTF-8 locale passed to TeX/ChkTeX tools |
| `PAGETURNOVER_CONFIG_DIR` | Override the per-machine config base directory |
| `OPENAI_API_KEY` | Optional browser Writing Desk provider |

The older `HBC_TEX_*` and `JHANA_TEX_*` listener aliases remain accepted for
existing personal installations.

## Verification and release safety

```sh
npm run check
npm test
npm run build
npm --prefix extensions/tex-desk ci
npm --prefix extensions/tex-desk test
npm run cursor:package
npm run audit:release
```

The release audit rejects personal workspace files, runtime state, generated
artifacts, absolute HBC paths, private-key material, and the known private-paper
fingerprint. Public history starts in this repository; it does not inherit any
private working-repository history.

The default mathematics template is distilled from the public TeX archives for
Levent Alpöge's arXiv papers
[`2501.18774`](https://arxiv.org/src/2501.18774),
[`2408.11653`](https://arxiv.org/src/2408.11653), and
[`1807.03761`](https://arxiv.org/src/1807.03761). It retains the useful common
spine without copying paper-specific prose or obsolete local macros.

See [SECURITY.md](SECURITY.md) for the local-service boundary and
[TRADEMARKS.md](TRADEMARKS.md) for the optional jhana template assets. Bundled
font notices are in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

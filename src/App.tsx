import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Editor, { type Monaco, type OnMount } from '@monaco-editor/react'
import type { editor as MonacoEditor } from 'monaco-editor'
import {
  AlertCircle,
  AlertTriangle,
  Bold,
  BookOpenText,
  Bot,
  Braces,
  Check,
  ChevronDown,
  ChevronRight,
  Circle,
  Code2,
  Command,
  Download,
  ExternalLink,
  File,
  FileArchive,
  FileImage,
  FilePlus2,
  FileText,
  Folder,
  FolderPlus,
  Heading2,
  Info,
  Italic,
  Link2,
  List,
  LoaderCircle,
  MessageSquareText,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Play,
  Plus,
  Quote,
  RefreshCw,
  Save,
  Search,
  Sigma,
  Sparkles,
  SplitSquareVertical,
  Trash2,
  WandSparkles,
  X,
  Zap,
} from 'lucide-react'
import { api, ApiError } from './api'
import { configureLatex, toMonacoMarkers } from './latexLanguage'
import { analyzeLatexAst } from './latexAst'
import PdfPreview, { type PdfPoint, type PdfSyncTarget } from './PdfPreview'
import { clearRecoveryDraft, readRecoveryDraft, storeRecoveryDraft, type RecoveryDraft } from './recovery'
import type {
  AiResult,
  AiStatus,
  CompileResult,
  Diagnostic,
  FileNode,
  OutlineItem,
  Project,
  ProjectFile,
  Template,
} from './types'

type SaveState = 'saved' | 'dirty' | 'saving' | 'conflict' | 'error'
type BuildState = 'idle' | 'building' | 'success' | 'failed'
type RailTab = 'files' | 'outline'
type BottomTab = 'problems' | 'log'
type MobilePane = 'source' | 'proof'

interface SystemStatus {
  latexmk?: boolean
  xelatex?: boolean
  chktex?: boolean
  synctex?: boolean
}

interface ConflictState {
  current: ProjectFile
  mine: string
}

interface AiApplyContext {
  projectId: string
  path: string
  content: string
  selection: string
  range: {
    startLineNumber: number
    startColumn: number
    endLineNumber: number
    endColumn: number
  } | null
}

const TEXT_EXTENSIONS = new Set(['tex', 'sty', 'cls', 'bib', 'txt', 'md', 'json'])

function extension(path: string) {
  return path.split('.').pop()?.toLowerCase() || ''
}

function isEditable(path: string) {
  return TEXT_EXTENSIONS.has(extension(path))
}

function isCompactViewport() {
  return typeof window !== 'undefined' && window.matchMedia('(max-width: 820px)').matches
}

function firstEditable(nodes: FileNode[]): string | undefined {
  for (const node of nodes) {
    if (node.type === 'file' && isEditable(node.path)) return node.path
    if (node.children) {
      const nested = firstEditable(node.children)
      if (nested) return nested
    }
  }
  return undefined
}

function matchingFilePaths(nodes: FileNode[], name: string, paths: string[] = []) {
  for (const node of nodes) {
    if (node.type === 'file' && (node.path === name || basename(node.path) === basename(name))) {
      paths.push(node.path)
    }
    if (node.children) matchingFilePaths(node.children, name, paths)
  }
  return paths
}

function basename(path: string) {
  return path.split('/').at(-1) || path
}

function formatDuration(milliseconds?: number) {
  if (milliseconds == null) return '—'
  if (milliseconds < 1000) return `${milliseconds} ms`
  return `${(milliseconds / 1000).toFixed(1)} s`
}

function dedupeDiagnostics(diagnostics: Diagnostic[]) {
  const seen = new Set<string>()
  return diagnostics.filter((diagnostic) => {
    const key = `${diagnostic.file || ''}:${diagnostic.line}:${diagnostic.column || 1}:${diagnostic.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function FileGlyph({ node }: { node: FileNode }) {
  if (node.type === 'directory') return <Folder size={14} />
  const ext = extension(node.path)
  if (['png', 'jpg', 'jpeg', 'svg', 'pdf'].includes(ext)) return <FileImage size={14} />
  if (['tex', 'sty', 'cls'].includes(ext)) return <Braces size={14} />
  if (ext === 'bib') return <BookOpenText size={14} />
  if (['md', 'txt'].includes(ext)) return <FileText size={14} />
  return <File size={14} />
}

function FileTree({
  nodes,
  activePath,
  onSelect,
}: {
  nodes: FileNode[]
  activePath: string
  onSelect: (node: FileNode) => void
}) {
  const [closed, setClosed] = useState<Set<string>>(new Set())

  const renderNode = (node: FileNode, depth: number) => {
    const isFolder = node.type === 'directory'
    const isClosed = closed.has(node.path)
    return (
      <div key={node.path}>
        <button
          className={`tree-row ${activePath === node.path ? 'is-active' : ''}`}
          style={{ '--tree-depth': depth } as React.CSSProperties}
          aria-expanded={isFolder ? !isClosed : undefined}
          onClick={() => {
            if (isFolder) {
              setClosed((previous) => {
                const next = new Set(previous)
                if (next.has(node.path)) next.delete(node.path)
                else next.add(node.path)
                return next
              })
            } else {
              onSelect(node)
            }
          }}
          title={node.path}
        >
          <span className="tree-caret">
            {isFolder ? (
              isClosed ? <ChevronRight size={12} /> : <ChevronDown size={12} />
            ) : null}
          </span>
          <FileGlyph node={node} />
          <span className="tree-name">{node.name}</span>
          {node.name === 'main.tex' && <span className="root-tag">ROOT</span>}
        </button>
        {isFolder && !isClosed && node.children?.map((child) => renderNode(child, depth + 1))}
      </div>
    )
  }

  return <div className="file-tree">{nodes.map((node) => renderNode(node, 0))}</div>
}

function DiagnosticIcon({ severity, size = 14 }: { severity: Diagnostic['severity']; size?: number }) {
  if (severity === 'error') return <AlertCircle size={size} />
  if (severity === 'warning') return <AlertTriangle size={size} />
  return <Info size={size} />
}

function NewProjectDialog({
  templates,
  onClose,
  onCreate,
}: {
  templates: Template[]
  onClose: () => void
  onCreate: (name: string, template: string) => Promise<void>
}) {
  const [name, setName] = useState('Untitled paper')
  const [templateId, setTemplateId] = useState(templates[0]?.id || 'research-paper')
  const [creating, setCreating] = useState(false)
  const dialogRef = useRef<HTMLElement | null>(null)
  const nameInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const dialog = dialogRef.current
    const focusInput = window.requestAnimationFrame(() => nameInputRef.current?.focus())
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
        return
      }
      if (event.key !== 'Tab' || !dialog) return
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
        ),
      )
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(focusInput)
      document.removeEventListener('keydown', onKeyDown)
      returnFocus?.focus()
    }
  }, [onClose])

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        ref={dialogRef}
        className="modal project-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="new-project-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="modal-header">
          <div>
            <p className="eyebrow">NEW PREPRINT</p>
            <h2 id="new-project-title">Start from a clean source.</h2>
          </div>
          <button className="icon-button" onClick={onClose} aria-label="Close">
            <X size={17} />
          </button>
        </header>
        <label className="field-label" htmlFor="project-name">Project name</label>
        <input
          ref={nameInputRef}
          id="project-name"
          className="text-input"
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <div className="template-grid" role="group" aria-label="Project template">
          {templates.map((template) => (
            <button
              key={template.id}
              className={`template-option ${templateId === template.id ? 'is-selected' : ''}`}
              aria-pressed={templateId === template.id}
              onClick={() => setTemplateId(template.id)}
            >
              <span className="template-proof" data-template={template.id}>
                <i />
                <i />
                <i />
                <i />
              </span>
              <span className="template-copy">
                <strong>{template.name}</strong>
                <small>{template.description}</small>
              </span>
              <span className="template-check">
                {templateId === template.id ? <Check size={13} /> : null}
              </span>
            </button>
          ))}
        </div>
        <footer className="modal-footer">
          <button className="quiet-button" onClick={onClose}>Cancel</button>
          <button
            className="primary-button"
            disabled={!name.trim() || !templateId || creating}
            onClick={async () => {
              setCreating(true)
              try {
                await onCreate(name.trim(), templateId)
              } finally {
                setCreating(false)
              }
            }}
          >
            {creating ? <LoaderCircle className="spin" size={15} /> : <Plus size={15} />}
            Create project
          </button>
        </footer>
      </section>
    </div>
  )
}

const AI_ACTIONS = [
  { id: 'tighten', label: 'Tighten prose', detail: 'Keep voice and citations.', icon: Zap },
  { id: 'develop', label: 'Develop argument', detail: 'Find the missing inferential step.', icon: Sparkles },
  { id: 'latex', label: 'Repair LaTeX', detail: 'Use build errors and preserve meaning.', icon: Code2 },
  { id: 'citations', label: 'Audit citations', detail: 'Flag unsupported or dangling claims.', icon: BookOpenText },
]

function AiDrawer({
  onClose,
  status,
  busy,
  result,
  resultScope,
  onRun,
  onHandoff,
  onApply,
}: {
  onClose: () => void
  status: AiStatus | null
  busy: boolean
  result: AiResult | null
  resultScope: 'selection' | 'file'
  onRun: (action: string, instruction: string) => Promise<void>
  onHandoff: (action: string, instruction: string) => Promise<void>
  onApply: (text: string) => void
}) {
  const [action, setAction] = useState('tighten')
  const [instruction, setInstruction] = useState('')
  const drawerRef = useRef<HTMLElement | null>(null)
  const instructionRef = useRef<HTMLTextAreaElement | null>(null)
  const replacement = resultScope === 'selection'
    ? typeof result?.replacement === 'string' ? result.replacement : typeof result?.output === 'string' ? result.output : undefined
    : typeof result?.content === 'string' ? result.content : typeof result?.output === 'string' ? result.output : undefined

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusInstruction = window.requestAnimationFrame(() => instructionRef.current?.focus())
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      window.cancelAnimationFrame(focusInstruction)
      document.removeEventListener('keydown', onKeyDown)
      returnFocus?.focus()
    }
  }, [onClose])

  return (
    <aside
      ref={drawerRef}
      className="ai-drawer is-open"
      role="dialog"
      aria-labelledby="ai-drawer-title"
    >
      <header className="ai-header">
        <div className="ai-mark"><WandSparkles size={17} /></div>
        <div>
          <p className="eyebrow">EDITORIAL ASSISTANT</p>
          <h2 id="ai-drawer-title">Revise the passage.</h2>
        </div>
        <button className="icon-button" onClick={onClose} aria-label="Close writing desk">
          <X size={17} />
        </button>
      </header>

      <div className="ai-context-line">
        <span className={`status-dot ${status?.available ? 'is-live' : ''}`} />
        {status?.available
          ? `${status.provider || 'OpenAI'} · ${status.model || 'configured model'}`
          : 'Filesystem handoff · ready for Codex'}
      </div>

      <div className="ai-actions">
        {AI_ACTIONS.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.id}
              className={action === item.id ? 'is-selected' : ''}
              aria-pressed={action === item.id}
              onClick={() => setAction(item.id)}
            >
              <Icon size={15} />
              <span><strong>{item.label}</strong><small>{item.detail}</small></span>
              <Circle size={8} />
            </button>
          )
        })}
      </div>

      <label className="field-label" htmlFor="ai-instruction">Direction</label>
      <textarea
        ref={instructionRef}
        id="ai-instruction"
        className="prompt-input"
        value={instruction}
        onChange={(event) => setInstruction(event.target.value)}
        placeholder="What should change—and what must survive?"
      />
      <p className="microcopy">Selection first. Whole file if nothing is selected. No edit is applied without review.</p>

      <div className="ai-submit-row">
        <button
          className="primary-button"
          disabled={busy || !status?.available}
          onClick={() => onRun(action, instruction)}
        >
          {busy ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}
          Draft change
        </button>
        <button className="quiet-button" disabled={busy} onClick={() => onHandoff(action, instruction)}>
          <Bot size={15} /> Save Codex request
        </button>
      </div>

      {result && (
        <section className="ai-result">
          <header>
            <span>{result.requestId ? 'HANDOFF FILED' : 'PROPOSED CHANGE'}</span>
            {result.requestId && <code>{result.requestId}</code>}
          </header>
          {result.title && <h3>{result.title}</h3>}
          {result.explanation && <p>{result.explanation}</p>}
          {typeof replacement === 'string' && (
            <>
              <pre>{replacement || '% Delete the selected passage'}</pre>
              <button className="primary-button" onClick={() => onApply(replacement)}>
                <Check size={15} /> {resultScope === 'selection' ? 'Apply to selection' : 'Replace file'}
              </button>
            </>
          )}
          {result.path && <p className="handoff-path">Saved to <code>{result.path}</code></p>}
        </section>
      )}
    </aside>
  )
}

function App() {
  const [projects, setProjects] = useState<Project[]>([])
  const [templates, setTemplates] = useState<Template[]>([])
  const [activeProjectId, setActiveProjectId] = useState('')
  const [tree, setTree] = useState<FileNode[]>([])
  const [activePath, setActivePath] = useState('')
  const [content, setContent] = useState('')
  const [baseVersion, setBaseVersion] = useState('')
  const [saveState, setSaveState] = useState<SaveState>('saved')
  const [buildState, setBuildState] = useState<BuildState>('idle')
  const [proofStale, setProofStale] = useState(false)
  const [compileResult, setCompileResult] = useState<CompileResult | null>(null)
  const [lintDiagnostics, setLintDiagnostics] = useState<Diagnostic[]>([])
  const [serverOutline, setServerOutline] = useState<OutlineItem[]>([])
  const [railTab, setRailTab] = useState<RailTab>('files')
  const [bottomTab, setBottomTab] = useState<BottomTab>('problems')
  const [bottomOpen, setBottomOpen] = useState(true)
  const [railOpen, setRailOpen] = useState(() => !isCompactViewport())
  const [proofOpen, setProofOpen] = useState(true)
  const [autoBuild, setAutoBuild] = useState(true)
  const [sourceExporting, setSourceExporting] = useState(false)
  const [diskOnline, setDiskOnline] = useState(false)
  const [diskChanged, setDiskChanged] = useState(false)
  const [conflict, setConflict] = useState<ConflictState | null>(null)
  const [recovery, setRecovery] = useState<RecoveryDraft | null>(null)
  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [aiOpen, setAiOpen] = useState(false)
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null)
  const [aiBusy, setAiBusy] = useState(false)
  const [aiResult, setAiResult] = useState<AiResult | null>(null)
  const [aiContext, setAiContext] = useState<AiApplyContext | null>(null)
  const [toast, setToast] = useState('')
  const [split, setSplit] = useState(54)
  const [mobilePane, setMobilePane] = useState<MobilePane>('source')
  const [systemStatus, setSystemStatus] = useState<SystemStatus>({})
  const [cursor, setCursor] = useState({ line: 1, column: 1 })
  const [syncTarget, setSyncTarget] = useState<PdfSyncTarget | null>(null)
  const [editorLocked, setEditorLocked] = useState(false)

  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<Monaco | null>(null)
  const baseVersionRef = useRef('')
  const activeProjectIdRef = useRef('')
  const dirtyRef = useRef(false)
  const activePathRef = useRef('')
  const contentRef = useRef('')
  const compileRequestRef = useRef(0)
  const saveTimerRef = useRef<number | undefined>(undefined)
  const lintTimerRef = useRef<number | undefined>(undefined)
  const toastTimerRef = useRef<number | undefined>(undefined)
  const recoveryTimerRef = useRef<number | undefined>(undefined)
  const syncTimerRef = useRef<number | undefined>(undefined)
  const externalCompileTimerRef = useRef<number | undefined>(undefined)
  const workbenchRef = useRef<HTMLDivElement | null>(null)
  const compiledProjectsRef = useRef<Set<string>>(new Set())
  const loadRequestRef = useRef(0)
  const treeRequestRef = useRef(0)
  const saveQueueRef = useRef<Promise<ProjectFile | null>>(Promise.resolve(null))
  const savingTargetRef = useRef<{ projectId: string; path: string } | null>(null)
  const editorLockedRef = useRef(false)
  const syncRequestRef = useRef(0)

  const activeProject = projects.find((project) => project.id === activeProjectId)
  const localAnalysis = useMemo(() => {
    if (!['tex', 'sty', 'cls'].includes(extension(activePath))) {
      return { diagnostics: [] as Diagnostic[], outline: [] as OutlineItem[] }
    }
    const analysis = analyzeLatexAst(content, { file: activePath || undefined })
    if (activePath && activePath !== activeProject?.rootFile) {
      analysis.diagnostics = analysis.diagnostics.filter(
        (diagnostic) => diagnostic.code !== 'undefined-reference',
      )
    }
    return analysis
  }, [activePath, activeProject?.rootFile, content])
  const diagnostics = useMemo(
    () => dedupeDiagnostics([
      ...localAnalysis.diagnostics,
      ...lintDiagnostics,
      ...(compileResult?.diagnostics || []),
    ]),
    [compileResult?.diagnostics, lintDiagnostics, localAnalysis.diagnostics],
  )
  const outline = serverOutline.length ? serverOutline : localAnalysis.outline
  const errors = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length
  const warnings = diagnostics.filter((diagnostic) => diagnostic.severity === 'warning').length
  const pdfUrl = compileResult?.pdfUrl
    ? `${compileResult.pdfUrl}${compileResult.pdfUrl.includes('?') ? '&' : '?'}v=${encodeURIComponent(compileResult.compiledAt || activeProjectId)}`
    : ''

  const showToast = useCallback((message: string) => {
    setToast(message)
    window.clearTimeout(toastTimerRef.current)
    toastTimerRef.current = window.setTimeout(() => setToast(''), 2600)
  }, [])

  const closeAi = useCallback(() => setAiOpen(false), [])
  const closeNewProject = useCallback(() => setNewProjectOpen(false), [])
  const selectMobilePane = useCallback((pane: MobilePane) => {
    if (pane === 'proof') setProofOpen(true)
    setMobilePane(pane)
  }, [])

  const refreshProjects = useCallback(async () => {
    const next = await api.projects()
    setProjects(next)
    if (!activeProjectIdRef.current && next.length) {
      activeProjectIdRef.current = next[0].id
      setActiveProjectId(next[0].id)
    }
    return next
  }, [])

  const refreshTree = useCallback(async (projectId = activeProjectId) => {
    if (!projectId) return []
    const requestId = treeRequestRef.current + 1
    treeRequestRef.current = requestId
    const next = await api.tree(projectId)
    if (treeRequestRef.current === requestId && activeProjectIdRef.current === projectId) {
      setTree(next)
    }
    return next
  }, [activeProjectId])

  const saveSnapshot = useCallback((snapshot: string, version: string) => {
    const projectId = activeProjectIdRef.current
    const path = activePathRef.current
    if (!projectId || !path || !isEditable(path)) return Promise.resolve(null)

    const operation = async () => {
      const isCurrent = () => activeProjectIdRef.current === projectId && activePathRef.current === path
      if (isCurrent()) {
        setSaveState('saving')
        savingTargetRef.current = { projectId, path }
      }
      try {
        const versionAtWrite = isCurrent() ? (baseVersionRef.current || version) : version
        const saved = await api.saveFile(projectId, path, snapshot, versionAtWrite)
        if (isCurrent()) {
          baseVersionRef.current = saved.version
          setBaseVersion(saved.version)
          if (contentRef.current === snapshot) {
            dirtyRef.current = false
            setSaveState('saved')
            void clearRecoveryDraft(projectId, path).catch(() => {})
          } else {
            setSaveState('dirty')
          }
        }
        return saved
      } catch (error) {
        if (isCurrent()) {
          if (error instanceof ApiError && error.status === 409) {
            const body = error.body as { current?: ProjectFile }
            if (body.current) setConflict({ current: body.current, mine: snapshot })
            setSaveState('conflict')
          } else {
            setSaveState('error')
            showToast(error instanceof Error ? error.message : 'Save failed.')
          }
        }
        return null
      } finally {
        if (savingTargetRef.current?.projectId === projectId && savingTargetRef.current.path === path) {
          savingTargetRef.current = null
        }
      }
    }

    const queued = saveQueueRef.current.then(operation, operation)
    saveQueueRef.current = queued.then(() => null, () => null)
    return queued
  }, [showToast])

  const saveNow = useCallback(async () => {
    window.clearTimeout(saveTimerRef.current)
    if (!dirtyRef.current) return null
    return saveSnapshot(contentRef.current, baseVersionRef.current)
  }, [saveSnapshot])

  const loadFile = useCallback(async (path: string, force = false) => {
    const projectId = activeProjectIdRef.current
    if (!projectId || !path || !isEditable(path)) return
    const requestId = loadRequestRef.current + 1
    loadRequestRef.current = requestId
    editorLockedRef.current = true
    setEditorLocked(true)
    try {
      if (dirtyRef.current && !force && path !== activePathRef.current) {
        const saved = await saveNow()
        if (!saved && dirtyRef.current) return
      }
      const file = await api.readFile(projectId, path)
      const recovered = await readRecoveryDraft(projectId, path).catch(() => null)
      if (loadRequestRef.current !== requestId || activeProjectIdRef.current !== projectId) return
      setActivePath(file.path)
      activePathRef.current = file.path
      setContent(file.content)
      contentRef.current = file.content
      setBaseVersion(file.version)
      baseVersionRef.current = file.version
      setSaveState('saved')
      dirtyRef.current = false
      setDiskChanged(false)
      setConflict(null)
      setRecovery(recovered && recovered.content !== file.content ? recovered : null)
      setLintDiagnostics([])
      setServerOutline([])
    } catch (error) {
      if (loadRequestRef.current !== requestId) return
      showToast(error instanceof Error ? error.message : 'Could not open file.')
    } finally {
      if (loadRequestRef.current === requestId && activeProjectIdRef.current === projectId) {
        editorLockedRef.current = false
        setEditorLocked(false)
      }
    }
  }, [saveNow, showToast])

  const runLint = useCallback(async (snapshot = contentRef.current) => {
    const projectId = activeProjectIdRef.current
    const path = activePathRef.current
    if (!projectId || !path || !['tex', 'sty', 'cls'].includes(extension(path))) return
    try {
      const result = await api.lint(projectId, path, snapshot)
      if (
        activeProjectIdRef.current === projectId &&
        activePathRef.current === path &&
        contentRef.current === snapshot
      ) {
        const rootFile = projects.find((project) => project.id === projectId)?.rootFile
        const nextDiagnostics = path === rootFile
          ? result.diagnostics || []
          : (result.diagnostics || []).filter(
            (diagnostic) => diagnostic.source !== 'structure:document',
          )
        setLintDiagnostics(nextDiagnostics)
        setServerOutline(result.outline || [])
      }
    } catch {
      // The immediate structural parser remains active if the external linter is unavailable.
    }
  }, [projects])

  const runCompile = useCallback(async () => {
    const projectId = activeProjectIdRef.current
    if (!projectId || buildState === 'building') return
    const rootFile = projects.find((project) => project.id === projectId)?.rootFile
    const requestId = compileRequestRef.current + 1
    compileRequestRef.current = requestId
    if (dirtyRef.current) {
      const saved = await saveNow()
      if (!saved && dirtyRef.current) return
    }
    setBuildState('building')
    try {
      const result = await api.compile(projectId, rootFile)
      if (compileRequestRef.current !== requestId || activeProjectIdRef.current !== projectId) return
      setCompileResult(result)
      setBuildState(result.success ? 'success' : 'failed')
      setProofStale(!result.success && Boolean(result.pdfUrl))
      if (!result.success) {
        setBottomTab('problems')
        setBottomOpen(true)
      }
    } catch (error) {
      if (compileRequestRef.current !== requestId || activeProjectIdRef.current !== projectId) return
      setBuildState('failed')
      showToast(error instanceof Error ? error.message : 'Compile failed.')
    }
  }, [buildState, projects, saveNow, showToast])

  const exportArxivSource = useCallback(async () => {
    const projectId = activeProjectIdRef.current
    if (!projectId || sourceExporting) return
    if (dirtyRef.current) {
      const saved = await saveNow()
      if (!saved && dirtyRef.current) return
    }
    setSourceExporting(true)
    try {
      const { blob, filename } = await api.arxivSource(projectId)
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = filename
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 0)
      showToast(`Downloaded ${filename}`)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'arXiv source export failed.')
    } finally {
      setSourceExporting(false)
    }
  }, [saveNow, showToast, sourceExporting])

  useEffect(() => {
    Promise.allSettled([refreshProjects(), api.templates(), api.aiStatus(), api.systemStatus()]).then(
      ([, templateResult, aiResult, systemResult]) => {
        if (templateResult.status === 'fulfilled') setTemplates(templateResult.value)
        if (aiResult.status === 'fulfilled') setAiStatus(aiResult.value)
        if (systemResult.status === 'fulfilled') setSystemStatus(systemResult.value)
      },
    )
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!activeProjectId) return
    activeProjectIdRef.current = activeProjectId
    compileRequestRef.current += 1
    loadRequestRef.current += 1
    compiledProjectsRef.current.delete(activeProjectId)
    let cancelled = false
    setCompileResult(null)
    setBuildState('idle')
    setProofStale(false)
    refreshTree(activeProjectId).then((nextTree) => {
      if (cancelled) return
      const root = projects.find((project) => project.id === activeProjectId)?.rootFile
      const target = root || firstEditable(nextTree)
      if (target) void loadFile(target, true)
      else {
        editorLockedRef.current = false
        setEditorLocked(false)
      }
    })
    return () => { cancelled = true }
  }, [activeProjectId]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!railOpen) return
    const closeCompactRail = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && isCompactViewport()) {
        event.preventDefault()
        setRailOpen(false)
      }
    }
    document.addEventListener('keydown', closeCompactRail)
    return () => document.removeEventListener('keydown', closeCompactRail)
  }, [railOpen])

  useEffect(() => {
    if (
      !activeProjectId ||
      !activePath ||
      !baseVersion ||
      compiledProjectsRef.current.has(activeProjectId)
    ) return
    compiledProjectsRef.current.add(activeProjectId)
    const timer = window.setTimeout(() => void runCompile(), 240)
    return () => window.clearTimeout(timer)
  }, [activePath, activeProjectId, baseVersion, runCompile])

  useEffect(() => {
    if (!activeProjectId) return
    const stream = new EventSource(`/api/projects/${encodeURIComponent(activeProjectId)}/events`)
    stream.onopen = () => setDiskOnline(true)
    stream.onerror = () => setDiskOnline(false)
    const handleEvent = (event: Event) => {
      try {
        const update = JSON.parse((event as MessageEvent<string>).data) as {
          type?: string
          path?: string
          version?: string
        }
        if (update.type === 'ready') {
          setDiskOnline(true)
          return
        }
        if (!update.path) return
        if (
          savingTargetRef.current?.projectId === activeProjectId &&
          savingTargetRef.current.path === update.path
        ) return
        if (['tex', 'sty', 'cls', 'bib'].includes(extension(update.path))) {
          setProofStale(true)
          setCompileResult((previous) => previous ? { ...previous, diagnostics: [] } : previous)
          if (autoBuild) {
            window.clearTimeout(externalCompileTimerRef.current)
            externalCompileTimerRef.current = window.setTimeout(() => void runCompile(), 520)
          }
        }
        void refreshTree(activeProjectId).then((nextTree) => {
          if (update.path !== activePathRef.current) return
          if (update.type === 'delete') {
            if (dirtyRef.current) setDiskChanged(true)
            else {
              const root = projects.find((project) => project.id === activeProjectId)?.rootFile
              const target = root && root !== update.path ? root : firstEditable(nextTree)
              if (target) void loadFile(target, true)
            }
          } else if (update.version !== baseVersionRef.current) {
            if (dirtyRef.current) setDiskChanged(true)
            else void loadFile(update.path, true)
          }
        })
      } catch {
        // Ignore heartbeat or malformed development events.
      }
    }
    const eventTypes = ['ready', 'change', 'create', 'delete']
    for (const type of eventTypes) stream.addEventListener(type, handleEvent)
    stream.onmessage = handleEvent
    return () => {
      window.clearTimeout(externalCompileTimerRef.current)
      for (const type of eventTypes) stream.removeEventListener(type, handleEvent)
      stream.close()
    }
  }, [activeProjectId, autoBuild, loadFile, projects, refreshTree, runCompile])

  useEffect(() => {
    if (!activePath || !['tex', 'sty', 'cls'].includes(extension(activePath))) {
      setLintDiagnostics([])
      setServerOutline([])
      return
    }
    window.clearTimeout(lintTimerRef.current)
    lintTimerRef.current = window.setTimeout(() => void runLint(content), 420)
    return () => window.clearTimeout(lintTimerRef.current)
  }, [activePath, content, runLint])

  useEffect(() => {
    window.clearTimeout(syncTimerRef.current)
    const requestId = syncRequestRef.current + 1
    syncRequestRef.current = requestId
    if (
      !activeProjectId ||
      !activePath ||
      extension(activePath) !== 'tex' ||
      !pdfUrl ||
      proofStale ||
      buildState !== 'success'
    ) {
      setSyncTarget(null)
      return
    }
    const projectId = activeProjectId
    const path = activePath
    const rootFile = activeProject?.rootFile
    const position = { ...cursor }
    syncTimerRef.current = window.setTimeout(() => {
      void api.synctexView(projectId, {
        rootFile,
        file: path,
        line: position.line,
        column: position.column,
      }).then((target) => {
        if (
          syncRequestRef.current === requestId &&
          activeProjectIdRef.current === projectId &&
          activePathRef.current === path
        ) setSyncTarget(target)
      }).catch(() => {
        if (syncRequestRef.current === requestId) setSyncTarget(null)
      })
    }, 280)
    return () => window.clearTimeout(syncTimerRef.current)
  }, [activePath, activeProject?.rootFile, activeProjectId, buildState, cursor, pdfUrl, proofStale])

  useEffect(() => {
    const model = editorRef.current?.getModel()
    const monaco = monacoRef.current
    if (!model || !monaco) return
    const currentFileDiagnostics = diagnostics.filter(
      (diagnostic) => !diagnostic.file || diagnostic.file === activePath || basename(diagnostic.file) === basename(activePath),
    )
    monaco.editor.setModelMarkers(model, 'latex-workbench', toMonacoMarkers(monaco, currentFileDiagnostics))
  }, [activePath, diagnostics])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey
      if (modifier && event.key.toLowerCase() === 's') {
        event.preventDefault()
        void saveNow()
      }
      if (modifier && event.key === 'Enter') {
        event.preventDefault()
        void runCompile()
      }
      if (modifier && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setAiOpen((open) => !open)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!dirtyRef.current) return
      event.preventDefault()
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('beforeunload', onBeforeUnload)
    }
  }, [runCompile, saveNow])

  useEffect(() => {
    return () => {
      window.clearTimeout(saveTimerRef.current)
      window.clearTimeout(lintTimerRef.current)
      window.clearTimeout(toastTimerRef.current)
      window.clearTimeout(recoveryTimerRef.current)
      window.clearTimeout(syncTimerRef.current)
      window.clearTimeout(externalCompileTimerRef.current)
    }
  }, [])

  const onEditorMount: OnMount = (editor, monaco) => {
    editorRef.current = editor
    monacoRef.current = monaco
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, () => wrapSelection('\\textbf{', '}'))
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI, () => wrapSelection('\\textit{', '}'))
    editor.onDidChangeCursorPosition((event) => {
      setCursor({ line: event.position.lineNumber, column: event.position.column })
    })
  }

  const onEditorChange = (value = '') => {
    if (editorLockedRef.current) return
    setContent(value)
    contentRef.current = value
    dirtyRef.current = true
    setSaveState('dirty')
    setProofStale(true)
    setCompileResult((previous) => previous ? { ...previous, diagnostics: [] } : previous)
    window.clearTimeout(recoveryTimerRef.current)
    const recoveryProjectId = activeProjectIdRef.current
    const recoveryPath = activePathRef.current
    recoveryTimerRef.current = window.setTimeout(() => {
      void storeRecoveryDraft(recoveryProjectId, recoveryPath, value, baseVersionRef.current).catch(() => {})
    }, 180)
    window.clearTimeout(saveTimerRef.current)
    saveTimerRef.current = window.setTimeout(async () => {
      const saved = await saveSnapshot(value, baseVersionRef.current)
      if (saved && autoBuild && ['tex', 'sty', 'cls', 'bib'].includes(extension(activePathRef.current))) {
        window.setTimeout(() => void runCompile(), 450)
      }
    }, 650)
  }

  const wrapSelection = (before: string, after: string, placeholder = 'text') => {
    const editor = editorRef.current
    if (!editor) return
    const selection = editor.getSelection()
    if (!selection) return
    const model = editor.getModel()
    if (!model) return
    const selected = model.getValueInRange(selection) || placeholder
    editor.executeEdits('toolbar', [{ range: selection, text: `${before}${selected}${after}`, forceMoveMarkers: true }])
    editor.focus()
  }

  const insertSnippet = (snippet: string) => {
    const editor = editorRef.current
    const selection = editor?.getSelection()
    if (!editor || !selection) return
    editor.executeEdits('toolbar', [{ range: selection, text: snippet, forceMoveMarkers: true }])
    editor.focus()
  }

  const switchProject = async (projectId: string) => {
    if (!projectId || projectId === activeProjectIdRef.current) return
    if (dirtyRef.current) {
      const saved = await saveNow()
      if (!saved && dirtyRef.current) {
        showToast('Resolve the current save before switching projects.')
        return
      }
    }
    compileRequestRef.current += 1
    loadRequestRef.current += 1
    editorLockedRef.current = true
    setEditorLocked(true)
    dirtyRef.current = false
    activePathRef.current = ''
    contentRef.current = ''
    baseVersionRef.current = ''
    setActivePath('')
    setContent('')
    setBaseVersion('')
    setTree([])
    setSaveState('saved')
    activeProjectIdRef.current = projectId
    setAiResult(null)
    setAiContext(null)
    setActiveProjectId(projectId)
  }

  const jumpTo = async (item: Diagnostic | OutlineItem) => {
    let targetPath = item.file
    if (targetPath) {
      const candidates = matchingFilePaths(tree, targetPath)
      if (!candidates.includes(targetPath)) {
        if (candidates.length === 1) targetPath = candidates[0]
        else if (candidates.length > 1) {
          showToast(`More than one file is named ${basename(targetPath)}. Open the right file first.`)
          return
        }
      }
    }
    if (targetPath && targetPath !== activePath) {
      await loadFile(targetPath)
      if (activePathRef.current !== targetPath) return
    }
    window.setTimeout(() => {
      editorRef.current?.revealLineInCenter(item.line)
      editorRef.current?.setPosition({ lineNumber: item.line, column: 'column' in item ? item.column || 1 : 1 })
      editorRef.current?.focus()
    }, 80)
  }

  const handleProofPoint = useCallback(async (point: PdfPoint) => {
    const projectId = activeProjectIdRef.current
    if (!projectId) return
    const rootFile = projects.find((project) => project.id === projectId)?.rootFile
    try {
      const source = await api.synctexEdit(projectId, { rootFile, ...point })
      if (activeProjectIdRef.current !== projectId) return
      let targetPath = source.file
      const candidates = matchingFilePaths(tree, source.file)
      if (!candidates.includes(targetPath) && candidates.length === 1) targetPath = candidates[0]
      if (!isEditable(targetPath)) return
      if (targetPath !== activePathRef.current) {
        await loadFile(targetPath)
        if (activePathRef.current !== targetPath) return
      }
      window.setTimeout(() => {
        editorRef.current?.revealLineInCenter(source.line)
        editorRef.current?.setPosition({
          lineNumber: source.line,
          column: Math.max(1, source.column || 1),
        })
        editorRef.current?.focus()
      }, 80)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'No source position was found there.')
    }
  }, [loadFile, projects, showToast, tree])

  const createEntry = async (type: 'file' | 'directory') => {
    if (!activeProjectId) return
    const suggested = type === 'file' ? 'section.tex' : 'figures'
    const path = window.prompt(type === 'file' ? 'New file path' : 'New folder path', suggested)?.trim()
    if (!path) return
    try {
      await api.createEntry(activeProjectId, path, type)
      const nextTree = await refreshTree()
      if (type === 'file') await loadFile(path)
      else setTree(nextTree)
      showToast(`${type === 'file' ? 'File' : 'Folder'} created.`)
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not create entry.')
    }
  }

  const renameActive = async () => {
    if (!activeProjectId || !activePath) return
    const nextPath = window.prompt('Rename file', activePath)?.trim()
    if (!nextPath || nextPath === activePath) return
    try {
      if (dirtyRef.current) {
        const saved = await saveNow()
        if (!saved && dirtyRef.current) return
      }
      await api.renameEntry(activeProjectId, activePath, nextPath)
      await refreshTree()
      await loadFile(nextPath, true)
      showToast('File renamed.')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not rename file.')
    }
  }

  const deleteActive = async () => {
    if (!activeProjectId || !activePath || activePath === activeProject?.rootFile) return
    if (!window.confirm(`Delete ${activePath}? This cannot be undone.`)) return
    try {
      await api.deleteEntry(activeProjectId, activePath)
      const nextTree = await refreshTree()
      const nextPath = activeProject?.rootFile || firstEditable(nextTree)
      if (nextPath) await loadFile(nextPath, true)
      showToast('File deleted.')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not delete file.')
    }
  }

  const runAi = async (action: string, instruction: string, handoff = false) => {
    if (!activeProjectId || !activePath) return
    const editor = editorRef.current
    const selectionRange = editor?.getSelection()
    const selection = selectionRange && editor?.getModel()?.getValueInRange(selectionRange)
    const context: AiApplyContext = {
      projectId: activeProjectId,
      path: activePath,
      content,
      selection: selection || '',
      range: selectionRange ? {
        startLineNumber: selectionRange.startLineNumber,
        startColumn: selectionRange.startColumn,
        endLineNumber: selectionRange.endLineNumber,
        endColumn: selectionRange.endColumn,
      } : null,
    }
    const payload = {
      projectId: activeProjectId,
      path: activePath,
      action,
      instruction,
      selection: selection || '',
      content,
      diagnostics,
      selectionRange,
    }
    setAiBusy(true)
    setAiResult(null)
    try {
      const result = handoff ? await api.aiHandoff(payload) : await api.aiAction(payload)
      if (activeProjectIdRef.current !== context.projectId || activePathRef.current !== context.path) return
      setAiResult(result)
      setAiContext(context)
      if (handoff) showToast('Saved a Codex request beside the project.')
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'The writing desk could not finish.')
    } finally {
      setAiBusy(false)
    }
  }

  const applyAiResult = (replacement: string) => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model || !aiContext) return
    if (
      activeProjectIdRef.current !== aiContext.projectId ||
      activePathRef.current !== aiContext.path ||
      contentRef.current !== aiContext.content
    ) {
      showToast('The source changed after this proposal. Run the request again.')
      return
    }
    const range = aiContext.selection ? aiContext.range : model.getFullModelRange()
    if (!range) return
    if (aiContext.selection && model.getValueInRange(range) !== aiContext.selection) {
      showToast('The selected passage moved. Run the request again.')
      return
    }
    editor.executeEdits('ai-review', [{ range, text: replacement, forceMoveMarkers: true }])
    editor.focus()
    setAiResult(null)
    setAiContext(null)
    showToast('Applied. Review it in source before the next proof.')
  }

  const handleResizeStart = (event: React.PointerEvent) => {
    event.preventDefault()
    const bounds = workbenchRef.current?.getBoundingClientRect()
    if (!bounds) return
    const onMove = (moveEvent: PointerEvent) => {
      const next = ((moveEvent.clientX - bounds.left) / bounds.width) * 100
      setSplit(Math.min(72, Math.max(32, next)))
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const handleResizeKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 10 : 2
    let next: number | undefined
    if (event.key === 'ArrowLeft') next = split - step
    if (event.key === 'ArrowRight') next = split + step
    if (event.key === 'Home') next = 32
    if (event.key === 'End') next = 72
    if (next == null) return
    event.preventDefault()
    setSplit(Math.min(72, Math.max(32, next)))
  }

  const saveLabel = {
    saved: 'Saved to disk',
    dirty: 'Unsaved changes',
    saving: 'Saving…',
    conflict: 'Disk conflict',
    error: 'Save failed',
  }[saveState]

  const buildLabel = {
    idle: 'Not compiled',
    building: 'Typesetting…',
    success: proofStale ? 'Proof stale · source changed' : `Proof ready · ${formatDuration(compileResult?.durationMs)}`,
    failed: 'Compile failed',
  }[buildState]

  return (
    <div className="app-shell" data-mobile-pane={mobilePane}>
      <header className="topbar">
        <div className="brand-lockup" aria-label="Local TeX workspace">
          <div className="product-name">
            <span>TeX</span>
            <small>local</small>
          </div>
        </div>
        <div className="topbar-rule" />
        <button
          className="rail-toggle icon-button"
          onClick={() => setRailOpen((open) => !open)}
          aria-label="Toggle project navigation"
          aria-controls="project-navigation"
          aria-expanded={railOpen}
        >
          {railOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
        </button>
        <label className="project-switcher">
          <span className="sr-only">Project</span>
          <select value={activeProjectId} onChange={(event) => void switchProject(event.target.value)}>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <ChevronDown size={13} />
        </label>
        <button className="new-project-button" onClick={() => setNewProjectOpen(true)} aria-label="New project">
          <Plus size={14} /> New
        </button>

        <div className="mobile-pane-toggle" role="group" aria-label="Workspace pane">
          <button
            className={mobilePane === 'source' ? 'is-active' : ''}
            aria-pressed={mobilePane === 'source'}
            onClick={() => selectMobilePane('source')}
          >Source</button>
          <button
            className={mobilePane === 'proof' ? 'is-active' : ''}
            aria-pressed={mobilePane === 'proof'}
            onClick={() => selectMobilePane('proof')}
          >Proof</button>
        </div>

        <div className="topbar-spacer" />
        <div className="collab-state" title="Both the browser and Codex work against the same files on disk">
          <span className="avatars"><i>H</i><i><Bot size={11} /></i></span>
          <span><strong>You ↔ Codex</strong><small>{diskOnline ? 'same files · live' : 'reconnecting to disk'}</small></span>
        </div>
        <button
          className={`ai-button ${aiOpen ? 'is-active' : ''}`}
          onClick={() => aiOpen ? closeAi() : setAiOpen(true)}
          aria-label="Open writing desk"
          aria-expanded={aiOpen}
        >
          <WandSparkles size={15} /> Writing desk <kbd>⌘K</kbd>
        </button>
        <button className="compile-button" onClick={() => void runCompile()} disabled={buildState === 'building'}>
          {buildState === 'building' ? <LoaderCircle className="spin" size={15} /> : <Play size={15} />}
          Compile
          <kbd>⌘↵</kbd>
        </button>
      </header>

      <main className={`body-grid ${railOpen ? '' : 'rail-closed'}`}>
        {railOpen && (
          <button className="mobile-rail-backdrop" onClick={() => setRailOpen(false)} aria-label="Close project navigation" />
        )}
        <aside
          className="project-rail"
          id="project-navigation"
          aria-label="Project navigation"
          aria-hidden={!railOpen}
        >
          <div className="rail-tabs" role="tablist" aria-label="Project navigation view">
            <button role="tab" aria-selected={railTab === 'files'} className={railTab === 'files' ? 'is-active' : ''} onClick={() => setRailTab('files')}>Files</button>
            <button role="tab" aria-selected={railTab === 'outline'} className={railTab === 'outline' ? 'is-active' : ''} onClick={() => setRailTab('outline')}>Outline</button>
          </div>
          {railTab === 'files' ? (
            <>
              <div className="rail-heading">
                <span>SOURCE FILES</span>
                <div>
                  <button onClick={() => void createEntry('file')} title="New file"><FilePlus2 size={14} /></button>
                  <button onClick={() => void createEntry('directory')} title="New folder"><FolderPlus size={14} /></button>
                  <button onClick={() => void refreshTree()} title="Refresh"><RefreshCw size={13} /></button>
                </div>
              </div>
              <div className="rail-scroll">
                <FileTree
                  nodes={tree}
                  activePath={activePath}
                  onSelect={(node) => {
                    void loadFile(node.path)
                    if (isCompactViewport()) {
                      setRailOpen(false)
                      selectMobilePane('source')
                    }
                  }}
                />
              </div>
              <div className="file-actions">
                <button onClick={() => void renameActive()} disabled={!activePath}><MoreHorizontal size={14} /> Rename</button>
                <button onClick={() => void deleteActive()} disabled={!activePath || activePath === activeProject?.rootFile}><Trash2 size={14} /> Delete</button>
              </div>
            </>
          ) : (
            <div className="outline-list">
              {outline.length ? outline.map((item, index) => (
                <button
                  key={`${item.line}-${index}`}
                  style={{ '--outline-level': item.level } as React.CSSProperties}
                  onClick={() => {
                    void jumpTo(item)
                    if (isCompactViewport()) {
                      setRailOpen(false)
                      selectMobilePane('source')
                    }
                  }}
                >
                  <span>{item.line}</span>
                  <strong>{item.title}</strong>
                </button>
              )) : (
                <div className="rail-empty"><Heading2 size={18} /><p>Sections will form the outline.</p></div>
              )}
            </div>
          )}
          <footer className="rail-footer">
            <span className={`status-dot ${diskOnline ? 'is-live' : ''}`} />
            <span><strong>Filesystem</strong><small>{diskOnline ? 'watching external edits' : 'waiting for server'}</small></span>
          </footer>
        </aside>

        <section className={`workspace-area ${diskChanged || conflict || recovery ? 'has-banner' : ''}`}>
          {(diskChanged || conflict || recovery) && (
            <div className="conflict-banner" role="status" aria-live="polite">
              <AlertTriangle size={15} />
              <span>
                <strong>{recovery ? 'An unsaved browser draft survived.' : conflict ? 'This file changed in two places.' : 'Codex changed this file on disk.'}</strong>
                {recovery ? ' Restore it or keep the current disk version.' : conflict ? ' Choose which version should remain.' : ' Reload to see the external edit.'}
              </span>
              <button onClick={() => {
                if (recovery) {
                  void clearRecoveryDraft(activeProjectId, activePath).catch(() => {})
                  setRecovery(null)
                } else {
                  const discard = !dirtyRef.current || window.confirm('Discard the unsaved browser version and load the file from disk?')
                  if (discard) {
                    void clearRecoveryDraft(activeProjectId, activePath).catch(() => {})
                    setConflict(null)
                    setDiskChanged(false)
                    void loadFile(activePath, true)
                  }
                }
              }}>{recovery ? 'Keep disk' : 'Reload disk'}</button>
              {recovery && (
                <button onClick={() => {
                  setContent(recovery.content)
                  contentRef.current = recovery.content
                  dirtyRef.current = true
                  setSaveState('dirty')
                  setRecovery(null)
                  editorRef.current?.focus()
                }}>Restore draft</button>
              )}
              {conflict && (
                <button
                  onClick={async () => {
                    baseVersionRef.current = conflict.current.version
                    setBaseVersion(conflict.current.version)
                    setConflict(null)
                    setSaveState('dirty')
                    dirtyRef.current = true
                    await saveSnapshot(conflict.mine, conflict.current.version)
                  }}
                >Keep mine</button>
              )}
            </div>
          )}

          <div
            className={`workbench ${proofOpen ? '' : 'proof-closed'}`}
            ref={workbenchRef}
            style={{ '--source-split': `${split}%` } as React.CSSProperties}
          >
            <section className="source-panel">
              <header className="pane-header source-header">
                <div className="file-tab">
                  <Braces size={13} />
                  <span>{activePath || 'No file open'}</span>
                  {saveState === 'dirty' && <i />}
                </div>
                <div className="pane-meta">
                  <span className={`save-state ${saveState}`}>
                    {saveState === 'saving' ? <LoaderCircle className="spin" size={12} /> : saveState === 'saved' ? <Check size={12} /> : <Circle size={8} />}
                    {saveLabel}
                  </span>
                </div>
              </header>
              <nav className="format-toolbar" aria-label="LaTeX formatting">
                <button onClick={() => wrapSelection('\\textbf{', '}')} title="Bold (⌘B)"><Bold size={14} /></button>
                <button onClick={() => wrapSelection('\\textit{', '}')} title="Italic (⌘I)"><Italic size={14} /></button>
                <span />
                <button onClick={() => insertSnippet('\\section{Section title}\n')} title="Section"><Heading2 size={14} /></button>
                <button onClick={() => insertSnippet('\\begin{itemize}\n  \\item Item\n\\end{itemize}\n')} title="List"><List size={14} /></button>
                <button onClick={() => insertSnippet('\\begin{equation}\n  E = mc^2\n\\end{equation}\n')} title="Equation"><Sigma size={14} /></button>
                <button onClick={() => wrapSelection('\\begin{quote}\n', '\n\\end{quote}', 'Quotation')} title="Quote"><Quote size={14} /></button>
                <button onClick={() => wrapSelection('\\href{https://}{', '}', 'link text')} title="Link"><Link2 size={14} /></button>
                <span />
                <button onClick={() => void saveNow()} title="Save (⌘S)"><Save size={14} /></button>
                <button onClick={() => editorRef.current?.trigger('toolbar', 'actions.find', null)} title="Find"><Search size={14} /></button>
                <button onClick={() => editorRef.current?.trigger('toolbar', 'editor.action.quickCommand', null)} title="Command palette"><Command size={14} /></button>
              </nav>
              <div className="editor-wrap">
                <Editor
                  path={`${activeProjectId}/${activePath || 'main.tex'}`}
                  language={['tex', 'sty', 'cls'].includes(extension(activePath)) ? 'latex' : extension(activePath) === 'bib' ? 'bibtex' : 'plaintext'}
                  value={content}
                  beforeMount={configureLatex}
                  onMount={onEditorMount}
                  onChange={onEditorChange}
                  theme="tex-paper"
                  loading={<div className="editor-loading">Preparing source…</div>}
                  options={{
                    readOnly: editorLocked,
                    automaticLayout: true,
                    fontFamily: "'SFMono-Regular', 'SF Mono', 'Cascadia Code', Menlo, monospace",
                    fontSize: 13.5,
                    lineHeight: 22,
                    fontLigatures: true,
                    minimap: { enabled: false },
                    padding: { top: 18, bottom: 40 },
                    wordWrap: 'on',
                    wrappingIndent: 'indent',
                    scrollBeyondLastLine: false,
                    renderWhitespace: 'selection',
                    renderLineHighlight: 'gutter',
                    bracketPairColorization: { enabled: true },
                    guides: { bracketPairs: true, indentation: true },
                    suggest: { showSnippets: true },
                    quickSuggestions: { comments: false, strings: true, other: true },
                    stickyScroll: { enabled: true, maxLineCount: 3 },
                    smoothScrolling: true,
                    cursorSmoothCaretAnimation: 'on',
                    formatOnPaste: false,
                    accessibilitySupport: 'auto',
                  }}
                />
              </div>
            </section>

            {proofOpen && (
              <div
                className={`proof-spine ${buildState}`}
                role="separator"
                aria-label="Resize source and proof panes"
                aria-orientation="vertical"
                aria-valuemin={32}
                aria-valuemax={72}
                aria-valuenow={Math.round(split)}
                tabIndex={0}
                onPointerDown={handleResizeStart}
                onKeyDown={handleResizeKeyDown}
                title="Drag to resize, or use the arrow keys"
              >
                <span>SOURCE</span>
                <i><SplitSquareVertical size={12} /></i>
                <span>PROOF</span>
              </div>
            )}

            {proofOpen && (
              <section className="preview-panel">
                <header className="pane-header proof-header">
                  <div className="proof-title">
                    <span className={`build-light ${buildState}`} />
                    <strong>{buildLabel}</strong>
                    {compileResult?.pages ? <small>{compileResult.pages} pp.</small> : null}
                  </div>
                  <div className="proof-actions">
                    <label>
                      <input type="checkbox" checked={autoBuild} onChange={(event) => setAutoBuild(event.target.checked)} />
                      <span>Auto-compile</span>
                    </label>
                    <button
                      onClick={() => void exportArxivSource()}
                      disabled={!activeProjectId || sourceExporting}
                      title="Download arXiv source (.tar.gz)"
                      aria-label="Download arXiv source archive"
                    >
                      {sourceExporting ? <LoaderCircle className="spin" size={14} /> : <FileArchive size={14} />}
                    </button>
                    {compileResult?.pdfUrl && (
                      <>
                        <a href={compileResult.pdfUrl} download title="Download PDF"><Download size={14} /></a>
                        <a href={compileResult.pdfUrl} target="_blank" rel="noreferrer" title="Open proof"><ExternalLink size={14} /></a>
                      </>
                    )}
                    <button
                      onClick={() => {
                        setProofOpen(false)
                        if (isCompactViewport()) setMobilePane('source')
                      }}
                      title="Close proof"
                      aria-label="Close proof"
                    ><PanelRightClose size={14} /></button>
                  </div>
                </header>
                <div className="proof-stage">
                  <PdfPreview
                    url={pdfUrl || null}
                    buildState={buildState}
                    syncTarget={syncTarget}
                    onPointPick={(point) => void handleProofPoint(point)}
                    onRequestBuild={() => void runCompile()}
                    onError={(error) => showToast(`Proof viewer: ${error.message}`)}
                  />
                  {buildState === 'building' && (
                    <div className="build-overlay">
                      <div className="registration-bars"><i /><i /><i /><i /></div>
                      <span>Typesetting paper</span>
                    </div>
                  )}
                </div>
              </section>
            )}
            {!proofOpen && (
              <button className="restore-proof" onClick={() => setProofOpen(true)}>
                <PanelRightOpen size={15} /> Open proof
              </button>
            )}
          </div>

          <section className={`bottom-panel ${bottomOpen ? 'is-open' : ''}`}>
            <header className="bottom-header" onDoubleClick={() => setBottomOpen((open) => !open)}>
              <button className={bottomTab === 'problems' ? 'is-active' : ''} onClick={() => { setBottomTab('problems'); setBottomOpen(true) }}>
                Problems <span className={errors ? 'has-errors' : ''}>{diagnostics.length}</span>
              </button>
              <button className={bottomTab === 'log' ? 'is-active' : ''} onClick={() => { setBottomTab('log'); setBottomOpen(true) }}>
                Build log
              </button>
              <div className="bottom-summary">
                <span className="error-count"><AlertCircle size={12} /> {errors}</span>
                <span className="warning-count"><AlertTriangle size={12} /> {warnings}</span>
                <span>{buildLabel}</span>
              </div>
              <button className="icon-button" onClick={() => setBottomOpen((open) => !open)} aria-label="Toggle bottom panel">
                <ChevronDown size={15} className={bottomOpen ? '' : 'is-closed'} />
              </button>
            </header>
            {bottomOpen && (
              <div className="bottom-content">
                {bottomTab === 'problems' ? (
                  diagnostics.length ? (
                    <div className="diagnostics-list">
                      {diagnostics.map((diagnostic, index) => (
                        <button key={`${diagnostic.message}-${index}`} className={diagnostic.severity} onClick={() => void jumpTo(diagnostic)}>
                          <DiagnosticIcon severity={diagnostic.severity} />
                          <span className="diagnostic-message">{diagnostic.message}</span>
                          {diagnostic.code && <code>{diagnostic.code}</code>}
                          <span className="diagnostic-source">{diagnostic.source || 'LaTeX'}</span>
                          <span className="diagnostic-location">{diagnostic.file ? `${basename(diagnostic.file)}:` : ''}{diagnostic.line}:{diagnostic.column || 1}</span>
                        </button>
                      ))}
                    </div>
                  ) : (
                    <div className="clean-state"><Check size={15} /><span>No structural, ChkTeX, or compiler problems.</span></div>
                  )
                ) : (
                  <pre className="build-log">{compileResult?.log || 'Compile the project to inspect the exact XeLaTeX log.'}</pre>
                )}
              </div>
            )}
          </section>

          <footer className="statusbar">
            <span><Braces size={11} /> {activePath ? extension(activePath).toUpperCase() : '—'}</span>
            <span>Ln {cursor.line}, Col {cursor.column}</span>
            <span>UTF-8</span>
            <span>XeLaTeX</span>
            <span className="status-spacer" />
            <span title="Compiler tools detected">
              {Boolean(systemStatus.latexmk) && Boolean(systemStatus.chktex) ? <Check size={11} /> : <AlertTriangle size={11} />}
              Parser + lint
            </span>
            <button onClick={() => setAiOpen(true)} aria-label="Open writing desk"><MessageSquareText size={11} /> Writing desk</button>
          </footer>
        </section>
      </main>

      {aiOpen && (
        <AiDrawer
          onClose={closeAi}
          status={aiStatus}
          busy={aiBusy}
          result={aiResult}
          resultScope={aiContext?.selection ? 'selection' : 'file'}
          onRun={(action, instruction) => runAi(action, instruction, false)}
          onHandoff={(action, instruction) => runAi(action, instruction, true)}
          onApply={applyAiResult}
        />
      )}

      {newProjectOpen && (
        <NewProjectDialog
          templates={templates}
          onClose={closeNewProject}
          onCreate={async (name, template) => {
            if (dirtyRef.current) {
              const saved = await saveNow()
              if (!saved && dirtyRef.current) return
            }
            const project = await api.createProject(name, template)
            await refreshProjects()
            await switchProject(project.id)
            setNewProjectOpen(false)
            showToast('Project created from template.')
          }}
        />
      )}

      {toast && <div className="toast" role="status"><Check size={14} />{toast}</div>}
    </div>
  )
}

export default App

export type Severity = 'error' | 'warning' | 'info'

export interface Diagnostic {
  file?: string
  line: number
  column?: number
  endLine?: number
  endColumn?: number
  severity: Severity
  code?: string | number
  message: string
  source?: string
}

export interface OutlineItem {
  kind: 'part' | 'chapter' | 'section' | 'subsection' | 'subsubsection' | 'label'
  title: string
  line: number
  level: number
  file?: string
}

export interface FileNode {
  name: string
  path: string
  type: 'file' | 'directory'
  children?: FileNode[]
  size?: number
}

export interface Project {
  id: string
  name: string
  rootFile: string
  template?: string
  updatedAt?: string
  path?: string
}

export interface Template {
  id: string
  name: string
  description: string
  accent?: string
  rootFile?: string
  files?: number
}

export interface ProjectFile {
  path: string
  content: string
  version: string
  mtime?: number | string
}

export interface CompileResult {
  success: boolean
  pdfUrl?: string
  diagnostics: Diagnostic[]
  log: string
  durationMs?: number
  pages?: number
  compiledAt?: string
}

export interface AiStatus {
  available: boolean
  provider?: string
  model?: string
  handoffAvailable?: boolean
}

export interface AiResult {
  title?: string
  explanation?: string
  replacement?: string
  content?: string
  output?: string
  requestId?: string
  path?: string
  [key: string]: unknown
}

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

export class ApiError extends Error {
  status: number
  body: unknown

  constructor(message: string, status: number, body?: unknown) {
    super(message)
    this.status = status
    this.body = body
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...init?.headers,
    },
  })
  const contentType = response.headers.get('content-type') || ''
  let body: unknown
  try {
    body = contentType.includes('application/json')
      ? await response.json()
      : await response.text()
  } catch {
    body = null
  }
  if (!response.ok) {
    const errorValue = typeof body === 'object' && body && 'error' in body
      ? (body as { error: unknown }).error
      : null
    const message = typeof errorValue === 'object' && errorValue && 'message' in errorValue
      ? String((errorValue as { message: unknown }).message)
      : typeof errorValue === 'string'
        ? errorValue
        : `Request failed (${response.status})`
    throw new ApiError(message, response.status, body)
  }
  return body as T
}

async function downloadRequest(url: string) {
  const response = await fetch(url)
  if (!response.ok) {
    const contentType = response.headers.get('content-type') || ''
    let body: unknown
    try {
      body = contentType.includes('application/json') ? await response.json() : await response.text()
    } catch {
      body = null
    }
    const errorValue = typeof body === 'object' && body && 'error' in body
      ? (body as { error: unknown }).error
      : null
    const message = typeof errorValue === 'object' && errorValue && 'message' in errorValue
      ? String((errorValue as { message: unknown }).message)
      : `Download failed (${response.status})`
    throw new ApiError(message, response.status, body)
  }
  const disposition = response.headers.get('content-disposition') || ''
  const filename = disposition.match(/filename="?([^";]+)"?/i)?.[1] || 'arxiv-source.tar.gz'
  return { blob: await response.blob(), filename }
}

const projectUrl = (projectId: string, suffix = '') =>
  `/api/projects/${encodeURIComponent(projectId)}${suffix}`

export const api = {
  async health() {
    return request<{ ok: boolean; version?: string }>('/api/health')
  },

  async systemStatus() {
    return request<{
      latexmk?: boolean
      xelatex?: boolean
      chktex?: boolean
      synctex?: boolean
      workspacePath?: string
    }>('/api/system/status')
  },

  async templates() {
    const data = await request<{ templates: Template[] }>('/api/templates')
    return data.templates
  },

  async projects() {
    const data = await request<{ projects: Project[] }>('/api/projects')
    return data.projects
  },

  async createProject(name: string, template: string) {
    const data = await request<{ project: Project }>('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name, template }),
    })
    return data.project
  },

  async tree(projectId: string) {
    const data = await request<{ tree: FileNode[] }>(projectUrl(projectId, '/tree'))
    return data.tree
  },

  async readFile(projectId: string, path: string) {
    return request<ProjectFile>(
      `${projectUrl(projectId, '/file')}?path=${encodeURIComponent(path)}`,
    )
  },

  async saveFile(projectId: string, path: string, content: string, baseVersion: string) {
    return request<ProjectFile>(projectUrl(projectId, '/file'), {
      method: 'PUT',
      body: JSON.stringify({ path, content, baseVersion }),
    })
  },

  async createEntry(projectId: string, path: string, type: 'file' | 'directory') {
    return request<{ path: string }>(projectUrl(projectId, '/files'), {
      method: 'POST',
      body: JSON.stringify({ path, type }),
    })
  },

  async renameEntry(projectId: string, path: string, newPath: string) {
    return request<{ path: string }>(projectUrl(projectId, '/file'), {
      method: 'PATCH',
      body: JSON.stringify({ path, newPath }),
    })
  },

  async deleteEntry(projectId: string, path: string) {
    return request<{ ok: boolean }>(
      `${projectUrl(projectId, '/file')}?path=${encodeURIComponent(path)}`,
      { method: 'DELETE' },
    )
  },

  async lint(projectId: string, path: string, content: string) {
    return request<{ diagnostics: Diagnostic[]; outline: OutlineItem[] }>(
      projectUrl(projectId, '/lint'),
      {
        method: 'POST',
        body: JSON.stringify({ path, content }),
      },
    )
  },

  async compile(projectId: string, rootFile?: string) {
    return request<CompileResult>(projectUrl(projectId, '/compile'), {
      method: 'POST',
      body: JSON.stringify({ rootFile }),
    })
  },

  async arxivSource(projectId: string) {
    return downloadRequest(projectUrl(projectId, '/export/arxiv'))
  },

  async synctexView(
    projectId: string,
    payload: { rootFile?: string; file: string; line: number; column?: number },
  ) {
    return request<{ page: number; x: number; y: number; width?: number; height?: number }>(
      projectUrl(projectId, '/synctex/view'),
      { method: 'POST', body: JSON.stringify(payload) },
    )
  },

  async synctexEdit(
    projectId: string,
    payload: { rootFile?: string; page: number; x: number; y: number },
  ) {
    return request<{ file: string; line: number; column: number }>(
      projectUrl(projectId, '/synctex/edit'),
      { method: 'POST', body: JSON.stringify(payload) },
    )
  },

  async outline(projectId: string) {
    return request<{ outline: OutlineItem[] }>(projectUrl(projectId, '/outline'))
  },

  async aiStatus() {
    return request<AiStatus>('/api/ai/status')
  },

  async aiAction(payload: Record<string, unknown>) {
    return request<AiResult>('/api/ai/action', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },

  async aiHandoff(payload: Record<string, unknown>) {
    return request<AiResult>('/api/ai/handoff', {
      method: 'POST',
      body: JSON.stringify(payload),
    })
  },
}

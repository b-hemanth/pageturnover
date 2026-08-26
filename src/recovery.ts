export interface RecoveryDraft {
  key: string
  projectId: string
  path: string
  content: string
  baseVersion: string
  updatedAt: number
}

const DATABASE = 'pageturnover-recovery'
const STORE = 'drafts'

function key(projectId: string, path: string) {
  return `${projectId}:${path}`
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE, { keyPath: 'key' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

export async function storeRecoveryDraft(
  projectId: string,
  path: string,
  content: string,
  baseVersion: string,
) {
  if (!projectId || !path || !('indexedDB' in globalThis)) return
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite')
    transaction.objectStore(STORE).put({
      key: key(projectId, path),
      projectId,
      path,
      content,
      baseVersion,
      updatedAt: Date.now(),
    } satisfies RecoveryDraft)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  database.close()
}

export async function readRecoveryDraft(projectId: string, path: string) {
  if (!projectId || !path || !('indexedDB' in globalThis)) return null
  const database = await openDatabase()
  const result = await new Promise<RecoveryDraft | undefined>((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readonly')
    const request = transaction.objectStore(STORE).get(key(projectId, path))
    request.onsuccess = () => resolve(request.result as RecoveryDraft | undefined)
    request.onerror = () => reject(request.error)
  })
  database.close()
  return result || null
}

export async function clearRecoveryDraft(projectId: string, path: string) {
  if (!projectId || !path || !('indexedDB' in globalThis)) return
  const database = await openDatabase()
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE, 'readwrite')
    transaction.objectStore(STORE).delete(key(projectId, path))
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
  database.close()
}

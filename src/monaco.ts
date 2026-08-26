import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api'

;(globalThis as typeof globalThis & {
  MonacoEnvironment?: { getWorker: () => Worker }
}).MonacoEnvironment = {
  getWorker: () => new Worker(
    new URL('../node_modules/monaco-editor/esm/vs/editor/editor.worker.js', import.meta.url),
    { type: 'module' },
  ),
}

loader.config({ monaco })

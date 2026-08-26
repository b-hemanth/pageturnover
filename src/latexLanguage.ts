import type { Monaco } from '@monaco-editor/react'
import type { editor, Position } from 'monaco-editor'
import type { Diagnostic, OutlineItem } from './types'

const commands = [
  ['section', 'Section', '\\section{${1:Title}}'],
  ['subsection', 'Subsection', '\\subsection{${1:Title}}'],
  ['textbf', 'Bold text', '\\textbf{${1:text}}'],
  ['textit', 'Italic text', '\\textit{${1:text}}'],
  ['emph', 'Emphasised text', '\\emph{${1:text}}'],
  ['cite', 'Citation', '\\cite{${1:key}}'],
  ['autoref', 'Automatic reference', '\\autoref{${1:label}}'],
  ['label', 'Label', '\\label{${1:sec:key}}'],
  ['footnote', 'Footnote', '\\footnote{${1:text}}'],
  ['includegraphics', 'Image', '\\includegraphics[width=${1:\\linewidth}]{${2:path}}'],
  ['url', 'URL', '\\url{${1:https://}}'],
]

const environments = [
  ['itemize', '\\begin{itemize}\n\t\\item ${1:item}\n\\end{itemize}'],
  ['enumerate', '\\begin{enumerate}\n\t\\item ${1:item}\n\\end{enumerate}'],
  ['equation', '\\begin{equation}\n\t${1:E = mc^2}\n\\end{equation}'],
  ['align', '\\begin{align}\n\t${1:a} &= ${2:b} \\\\\n\\end{align}'],
  ['figure', '\\begin{figure}[htbp]\n\t\\centering\n\t\\includegraphics[width=.8\\linewidth]{${1:path}}\n\t\\caption{${2:Caption}}\n\t\\label{fig:${3:key}}\n\\end{figure}'],
  ['table', '\\begin{table}[htbp]\n\t\\centering\n\t\\caption{${1:Caption}}\n\t\\begin{tabular}{${2:ll}}\n\t\t${3:Column A} & ${4:Column B} \\\\\n\t\\end{tabular}\n\\end{table}'],
  ['quote', '\\begin{quote}\n\t${1:Quotation}\n\\end{quote}'],
]

let configured = false

export function configureLatex(monaco: Monaco) {
  if (configured) return
  if (!monaco.languages.getLanguages().some((language: { id: string }) => language.id === 'latex')) {
    monaco.languages.register({
      id: 'latex',
      extensions: ['.tex', '.sty', '.cls'],
      aliases: ['LaTeX', 'latex', 'TeX'],
    })
  }

  monaco.languages.setLanguageConfiguration('latex', {
    comments: { lineComment: '%' },
    brackets: [
      ['{', '}'],
      ['[', ']'],
      ['(', ')'],
    ],
    autoClosingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '(', close: ')' },
      { open: '$', close: '$' },
    ],
    surroundingPairs: [
      { open: '{', close: '}' },
      { open: '[', close: ']' },
      { open: '$', close: '$' },
    ],
    folding: {
      markers: {
        start: /^\s*%\s*#?region\b|\\begin\{[^}]+\}/,
        end: /^\s*%\s*#?endregion\b|\\end\{[^}]+\}/,
      },
    },
    indentationRules: {
      increaseIndentPattern: /\\begin\{(?!document)[^}]+\}|\{\s*$/,
      decreaseIndentPattern: /\\end\{(?!document)[^}]+\}|^\s*\}/,
    },
  })

  monaco.languages.setMonarchTokensProvider('latex', {
    defaultToken: '',
    tokenPostfix: '.latex',
    tokenizer: {
      root: [
        [/%.*$/, 'comment'],
        [/\\(?:begin|end)(?=\{)/, { token: 'keyword.control' }],
        [/\\(?:documentclass|usepackage|RequirePackage|newcommand|renewcommand)\b/, 'keyword.declaration'],
        [/\\(?:part|chapter|section|subsection|subsubsection|paragraph|title|author|date)\*?\b/, 'type.identifier'],
        [/\\(?:label|ref|eqref|autoref|pageref|cite|parencite|textcite)\b/, 'annotation'],
        [/\\[a-zA-Z@]+\*?/, 'keyword'],
        [/\\./, 'keyword'],
        [/\$\$?/, { token: 'string.quote', next: '@math' }],
        [/[{}[\]]/, '@brackets'],
        [/&/, 'delimiter'],
        [/#\d/, 'variable'],
      ],
      math: [
        [/%.*$/, 'comment'],
        [/\\[a-zA-Z]+/, 'keyword.math'],
        [/\d+(?:\.\d+)?/, 'number'],
        [/[=+\-*/_^<>]/, 'operator'],
        [/\$\$?/, { token: 'string.quote', next: '@pop' }],
        [/[{}[\]()]/, '@brackets'],
      ],
    },
  })

  monaco.editor.defineTheme('tex-paper', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '77716C', fontStyle: 'italic' },
      { token: 'keyword', foreground: '7B1E2B' },
      { token: 'keyword.control', foreground: '5E0E1B', fontStyle: 'bold' },
      { token: 'keyword.declaration', foreground: '815B22' },
      { token: 'keyword.math', foreground: '1F4F7A' },
      { token: 'type.identifier', foreground: '282523', fontStyle: 'bold' },
      { token: 'annotation', foreground: '315F86' },
      { token: 'number', foreground: '8D4A24' },
      { token: 'operator', foreground: '3E3A37' },
      { token: 'string.quote', foreground: '7B1E2B' },
      { token: 'variable', foreground: '9A3A2E' },
    ],
    colors: {
      'editor.background': '#FBFAF7',
      'editor.foreground': '#282523',
      'editorLineNumber.foreground': '#AAA39C',
      'editorLineNumber.activeForeground': '#5E0E1B',
      'editorCursor.foreground': '#B31B34',
      'editor.selectionBackground': '#DCE8F2',
      'editor.inactiveSelectionBackground': '#EAE6E1',
      'editor.lineHighlightBackground': '#F1EEE9',
      'editorIndentGuide.background1': '#E4DFD8',
      'editorIndentGuide.activeBackground1': '#B9B0A7',
      'editorBracketMatch.background': '#F1DDE1',
      'editorBracketMatch.border': '#B31B34',
      'editorGutter.background': '#F7F5F1',
      'editorWidget.background': '#FFFDF9',
      'editorSuggestWidget.background': '#FFFDF9',
      'editorSuggestWidget.border': '#C9C1B8',
      'editorSuggestWidget.selectedBackground': '#F1DDE1',
    },
  })

  monaco.languages.registerCompletionItemProvider('latex', {
    triggerCharacters: ['\\'],
    provideCompletionItems(model: editor.ITextModel, position: Position) {
      const word = model.getWordUntilPosition(position)
      const slashRange = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: Math.max(1, word.startColumn - 1),
        endColumn: word.startColumn,
      }
      const startsWithSlash = word.startColumn > 1 && model.getValueInRange(slashRange) === '\\'
      const range = {
        startLineNumber: position.lineNumber,
        endLineNumber: position.lineNumber,
        startColumn: startsWithSlash ? word.startColumn - 1 : word.startColumn,
        endColumn: word.endColumn,
      }
      const commandSuggestions = commands.map(([label, detail, insertText]) => ({
        label: `\\${label}`,
        kind: monaco.languages.CompletionItemKind.Function,
        detail,
        insertText: `\\${insertText.slice(1)}`,
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        range,
      }))
      const environmentSuggestions = environments.map(([label, insertText]) => ({
        label: `begin:${label}`,
        kind: monaco.languages.CompletionItemKind.Snippet,
        detail: `${label} environment`,
        insertText,
        insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
        range,
      }))
      return { suggestions: [...commandSuggestions, ...environmentSuggestions] }
    },
  })
  configured = true
}

function lineAndColumn(content: string, offset: number) {
  const before = content.slice(0, offset)
  const lines = before.split('\n')
  return { line: lines.length, column: lines.at(-1)!.length + 1 }
}

export function analyzeLatex(content: string): {
  diagnostics: Diagnostic[]
  outline: OutlineItem[]
} {
  const diagnostics: Diagnostic[] = []
  const outline: OutlineItem[] = []
  const clean = content.replace(/(?<!\\)%.*$/gm, (match) => ' '.repeat(match.length))
  const braces: Array<{ char: string; offset: number }> = []
  const environments: Array<{ name: string; offset: number }> = []
  const labels = new Map<string, number>()
  const refs: Array<{ key: string; offset: number }> = []

  for (let index = 0; index < clean.length; index += 1) {
    const char = clean[index]
    if ((char === '{' || char === '[') && clean[index - 1] !== '\\') {
      braces.push({ char, offset: index })
    } else if ((char === '}' || char === ']') && clean[index - 1] !== '\\') {
      const expected = char === '}' ? '{' : '['
      const last = braces.at(-1)
      if (!last || last.char !== expected) {
        const at = lineAndColumn(clean, index)
        diagnostics.push({ ...at, severity: 'error', message: `Unexpected “${char}”.`, source: 'parser' })
      } else {
        braces.pop()
      }
    }
  }
  braces.forEach(({ char, offset }) => {
    const at = lineAndColumn(clean, offset)
    diagnostics.push({
      ...at,
      severity: 'error',
      message: `Unclosed “${char}”.`,
      source: 'parser',
    })
  })

  const environmentPattern = /\\(begin|end)\{([^}]+)\}/g
  for (const match of clean.matchAll(environmentPattern)) {
    const [, action, name] = match
    const offset = match.index ?? 0
    if (action === 'begin') {
      environments.push({ name, offset })
    } else {
      const open = environments.at(-1)
      if (!open || open.name !== name) {
        const at = lineAndColumn(clean, offset)
        diagnostics.push({
          ...at,
          severity: 'error',
          message: open
            ? `Expected \\end{${open.name}} before \\end{${name}}.`
            : `No matching \\begin{${name}}.`,
          source: 'parser',
        })
      } else {
        environments.pop()
      }
    }
  }
  environments.forEach(({ name, offset }) => {
    const at = lineAndColumn(clean, offset)
    diagnostics.push({
      ...at,
      severity: 'error',
      message: `Missing \\end{${name}}.`,
      source: 'parser',
    })
  })

  const sectionPattern = /\\(part|chapter|section|subsection|subsubsection)\*?\{([^}]*)\}/g
  const levels: Record<string, number> = {
    part: 0,
    chapter: 0,
    section: 1,
    subsection: 2,
    subsubsection: 3,
  }
  for (const match of clean.matchAll(sectionPattern)) {
    outline.push({
      kind: match[1] as OutlineItem['kind'],
      title: match[2].trim() || 'Untitled section',
      line: lineAndColumn(clean, match.index ?? 0).line,
      level: levels[match[1]],
    })
  }

  for (const match of clean.matchAll(/\\label\{([^}]+)\}/g)) {
    const key = match[1]
    const offset = match.index ?? 0
    if (labels.has(key)) {
      const at = lineAndColumn(clean, offset)
      diagnostics.push({
        ...at,
        severity: 'warning',
        message: `Duplicate label “${key}”.`,
        source: 'parser',
      })
    } else {
      labels.set(key, offset)
    }
  }
  for (const match of clean.matchAll(/\\(?:ref|eqref|autoref|pageref)\{([^}]+)\}/g)) {
    refs.push({ key: match[1], offset: match.index ?? 0 })
  }
  refs.forEach(({ key, offset }) => {
    if (!labels.has(key)) {
      const at = lineAndColumn(clean, offset)
      diagnostics.push({
        ...at,
        severity: 'info',
        message: `Reference “${key}” is not defined in this file.`,
        source: 'parser',
      })
    }
  })

  return { diagnostics, outline }
}

export function toMonacoMarkers(
  monaco: Monaco,
  diagnostics: Diagnostic[],
) {
  return diagnostics.map((diagnostic) => ({
    startLineNumber: Math.max(1, diagnostic.line || 1),
    startColumn: Math.max(1, diagnostic.column || 1),
    endLineNumber: Math.max(1, diagnostic.endLine || diagnostic.line || 1),
    endColumn: Math.max(2, diagnostic.endColumn || (diagnostic.column || 1) + 1),
    message: diagnostic.message,
    code: diagnostic.code == null ? undefined : String(diagnostic.code),
    source: diagnostic.source || 'LaTeX',
    severity:
      diagnostic.severity === 'error'
        ? monaco.MarkerSeverity.Error
        : diagnostic.severity === 'warning'
          ? monaco.MarkerSeverity.Warning
          : monaco.MarkerSeverity.Info,
  }))
}

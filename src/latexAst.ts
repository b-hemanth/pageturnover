import { processLatexToAstViaUnified } from '@unified-latex/unified-latex'
import type { Diagnostic, OutlineItem } from './types'

/**
 * Optional context for single-source analysis. `knownLabels` is useful when the
 * caller has already indexed labels from the other files in a project.
 */
export interface LatexAstAnalysisOptions {
  file?: string
  knownLabels?: Iterable<string>
}

export interface LatexAstAnalysis {
  outline: OutlineItem[]
  diagnostics: Diagnostic[]
}

interface SourcePoint {
  offset: number
  line: number
  column: number
}

interface SourcePosition {
  start: SourcePoint
  end: SourcePoint
}

interface AstArgumentLike {
  type: 'argument'
  openMark?: string
  closeMark?: string
  content?: unknown[]
}

interface AstNodeLike {
  type: string
  env?: string
  content?: string | unknown[]
  args?: AstArgumentLike[]
  position?: SourcePosition
  _renderInfo?: {
    namedArguments?: Array<string | null>
  }
}

interface LocatedDiagnostic extends Diagnostic {
  offset: number
}

interface LocatedMacro {
  node: AstNodeLike
  key: string
  offset: number
}

interface EnvironmentEntry {
  name: string
  offset: number
}

const parser = processLatexToAstViaUnified()

const outlineLevels: Record<OutlineItem['kind'], number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  label: 5,
}

const outlineCommands = new Set<OutlineItem['kind']>([
  'part',
  'chapter',
  'section',
  'subsection',
  'subsubsection',
])

const referenceCommands = new Set([
  'ref',
  'eqref',
  'autoref',
  'pageref',
  'nameref',
  'vref',
  'Vref',
  'cref',
  'Cref',
  'cpageref',
  'Cpageref',
])

const commaSeparatedReferenceCommands = new Set([
  'cref',
  'Cref',
  'cpageref',
  'Cpageref',
])

// Descendants of definitions are not live document structure until the macro is
// expanded, so treating them as headings/references would create false positives.
const primitiveDefinitionCommands = new Set([
  'def',
  'edef',
  'gdef',
  'xdef',
])

const definitionCommands = new Set([
  'newcommand',
  'renewcommand',
  'providecommand',
  'DeclareRobustCommand',
  'NewDocumentCommand',
  'RenewDocumentCommand',
  'ProvideDocumentCommand',
  'DeclareDocumentCommand',
  'newenvironment',
  'renewenvironment',
  'NewDocumentEnvironment',
  'RenewDocumentEnvironment',
])

const verbatimEnvironments = new Set([
  'verbatim',
  'verbatim*',
  'Verbatim',
  'BVerbatim',
  'LVerbatim',
  'SaveVerbatim',
  'lstlisting',
  'minted',
  'pycode',
  'luacode',
  'luacode*',
  'comment',
  'filecontents',
  'filecontents*',
])

const visibleMacroNames: Record<string, string> = {
  LaTeX: 'LaTeX',
  TeX: 'TeX',
  '&': '&',
  '%': '%',
  '#': '#',
  _: '_',
  '$': '$',
  '{': '{',
  '}': '}',
  textbackslash: '\\',
  ldots: '…',
  dots: '…',
}

function isAstNode(value: unknown): value is AstNodeLike {
  return Boolean(value) && typeof value === 'object' && typeof (value as AstNodeLike).type === 'string'
}

function walkAst(value: unknown, visitor: (node: AstNodeLike) => void): void {
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const child = value[index]
      if (
        isAstNode(child)
        && child.type === 'macro'
        && typeof child.content === 'string'
        && primitiveDefinitionCommands.has(child.content)
      ) {
        visitor(child)
        // Primitive \def-like commands do not receive attached AST arguments.
        // Their replacement group is a following sibling, so skip through it.
        for (let bodyIndex = index + 1; bodyIndex < value.length; bodyIndex += 1) {
          if (isAstNode(value[bodyIndex]) && value[bodyIndex].type === 'group') {
            index = bodyIndex
            break
          }
        }
        continue
      }
      walkAst(child, visitor)
    }
    return
  }
  if (!isAstNode(value)) return

  visitor(value)

  if (value.type === 'macro' && typeof value.content === 'string' && definitionCommands.has(value.content)) {
    return
  }
  if ((value.type === 'environment' || value.type === 'mathenv') && value.env && verbatimEnvironments.has(value.env)) {
    return
  }

  value.args?.forEach((argument) => walkAst(argument, visitor))
  if (Array.isArray(value.content)) walkAst(value.content, visitor)
}

function argumentPlainText(argument: AstArgumentLike | undefined): string {
  return plainText(argument?.content || [])
}

function nonEmptyArguments(node: AstNodeLike): AstArgumentLike[] {
  return (node.args || []).filter((argument) => argumentPlainText(argument).trim().length > 0)
}

function mandatoryArguments(node: AstNodeLike): AstArgumentLike[] {
  return (node.args || []).filter((argument) => argument.openMark === '{')
}

function namedArgument(node: AstNodeLike, name: string): AstArgumentLike | undefined {
  const index = node._renderInfo?.namedArguments?.indexOf(name) ?? -1
  return index >= 0 ? node.args?.[index] : undefined
}

function plainText(value: unknown): string {
  if (Array.isArray(value)) return value.map(plainText).join('')
  if (!isAstNode(value)) return typeof value === 'string' ? value : ''

  if (value.type === 'string') return typeof value.content === 'string' ? value.content : ''
  if (value.type === 'whitespace' || value.type === 'parbreak') return ' '
  if (value.type === 'comment') return ''
  if (value.type === 'verb' || value.type === 'verbatim') {
    return typeof value.content === 'string' ? value.content : ''
  }

  if (value.type === 'macro' && typeof value.content === 'string') {
    const macroName = value.content
    if (macroName === 'label' || macroName === 'index') return ''
    if (macroName === 'texorpdfstring') {
      return argumentPlainText(mandatoryArguments(value)[0])
    }
    const argumentsWithText = nonEmptyArguments(value)
    if (argumentsWithText.length > 0) return argumentPlainText(argumentsWithText.at(-1))
    return visibleMacroNames[macroName] ?? macroName
  }

  return Array.isArray(value.content) ? plainText(value.content) : ''
}

function cleanTitle(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function macroArgument(node: AstNodeLike, preferredName?: string): AstArgumentLike | undefined {
  if (preferredName) {
    const preferred = namedArgument(node, preferredName)
    if (preferred) return preferred
  }
  return mandatoryArguments(node).at(-1)
}

function firstPosition(value: unknown): SourcePosition | undefined {
  if (Array.isArray(value)) {
    for (const child of value) {
      const position = firstPosition(child)
      if (position) return position
    }
    return undefined
  }
  if (!isAstNode(value)) return undefined
  if (value.position) return value.position
  if (value.args) {
    const argumentPosition = firstPosition(value.args)
    if (argumentPosition) return argumentPosition
  }
  return Array.isArray(value.content) ? firstPosition(value.content) : undefined
}

function lastPosition(value: unknown): SourcePosition | undefined {
  if (Array.isArray(value)) {
    for (let index = value.length - 1; index >= 0; index -= 1) {
      const position = lastPosition(value[index])
      if (position) return position
    }
    return undefined
  }
  if (!isAstNode(value)) return undefined
  if (value.args) {
    const argumentPosition = lastPosition(value.args)
    if (argumentPosition) return argumentPosition
  }
  if (Array.isArray(value.content)) {
    const contentPosition = lastPosition(value.content)
    if (contentPosition) return contentPosition
  }
  return value.position
}

function argumentKey(argument: AstArgumentLike | undefined): string {
  return cleanTitle(plainText(argument?.content || []))
}

function createLineStarts(source: string): number[] {
  const starts = [0]
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') starts.push(index + 1)
  }
  return starts
}

function pointAt(source: string, lineStarts: number[], rawOffset: number): SourcePoint {
  const offset = Math.max(0, Math.min(source.length, rawOffset))
  let low = 0
  let high = lineStarts.length
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2)
    if (lineStarts[middle] <= offset) low = middle
    else high = middle
  }
  return { offset, line: low + 1, column: offset - lineStarts[low] + 1 }
}

function nodeStart(node: AstNodeLike, source: string, lineStarts: number[]): SourcePoint {
  return node.position?.start || firstPosition(node)?.start || pointAt(source, lineStarts, 0)
}

function nodeEnd(node: AstNodeLike, source: string, lineStarts: number[]): SourcePoint {
  return lastPosition(node)?.end || node.position?.end || nodeStart(node, source, lineStarts)
}

function locatedDiagnostic(
  source: string,
  lineStarts: number[],
  offset: number,
  endOffset: number,
  severity: Diagnostic['severity'],
  code: string,
  message: string,
  file?: string,
): LocatedDiagnostic {
  const start = pointAt(source, lineStarts, offset)
  const end = pointAt(source, lineStarts, Math.max(offset + 1, endOffset))
  return {
    offset: start.offset,
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: end.column,
    severity,
    code,
    message,
    source: 'unified-latex',
    ...(file ? { file } : {}),
  }
}

function macroDiagnostic(
  source: string,
  lineStarts: number[],
  macro: AstNodeLike,
  severity: Diagnostic['severity'],
  code: string,
  message: string,
  file?: string,
): LocatedDiagnostic {
  const start = nodeStart(macro, source, lineStarts)
  const end = nodeEnd(macro, source, lineStarts)
  return locatedDiagnostic(source, lineStarts, start.offset, end.offset, severity, code, message, file)
}

function readControlSequence(source: string, offset: number): { name: string; end: number } | undefined {
  if (source[offset] !== '\\' || offset + 1 >= source.length) return undefined
  const first = source[offset + 1]
  if (!/[A-Za-z@]/.test(first)) return { name: first, end: offset + 2 }
  let end = offset + 2
  while (end < source.length && /[A-Za-z@]/.test(source[end])) end += 1
  return { name: source.slice(offset + 1, end), end }
}

function skipWhitespaceAndComments(source: string, offset: number): number {
  let cursor = offset
  while (cursor < source.length) {
    if (/\s/.test(source[cursor])) {
      cursor += 1
      continue
    }
    if (source[cursor] === '%') {
      const newline = source.indexOf('\n', cursor + 1)
      cursor = newline < 0 ? source.length : newline + 1
      continue
    }
    break
  }
  return cursor
}

function readSimpleGroup(source: string, offset: number): { value: string; end: number } | undefined {
  const start = skipWhitespaceAndComments(source, offset)
  if (source[start] !== '{') return undefined
  let depth = 1
  let cursor = start + 1
  while (cursor < source.length) {
    if (source[cursor] === '\\') {
      const command = readControlSequence(source, cursor)
      if (command) {
        cursor = command.end
        continue
      }
    }
    if (source[cursor] === '%') {
      const newline = source.indexOf('\n', cursor + 1)
      cursor = newline < 0 ? source.length : newline + 1
      continue
    }
    if (source[cursor] === '{') depth += 1
    if (source[cursor] === '}') {
      depth -= 1
      if (depth === 0) return { value: source.slice(start + 1, cursor), end: cursor + 1 }
    }
    cursor += 1
  }
  return undefined
}

function fallbackMacroArgument(source: string, node: AstNodeLike): string {
  const end = node.position?.end.offset
  if (end == null) return ''
  let cursor = skipWhitespaceAndComments(source, end)
  if (source[cursor] === '*') cursor = skipWhitespaceAndComments(source, cursor + 1)
  while (source[cursor] === '[') {
    let depth = 1
    cursor += 1
    while (cursor < source.length && depth > 0) {
      if (source[cursor] === '\\') {
        const command = readControlSequence(source, cursor)
        if (command) {
          cursor = command.end
          continue
        }
      }
      if (source[cursor] === '[') depth += 1
      if (source[cursor] === ']') depth -= 1
      cursor += 1
    }
    cursor = skipWhitespaceAndComments(source, cursor)
  }
  return cleanTitle(readSimpleGroup(source, cursor)?.value || '')
}

function parserErrorDiagnostic(
  error: unknown,
  source: string,
  lineStarts: number[],
  file?: string,
): LocatedDiagnostic {
  const value = error as {
    message?: string
    line?: number
    column?: number
    position?: { start?: Partial<SourcePoint> }
    location?: { start?: { line?: number; column?: number } }
    loc?: { line?: number; column?: number }
    pos?: number
  }
  const line = value.position?.start?.line ?? value.location?.start?.line ?? value.loc?.line ?? value.line
  const column = value.position?.start?.column ?? value.location?.start?.column ?? value.loc?.column ?? value.column
  let offset = typeof value.pos === 'number' ? value.pos : 0
  if (line != null) {
    offset = (lineStarts[Math.max(0, line - 1)] || 0) + Math.max(0, (column || 1) - 1)
  }
  return locatedDiagnostic(
    source,
    lineStarts,
    offset,
    offset + 1,
    'error',
    'parse-error',
    value.message ? `LaTeX parser: ${value.message}` : 'The LaTeX parser could not analyze this source.',
    file,
  )
}

function scanStructure(
  source: string,
  lineStarts: number[],
  file?: string,
): LocatedDiagnostic[] {
  const diagnostics: LocatedDiagnostic[] = []
  const braces: number[] = []
  const environments: EnvironmentEntry[] = []
  let verbatimEnvironment: string | undefined
  let index = 0

  while (index < source.length) {
    if (verbatimEnvironment) {
      const terminator = `\\end{${verbatimEnvironment}}`
      const end = source.indexOf(terminator, index)
      if (end < 0) {
        break
      }
      index = end
      verbatimEnvironment = undefined
    }

    const char = source[index]
    if (char === '%') {
      const newline = source.indexOf('\n', index + 1)
      index = newline < 0 ? source.length : newline + 1
      continue
    }

    if (char === '\\') {
      const command = readControlSequence(source, index)
      if (!command) {
        index += 1
        continue
      }

      if (command.name === 'verb') {
        let delimiterOffset = command.end
        if (source[delimiterOffset] === '*') delimiterOffset += 1
        const delimiter = source[delimiterOffset]
        if (!delimiter || delimiter === '\n' || delimiter === '\r' || /\s/.test(delimiter)) {
          diagnostics.push(locatedDiagnostic(
            source,
            lineStarts,
            index,
            command.end,
            'error',
            'unterminated-verb',
            'The \\verb command has no valid delimiter.',
            file,
          ))
          index = command.end
          continue
        }
        const closing = source.indexOf(delimiter, delimiterOffset + 1)
        const newline = source.indexOf('\n', delimiterOffset + 1)
        if (closing < 0 || (newline >= 0 && newline < closing)) {
          diagnostics.push(locatedDiagnostic(
            source,
            lineStarts,
            index,
            newline < 0 ? source.length : newline,
            'error',
            'unterminated-verb',
            `The \\verb command is missing its closing “${delimiter}” delimiter.`,
            file,
          ))
          index = newline < 0 ? source.length : newline + 1
        } else {
          index = closing + 1
        }
        continue
      }

      if (command.name === 'begin' || command.name === 'end') {
        const group = readSimpleGroup(source, command.end)
        if (group) {
          const name = group.value.trim()
          if (!name) {
            diagnostics.push(locatedDiagnostic(
              source,
              lineStarts,
              index,
              group.end,
              'error',
              'empty-environment-name',
              `\\${command.name} requires an environment name.`,
              file,
            ))
          } else if (command.name === 'begin') {
            environments.push({ name, offset: index })
            if (verbatimEnvironments.has(name)) verbatimEnvironment = name
          } else {
            const top = environments.at(-1)
            if (!top) {
              diagnostics.push(locatedDiagnostic(
                source,
                lineStarts,
                index,
                group.end,
                'error',
                'unmatched-environment-end',
                `No matching \\begin{${name}} was found.`,
                file,
              ))
            } else if (top.name === name) {
              environments.pop()
            } else {
              let matchingIndex = -1
              for (let candidate = environments.length - 1; candidate >= 0; candidate -= 1) {
                if (environments[candidate].name === name) {
                  matchingIndex = candidate
                  break
                }
              }
              if (matchingIndex < 0) {
                diagnostics.push(locatedDiagnostic(
                  source,
                  lineStarts,
                  index,
                  group.end,
                  'error',
                  'unmatched-environment-end',
                  `No matching \\begin{${name}} was found.`,
                  file,
                ))
              } else {
                diagnostics.push(locatedDiagnostic(
                  source,
                  lineStarts,
                  index,
                  group.end,
                  'error',
                  'mismatched-environment',
                  `Expected \\end{${top.name}} before \\end{${name}}.`,
                  file,
                ))
                environments.splice(matchingIndex)
              }
            }
          }
          index = group.end
          continue
        }
      }

      // Skip the full control sequence. This also correctly ignores escaped
      // structural characters such as \%, \{, and \}.
      index = command.end
      continue
    }

    if (char === '{') braces.push(index)
    else if (char === '}') {
      const opening = braces.pop()
      if (opening == null) {
        diagnostics.push(locatedDiagnostic(
          source,
          lineStarts,
          index,
          index + 1,
          'error',
          'unmatched-closing-brace',
          'Unmatched closing brace.',
          file,
        ))
      }
    }
    index += 1
  }

  braces.forEach((offset) => {
    diagnostics.push(locatedDiagnostic(
      source,
      lineStarts,
      offset,
      offset + 1,
      'error',
      'unclosed-brace',
      'Opening brace is not closed.',
      file,
    ))
  })
  environments.forEach(({ name, offset }) => {
    diagnostics.push(locatedDiagnostic(
      source,
      lineStarts,
      offset,
      offset + `\\begin{${name}}`.length,
      'error',
      'unclosed-environment',
      `Missing \\end{${name}}.`,
      file,
    ))
  })

  return diagnostics
}

function stripLocation(diagnostic: LocatedDiagnostic): Diagnostic {
  const { offset, ...result } = diagnostic
  void offset
  return result
}

/**
 * Parse and statically analyze a LaTeX source string in the browser.
 *
 * The unified-latex AST drives outline, label, and reference discovery. A
 * comment/verbatim-aware lexical pass supplements the error-tolerant parser for
 * unmatched braces and environment boundaries.
 */
export function analyzeLatexAst(
  source: string,
  options: LatexAstAnalysisOptions = {},
): LatexAstAnalysis {
  const lineStarts = createLineStarts(source)
  const diagnostics = scanStructure(source, lineStarts, options.file)
  const outline: Array<OutlineItem & { offset: number }> = []
  const labels = new Map<string, LocatedMacro>()
  const references: LocatedMacro[] = []
  let ast: unknown

  try {
    ast = parser.parse(source)
  } catch (error) {
    diagnostics.push(parserErrorDiagnostic(error, source, lineStarts, options.file))
    return {
      outline: [],
      diagnostics: diagnostics.sort((left, right) => left.offset - right.offset).map(stripLocation),
    }
  }

  walkAst(ast, (node) => {
    if (node.type !== 'macro' || typeof node.content !== 'string') return
    const macroName = node.content
    const start = nodeStart(node, source, lineStarts)

    if (outlineCommands.has(macroName as OutlineItem['kind'])) {
      const title = cleanTitle(argumentPlainText(macroArgument(node, 'title')))
      const kind = macroName as OutlineItem['kind']
      outline.push({
        kind,
        title: title || 'Untitled section',
        line: start.line,
        level: outlineLevels[kind],
        offset: start.offset,
        ...(options.file ? { file: options.file } : {}),
      })
      return
    }

    if (macroName === 'label') {
      const key = argumentKey(macroArgument(node)) || fallbackMacroArgument(source, node)
      if (!key) return
      const existing = labels.get(key)
      if (existing) {
        const first = nodeStart(existing.node, source, lineStarts)
        diagnostics.push(macroDiagnostic(
          source,
          lineStarts,
          node,
          'warning',
          'duplicate-label',
          `Duplicate label “${key}”; first defined on line ${first.line}.`,
          options.file,
        ))
      } else {
        labels.set(key, { node, key, offset: start.offset })
      }
      return
    }

    if (referenceCommands.has(macroName)) {
      const rawKey = argumentKey(macroArgument(node)) || fallbackMacroArgument(source, node)
      if (!rawKey) return
      const keys = commaSeparatedReferenceCommands.has(macroName) ? rawKey.split(',') : [rawKey]
      keys.map((key) => key.trim()).filter(Boolean).forEach((key) => {
        references.push({ node, key, offset: start.offset })
      })
    }
  })

  const knownLabels = new Set(options.knownLabels || [])
  labels.forEach((_value, key) => knownLabels.add(key))
  references.forEach((reference) => {
    if (knownLabels.has(reference.key)) return
    diagnostics.push(macroDiagnostic(
      source,
      lineStarts,
      reference.node,
      'warning',
      'undefined-reference',
      `Reference “${reference.key}” is not defined in this document.`,
      options.file,
    ))
  })

  return {
    outline: outline
      .sort((left, right) => left.offset - right.offset)
      .map(({ offset, ...item }) => {
        void offset
        return item
      }),
    diagnostics: diagnostics
      .sort((left, right) => left.offset - right.offset || String(left.code).localeCompare(String(right.code)))
      .map(stripLocation),
  }
}

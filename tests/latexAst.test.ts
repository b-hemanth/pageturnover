import { describe, expect, it } from 'vitest'
import { analyzeLatexAst } from '../src/latexAst'

describe('analyzeLatexAst', () => {
  it('builds a source-positioned outline from nested and formatted AST titles', () => {
    const source = String.raw`\section[Short]{The \textbf{Main {Argument}}}
Intro.
\subsection*{Evidence \& Method}
% \section{Not in the document}
\subsubsection{Results with $x^2$}`

    const result = analyzeLatexAst(source, { file: 'paper.tex' })

    expect(result.outline).toEqual([
      { kind: 'section', title: 'The Main Argument', line: 1, level: 2, file: 'paper.tex' },
      { kind: 'subsection', title: 'Evidence & Method', line: 3, level: 3, file: 'paper.tex' },
      { kind: 'subsubsection', title: 'Results with x2', line: 5, level: 4, file: 'paper.tex' },
    ])
  })

  it('finds duplicate labels and unresolved standard and cleveref references', () => {
    const source = String.raw`\section{One}\label{sec:one}
\label{sec:one}
See \ref{sec:one}.
See \eqref{eq:missing}.
See \cref{sec:one,sec:other}.`

    const result = analyzeLatexAst(source)
    const duplicates = result.diagnostics.filter((item) => item.code === 'duplicate-label')
    const unresolved = result.diagnostics.filter((item) => item.code === 'undefined-reference')

    expect(duplicates).toHaveLength(1)
    expect(duplicates[0]).toMatchObject({ line: 2, column: 1, severity: 'warning' })
    expect(duplicates[0].message).toContain('first defined on line 1')
    expect(unresolved.map((item) => item.message)).toEqual([
      'Reference “eq:missing” is not defined in this document.',
      'Reference “sec:other” is not defined in this document.',
    ])
    expect(unresolved.map((item) => item.line)).toEqual([4, 5])
  })

  it('reports unmatched braces and environment boundaries with precise locations', () => {
    const source = String.raw`Text }
{
\begin{figure}
\end{table}`

    const result = analyzeLatexAst(source)

    expect(result.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'unmatched-closing-brace', line: 1, column: 6, severity: 'error' }),
      expect.objectContaining({ code: 'unclosed-brace', line: 2, column: 1, severity: 'error' }),
      expect.objectContaining({ code: 'unclosed-environment', line: 3, column: 1, severity: 'error' }),
      expect.objectContaining({ code: 'unmatched-environment-end', line: 4, column: 1, severity: 'error' }),
    ]))
  })

  it('does not lint comments, escaped braces, inline verbatim, or verbatim environments as LaTeX', () => {
    const source = String.raw`% { \begin{ghost} \ref{ghost}
Escaped \{ and \}.
\verb|{ \ref{ghost}|
\begin{verbatim}
} \ref{ghost}
\end{verbatim}
\begin{Verbatim}
\section{Also not real} \ref{ghost}
\end{Verbatim}
\section{Real}`

    const result = analyzeLatexAst(source)

    expect(result.outline).toEqual([
      { kind: 'section', title: 'Real', line: 10, level: 2 },
    ])
    expect(result.diagnostics).toEqual([])
  })

  it('accepts labels indexed from other project files', () => {
    const result = analyzeLatexAst(String.raw`See \nameref{sec:external}.`, {
      knownLabels: ['sec:external'],
    })

    expect(result.diagnostics).toEqual([])
  })

  it('does not treat commands nested in macro definitions as live document structure', () => {
    const source = String.raw`\newcommand{\later}{\section{Not yet}\ref{not-yet}}
\def\primitive{\section{Still not live}\ref{still-not-live}}
\section{Actual}`

    const result = analyzeLatexAst(source)

    expect(result.outline).toEqual([
      { kind: 'section', title: 'Actual', line: 3, level: 2 },
    ])
    expect(result.diagnostics).toEqual([])
  })
})

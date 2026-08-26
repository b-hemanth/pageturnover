import {
  AlertTriangle,
  ChevronLeft,
  ChevronRight,
  FileText,
  LoaderCircle,
  Minus,
  Plus,
  RefreshCw,
} from 'lucide-react'
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type PageViewport,
  type RenderTask,
} from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react'
import './pdfPreview.css'

GlobalWorkerOptions.workerSrc = pdfWorkerUrl

export type PdfPreviewBuildState = 'idle' | 'building' | 'success' | 'failed'

export interface PdfPoint {
  /** PDF pages are one-indexed. */
  page: number
  /** Horizontal position in PDF points. */
  x: number
  /** Vertical position in PDF points, measured from the PDF origin. */
  y: number
}

export interface PdfSyncTarget extends PdfPoint {
  /** Optional highlighted width in PDF points. */
  width?: number
  /** Optional highlighted height in PDF points. */
  height?: number
}

export interface PdfDocumentInfo {
  url: string
  pages: number
}

export interface PdfPreviewProps {
  /** An authenticated, same-origin PDF URL. Hash fragments are ignored. */
  url?: string | null
  buildState?: PdfPreviewBuildState
  className?: string
  title?: string
  /** Additional request headers, if the same-origin endpoint uses header auth. */
  requestHeaders?: Record<string, string>
  /** Scrolls to this PDF-space position and marks it on the proof. */
  syncTarget?: PdfSyncTarget | null
  /** Fired when a proof point is selected by double-clicking a rendered page. */
  onPointPick?: (point: PdfPoint) => void
  onPageChange?: (page: number, totalPages: number) => void
  onDocumentLoad?: (document: PdfDocumentInfo) => void
  onError?: (error: Error) => void
  /** Used by the empty/error state to request a compile from the parent. */
  onRequestBuild?: () => void
}

type ZoomValue = 'fit' | number
type PageRenderState = 'waiting' | 'loading' | 'ready' | 'error'

const DEFAULT_PAGE_WIDTH = 595.28
const DEFAULT_PAGE_HEIGHT = 841.89
const PAGE_GUTTER = 52
const MIN_ZOOM = 0.25
const MAX_ZOOM = 2.5
const ZOOM_STEP = 0.1
const MAX_CANVAS_PIXELS = 20_000_000

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function isRenderCancellation(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === 'RenderingCancelledException' || error.name === 'AbortException')
  )
}

function normalisePdfUrl(value: string) {
  const parsed = new URL(value, window.location.href)
  if (parsed.origin !== window.location.origin) {
    throw new Error('The proof URL must be served by this editor.')
  }
  parsed.hash = ''
  return parsed.href
}

function preferredScrollBehavior(): ScrollBehavior {
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}

function displayError(error: unknown) {
  if (!(error instanceof Error)) return 'The PDF could not be opened.'
  if (error.name === 'InvalidPDFException') return 'The build did not produce a valid PDF.'
  if (error.name === 'MissingPDFException') return 'The compiled PDF is no longer available.'
  if (error.name === 'PasswordException') return 'This PDF is password protected.'
  return error.message || 'The PDF could not be opened.'
}

interface PdfPageCanvasProps {
  document: PDFDocumentProxy
  documentKey: string
  pageNumber: number
  root: HTMLDivElement | null
  zoom: ZoomValue
  fitWidth: number
  fallbackWidth: number
  fallbackHeight: number
  syncTarget?: PdfSyncTarget | null
  onPointPick?: (point: PdfPoint) => void
  onRegister: (page: number, element: HTMLElement | null) => void
  onLayout: () => void
}

function PdfPageCanvas({
  document,
  documentKey,
  pageNumber,
  root,
  zoom,
  fitWidth,
  fallbackWidth,
  fallbackHeight,
  syncTarget,
  onPointPick,
  onRegister,
  onLayout,
}: PdfPageCanvasProps) {
  const pageElementRef = useRef<HTMLElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const pageProxyRef = useRef<PDFPageProxy | null>(null)
  const renderTaskRef = useRef<RenderTask | null>(null)
  const lastSyncScrollRef = useRef('')
  const [activated, setActivated] = useState(false)
  const [page, setPage] = useState<PDFPageProxy | null>(null)
  const [viewport, setViewport] = useState<PageViewport | null>(null)
  const [renderState, setRenderState] = useState<PageRenderState>('waiting')
  const [renderError, setRenderError] = useState('')
  const [renderVersion, setRenderVersion] = useState(0)

  const registerElement = useCallback((element: HTMLElement | null) => {
    pageElementRef.current = element
    onRegister(pageNumber, element)
  }, [onRegister, pageNumber])

  useEffect(() => {
    const element = pageElementRef.current
    if (!element || activated) return
    if (!root) return
    if (typeof IntersectionObserver === 'undefined') {
      setActivated(true)
      return
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setActivated(true)
          observer.disconnect()
        }
      },
      { root, rootMargin: '900px 0px', threshold: 0.01 },
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [activated, root])

  useEffect(() => {
    if (!activated) return
    let disposed = false
    let resolvedPage: PDFPageProxy | null = null
    setRenderState('loading')
    setRenderError('')
    void document.getPage(pageNumber).then(
      (nextPage) => {
        resolvedPage = nextPage
        if (disposed) {
          nextPage.cleanup()
          return
        }
        pageProxyRef.current = nextPage
        setPage(nextPage)
      },
      (error: unknown) => {
        if (disposed) return
        setRenderState('error')
        setRenderError(displayError(error))
      },
    )
    return () => {
      disposed = true
      if (pageProxyRef.current === resolvedPage) pageProxyRef.current = null
      resolvedPage?.cleanup()
      setPage(null)
      setViewport(null)
    }
  }, [activated, document, documentKey, pageNumber, renderVersion])

  useEffect(() => {
    if (!page) return
    const canvas = canvasRef.current
    if (!canvas) return

    renderTaskRef.current?.cancel()
    let disposed = false
    const unitViewport = page.getViewport({ scale: 1 })
    const scale = zoom === 'fit' ? fitWidth / unitViewport.width : zoom
    const nextViewport = page.getViewport({ scale })
    const requestedRatio = Math.max(1, window.devicePixelRatio || 1)
    const pixelLimitRatio = Math.sqrt(
      MAX_CANVAS_PIXELS / Math.max(1, nextViewport.width * nextViewport.height),
    )
    const outputRatio = Math.max(1, Math.min(requestedRatio, pixelLimitRatio))

    setViewport(nextViewport)
    setRenderState('loading')
    setRenderError('')
    canvas.width = Math.max(1, Math.floor(nextViewport.width * outputRatio))
    canvas.height = Math.max(1, Math.floor(nextViewport.height * outputRatio))
    canvas.style.width = `${nextViewport.width}px`
    canvas.style.height = `${nextViewport.height}px`

    const task = page.render({
      canvas,
      viewport: nextViewport,
      transform: outputRatio === 1 ? undefined : [outputRatio, 0, 0, outputRatio, 0, 0],
      background: '#ffffff',
    })
    renderTaskRef.current = task
    void task.promise.then(
      () => {
        if (disposed) return
        setRenderState('ready')
        onLayout()
      },
      (error: unknown) => {
        if (disposed || isRenderCancellation(error)) return
        setRenderState('error')
        setRenderError(displayError(error))
      },
    )

    return () => {
      disposed = true
      if (renderTaskRef.current === task) renderTaskRef.current = null
      task.cancel()
    }
  }, [fitWidth, onLayout, page, zoom])

  useEffect(() => () => {
    renderTaskRef.current?.cancel()
    pageProxyRef.current?.cleanup()
    const canvas = canvasRef.current
    if (canvas) {
      canvas.width = 0
      canvas.height = 0
    }
  }, [])

  const pageWidth = viewport?.width || fallbackWidth
  const pageHeight = viewport?.height || fallbackHeight

  const highlight = useMemo(() => {
    if (!viewport || !syncTarget || syncTarget.page !== pageNumber) return null
    const [pointX, pointY] = viewport.convertToViewportPoint(syncTarget.x, syncTarget.y) as [number, number]
    if (syncTarget.width && syncTarget.height) {
      const [farX, farY] = viewport.convertToViewportPoint(
        syncTarget.x + syncTarget.width,
        syncTarget.y + syncTarget.height,
      ) as [number, number]
      return {
        area: true,
        left: Math.min(pointX, farX),
        top: Math.min(pointY, farY),
        width: Math.max(8, Math.abs(farX - pointX)),
        height: Math.max(8, Math.abs(farY - pointY)),
        pointY,
      }
    }
    return {
      area: false,
      left: pointX,
      top: pointY,
      width: 16,
      height: 16,
      pointY,
    }
  }, [pageNumber, syncTarget, viewport])

  useEffect(() => {
    if (!highlight || !root || !pageElementRef.current || !syncTarget) return
    const syncKey = [
      documentKey,
      syncTarget.page,
      syncTarget.x,
      syncTarget.y,
      syncTarget.width || 0,
      syncTarget.height || 0,
    ].join(':')
    if (lastSyncScrollRef.current === syncKey) return
    lastSyncScrollRef.current = syncKey
    const pageRect = pageElementRef.current.getBoundingClientRect()
    const rootRect = root.getBoundingClientRect()
    const pageTop = root.scrollTop + pageRect.top - rootRect.top
    root.scrollTo({
      top: Math.max(0, pageTop + highlight.pointY - root.clientHeight * 0.42),
      behavior: preferredScrollBehavior(),
    })
  }, [documentKey, highlight, root, syncTarget])

  const handleDoubleClick = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    if (!onPointPick || !viewport) return
    const rect = event.currentTarget.getBoundingClientRect()
    const viewportX = (event.clientX - rect.left) * (viewport.width / rect.width)
    const viewportY = (event.clientY - rect.top) * (viewport.height / rect.height)
    const [x, y] = viewport.convertToPdfPoint(viewportX, viewportY) as [number, number]
    onPointPick({ page: pageNumber, x, y })
  }, [onPointPick, pageNumber, viewport])

  const pageStyle = {
    '--pdfp-page-width': `${pageWidth}px`,
    '--pdfp-page-height': `${pageHeight}px`,
  } as CSSProperties

  const highlightStyle = highlight
    ? ({
        left: highlight.left,
        top: highlight.top,
        width: highlight.width,
        height: highlight.height,
      } as CSSProperties)
    : undefined

  return (
    <article
      ref={registerElement}
      className={`pdfp-page ${renderState === 'ready' ? 'is-rendered' : ''}`}
      style={pageStyle}
      aria-label={`Page ${pageNumber}`}
      data-page={pageNumber}
    >
      <span className="pdfp-page-index" aria-hidden="true">{String(pageNumber).padStart(2, '0')}</span>
      <div className="pdfp-paper">
        <canvas
          ref={canvasRef}
          className="pdfp-canvas"
          onDoubleClick={handleDoubleClick}
          role="img"
          aria-label={
            onPointPick
              ? `Rendered PDF page ${pageNumber}. Double-click to select a source position.`
              : `Rendered PDF page ${pageNumber}`
          }
        >
          Rendered PDF page {pageNumber}
        </canvas>
        {highlight && (
          <span
            className={`pdfp-source-highlight ${highlight.area ? 'is-area' : 'is-point'}`}
            style={highlightStyle}
            aria-hidden="true"
          >
            <i>SRC</i>
          </span>
        )}
        {renderState !== 'ready' && renderState !== 'error' && (
          <div className="pdfp-page-loading" aria-hidden="true">
            {activated ? <LoaderCircle className="pdfp-spin" size={17} /> : <span />}
          </div>
        )}
        {renderState === 'error' && (
          <div className="pdfp-page-error" role="alert">
            <AlertTriangle size={17} />
            <span>{renderError || 'This page could not be drawn.'}</span>
            <button type="button" onClick={() => setRenderVersion((value) => value + 1)}>
              Retry page
            </button>
          </div>
        )}
      </div>
    </article>
  )
}

export default function PdfPreview({
  url,
  buildState = 'idle',
  className = '',
  title = 'Typeset PDF proof',
  requestHeaders,
  syncTarget,
  onPointPick,
  onPageChange,
  onDocumentLoad,
  onError,
  onRequestBuild,
}: PdfPreviewProps) {
  const scrollElementRef = useRef<HTMLDivElement | null>(null)
  const pageElementsRef = useRef(new Map<number, HTMLElement>())
  const pageInputRef = useRef<HTMLInputElement | null>(null)
  const currentPageRafRef = useRef(0)
  const documentRef = useRef<PDFDocumentProxy | null>(null)
  const loadingTaskRef = useRef<PDFDocumentLoadingTask | null>(null)
  const loadCallbacksRef = useRef({ onDocumentLoad, onError })
  const [scrollElement, setScrollElement] = useState<HTMLDivElement | null>(null)
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null)
  const [documentUrl, setDocumentUrl] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadProgress, setLoadProgress] = useState<number | null>(null)
  const [loadError, setLoadError] = useState('')
  const [reloadVersion, setReloadVersion] = useState(0)
  const [viewportWidth, setViewportWidth] = useState(0)
  const [zoom, setZoom] = useState<ZoomValue>('fit')
  const [currentPage, setCurrentPage] = useState(1)
  const [pageField, setPageField] = useState('1')

  const totalPages = document?.numPages || 0
  const fitWidth = Math.max(180, viewportWidth - PAGE_GUTTER)
  const fallbackScale = zoom === 'fit' ? fitWidth / DEFAULT_PAGE_WIDTH : zoom
  const fallbackWidth = DEFAULT_PAGE_WIDTH * fallbackScale
  const fallbackHeight = DEFAULT_PAGE_HEIGHT * fallbackScale
  const requestHeadersKey = JSON.stringify(
    Object.entries(requestHeaders || {}).sort(([left], [right]) => left.localeCompare(right)),
  )
  const syncPage = syncTarget?.page
  const documentKey = document
    ? `${document.fingerprints[0] || documentUrl}:${document.numPages}`
    : ''

  useEffect(() => {
    loadCallbacksRef.current = { onDocumentLoad, onError }
  }, [onDocumentLoad, onError])

  const setScrollRef = useCallback((element: HTMLDivElement | null) => {
    scrollElementRef.current = element
    setScrollElement(element)
  }, [])

  useEffect(() => {
    const element = scrollElementRef.current
    if (!element) return
    let resizeFrame = 0
    const updateWidth = (width: number) => {
      window.cancelAnimationFrame(resizeFrame)
      resizeFrame = window.requestAnimationFrame(() => setViewportWidth(Math.floor(width)))
    }
    updateWidth(element.clientWidth)
    if (typeof ResizeObserver === 'undefined') return () => window.cancelAnimationFrame(resizeFrame)
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) updateWidth(entry.contentRect.width)
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
      window.cancelAnimationFrame(resizeFrame)
    }
  }, [scrollElement])

  useEffect(() => {
    if (!url) {
      setLoading(false)
      setLoadProgress(null)
      setLoadError('')
      setDocument(null)
      setDocumentUrl('')
      documentRef.current = null
      return
    }

    let sourceUrl: string
    try {
      sourceUrl = normalisePdfUrl(url)
    } catch (error) {
      const message = displayError(error)
      setLoadError(message)
      setLoading(false)
      if (error instanceof Error) loadCallbacksRef.current.onError?.(error)
      return
    }

    let disposed = false
    let promoted = false
    setLoading(true)
    setLoadProgress(null)
    setLoadError('')
    const task = getDocument({
      url: sourceUrl,
      withCredentials: true,
      httpHeaders: Object.fromEntries(JSON.parse(requestHeadersKey) as [string, string][]),
    })
    loadingTaskRef.current = task
    task.onProgress = ({ loaded, total }: { loaded: number; total: number }) => {
      if (disposed) return
      setLoadProgress(total > 0 ? clamp(loaded / total, 0, 1) : null)
    }
    void task.promise.then(
      (nextDocument) => {
        if (disposed) {
          void nextDocument.loadingTask.destroy()
          return
        }
        promoted = true
        documentRef.current = nextDocument
        setDocument(nextDocument)
        setDocumentUrl(sourceUrl)
        setLoading(false)
        if (loadingTaskRef.current === task) loadingTaskRef.current = null
        setLoadProgress(1)
        setCurrentPage(1)
        setPageField('1')
        pageElementsRef.current.clear()
        loadCallbacksRef.current.onDocumentLoad?.({ url: sourceUrl, pages: nextDocument.numPages })
      },
      (error: unknown) => {
        if (disposed || isRenderCancellation(error)) return
        const normalisedError = error instanceof Error ? error : new Error(displayError(error))
        setLoadError(displayError(normalisedError))
        setLoading(false)
        if (loadingTaskRef.current === task) loadingTaskRef.current = null
        setLoadProgress(null)
        loadCallbacksRef.current.onError?.(normalisedError)
        promoted = true
        void task.destroy()
      },
    )

    return () => {
      disposed = true
      if (!promoted) {
        if (loadingTaskRef.current === task) loadingTaskRef.current = null
        void task.destroy()
      }
    }
  }, [reloadVersion, requestHeadersKey, url])

  useEffect(() => {
    documentRef.current = document
    return () => {
      if (documentRef.current === document) documentRef.current = null
      void document?.loadingTask.destroy()
    }
  }, [document])

  useEffect(() => () => {
    window.cancelAnimationFrame(currentPageRafRef.current)
    void loadingTaskRef.current?.destroy()
  }, [])

  const updateCurrentPage = useCallback(() => {
    const root = scrollElementRef.current
    if (!root || pageElementsRef.current.size === 0) return
    const rootRect = root.getBoundingClientRect()
    const readingLine = rootRect.top + Math.min(rootRect.height * 0.38, 260)
    let nearestPage = 1
    let nearestDistance = Number.POSITIVE_INFINITY
    for (const [pageNumber, element] of pageElementsRef.current) {
      const rect = element.getBoundingClientRect()
      if (rect.top <= readingLine && rect.bottom >= readingLine) {
        nearestPage = pageNumber
        break
      }
      const distance = Math.min(Math.abs(rect.top - readingLine), Math.abs(rect.bottom - readingLine))
      if (distance < nearestDistance) {
        nearestDistance = distance
        nearestPage = pageNumber
      }
    }
    setCurrentPage((previous) => (previous === nearestPage ? previous : nearestPage))
  }, [])

  const scheduleCurrentPage = useCallback(() => {
    window.cancelAnimationFrame(currentPageRafRef.current)
    currentPageRafRef.current = window.requestAnimationFrame(updateCurrentPage)
  }, [updateCurrentPage])

  const registerPage = useCallback((pageNumber: number, element: HTMLElement | null) => {
    if (element) pageElementsRef.current.set(pageNumber, element)
    else pageElementsRef.current.delete(pageNumber)
    scheduleCurrentPage()
  }, [scheduleCurrentPage])

  useEffect(() => {
    if (window.document.activeElement !== pageInputRef.current) setPageField(String(currentPage))
    if (totalPages) onPageChange?.(currentPage, totalPages)
  }, [currentPage, onPageChange, totalPages])

  useEffect(() => {
    scheduleCurrentPage()
  }, [documentKey, fitWidth, scheduleCurrentPage, zoom])

  useEffect(() => {
    if (syncPage == null || !document) return
    const targetPage = clamp(Math.round(syncPage), 1, document.numPages)
    setCurrentPage(targetPage)
    const frame = window.requestAnimationFrame(() => {
      pageElementsRef.current.get(targetPage)?.scrollIntoView({
        behavior: preferredScrollBehavior(),
        block: 'center',
        inline: 'center',
      })
    })
    return () => window.cancelAnimationFrame(frame)
  }, [document, syncPage])

  const jumpToPage = useCallback((requestedPage: number) => {
    if (!totalPages) return
    const targetPage = clamp(Math.round(requestedPage), 1, totalPages)
    setCurrentPage(targetPage)
    setPageField(String(targetPage))
    pageElementsRef.current.get(targetPage)?.scrollIntoView({
      behavior: preferredScrollBehavior(),
      block: 'start',
      inline: 'center',
    })
  }, [totalPages])

  const commitPageField = useCallback(() => {
    const parsed = Number(pageField)
    if (Number.isFinite(parsed)) jumpToPage(parsed)
    else setPageField(String(currentPage))
  }, [currentPage, jumpToPage, pageField])

  const handlePageFieldKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      commitPageField()
      event.currentTarget.blur()
    }
    if (event.key === 'Escape') {
      setPageField(String(currentPage))
      event.currentTarget.blur()
    }
  }, [commitPageField, currentPage])

  const effectiveZoom = zoom === 'fit'
    ? clamp(fitWidth / DEFAULT_PAGE_WIDTH, MIN_ZOOM, MAX_ZOOM)
    : zoom

  const changeZoom = useCallback((direction: -1 | 1) => {
    const base = zoom === 'fit'
      ? clamp(fitWidth / DEFAULT_PAGE_WIDTH, MIN_ZOOM, MAX_ZOOM)
      : zoom
    const next = clamp(Math.round((base + direction * ZOOM_STEP) * 100) / 100, MIN_ZOOM, MAX_ZOOM)
    setZoom(next)
  }, [fitWidth, zoom])

  const zoomSelectValue = zoom === 'fit'
    ? 'fit'
    : [0.75, 1, 1.25].includes(zoom) ? String(zoom) : 'custom'

  const retryLoad = useCallback(() => {
    if (onRequestBuild && (!url || buildState === 'failed')) onRequestBuild()
    else setReloadVersion((value) => value + 1)
  }, [buildState, onRequestBuild, url])

  const isRefreshing = Boolean(document) && (loading || buildState === 'building')
  const progressLabel = loadProgress == null ? '' : `${Math.round(loadProgress * 100)}%`
  const pages = useMemo(
    () => document ? Array.from({ length: document.numPages }, (_, index) => index + 1) : [],
    [document],
  )

  return (
    <section className={`pdfp-viewer ${className}`.trim()} aria-label={title}>
      <div className="pdfp-toolbar" role="toolbar" aria-label="PDF proof controls">
        <div className="pdfp-pagination">
          <button
            type="button"
            onClick={() => jumpToPage(currentPage - 1)}
            disabled={!totalPages || currentPage <= 1}
            aria-label="Previous page"
            title="Previous page"
          >
            <ChevronLeft size={15} />
          </button>
          <label>
            <span className="sr-only">Current PDF page</span>
            <input
              ref={pageInputRef}
              type="text"
              inputMode="numeric"
              value={pageField}
              onChange={(event) => setPageField(event.target.value.replace(/[^0-9]/g, ''))}
              onBlur={commitPageField}
              onKeyDown={handlePageFieldKeyDown}
              disabled={!totalPages}
              aria-label="Current PDF page"
            />
          </label>
          <span aria-live="polite">of {totalPages || '—'}</span>
          <button
            type="button"
            onClick={() => jumpToPage(currentPage + 1)}
            disabled={!totalPages || currentPage >= totalPages}
            aria-label="Next page"
            title="Next page"
          >
            <ChevronRight size={15} />
          </button>
        </div>

        <span className="pdfp-toolbar-rule" aria-hidden="true" />

        <div className="pdfp-zoom-controls">
          <button
            type="button"
            onClick={() => changeZoom(-1)}
            disabled={!document || effectiveZoom <= MIN_ZOOM}
            aria-label="Zoom out"
            title="Zoom out"
          >
            <Minus size={14} />
          </button>
          <label>
            <span className="sr-only">PDF zoom</span>
            <select
              value={zoomSelectValue}
              onChange={(event) => {
                const value = event.target.value
                if (value === 'custom') return
                setZoom(value === 'fit' ? 'fit' : Number(value))
              }}
              disabled={!document}
              aria-label="PDF zoom"
            >
              <option value="fit">Fit width</option>
              <option value="0.75">75%</option>
              <option value="1">100%</option>
              <option value="1.25">125%</option>
              {zoomSelectValue === 'custom' && (
                <option value="custom">{Math.round(effectiveZoom * 100)}%</option>
              )}
            </select>
          </label>
          <button
            type="button"
            onClick={() => changeZoom(1)}
            disabled={!document || effectiveZoom >= MAX_ZOOM}
            aria-label="Zoom in"
            title="Zoom in"
          >
            <Plus size={14} />
          </button>
        </div>

        <div className={`pdfp-view-status ${isRefreshing ? 'is-active' : ''}`} aria-live="polite">
          {isRefreshing ? (
            <>
              <LoaderCircle className="pdfp-spin" size={12} />
              <span>{loading ? `Loading proof ${progressLabel}`.trim() : 'Typesetting new proof'}</span>
            </>
          ) : document ? (
            <><span className="pdfp-ready-dot" /> <span>Proof ready</span></>
          ) : (
            <span>PDF proof</span>
          )}
        </div>
      </div>

      <div
        ref={setScrollRef}
        className="pdfp-scroll"
        onScroll={scheduleCurrentPage}
        tabIndex={0}
        aria-label={totalPages ? `PDF proof, ${totalPages} pages` : 'PDF proof'}
      >
        {document && (
          <div className="pdfp-pages">
            {pages.map((pageNumber) => (
              <PdfPageCanvas
                key={`${documentKey}:${pageNumber}`}
                document={document}
                documentKey={documentKey}
                pageNumber={pageNumber}
                root={scrollElement}
                zoom={zoom}
                fitWidth={fitWidth}
                fallbackWidth={fallbackWidth}
                fallbackHeight={fallbackHeight}
                syncTarget={syncTarget}
                onPointPick={onPointPick}
                onRegister={registerPage}
                onLayout={scheduleCurrentPage}
              />
            ))}
          </div>
        )}

        {!document && loading && (
          <div className="pdfp-state" role="status">
            <span className="pdfp-state-mark is-loading"><LoaderCircle className="pdfp-spin" size={22} /></span>
            <p className="pdfp-kicker">BUILDING PDF</p>
            <h3>Opening the proof.</h3>
            <p>The first page will appear as soon as the document structure is ready.</p>
            <div
              className={`pdfp-progress ${loadProgress == null ? 'is-indeterminate' : ''}`}
              aria-label={`PDF loading ${progressLabel || 'in progress'}`}
            >
              <span style={{ width: loadProgress == null ? '24%' : `${loadProgress * 100}%` }} />
            </div>
          </div>
        )}

        {!document && !loading && (loadError || buildState === 'failed') && (
          <div className="pdfp-state is-error" role="alert">
            <span className="pdfp-state-mark"><AlertTriangle size={21} /></span>
            <p className="pdfp-kicker">PROOF INTERRUPTED</p>
            <h3>The proof needs attention.</h3>
            <p>{loadError || 'The latest build did not produce a PDF. Fix the first hard error, then compile again.'}</p>
            <button type="button" onClick={retryLoad}>
              <RefreshCw size={14} /> {onRequestBuild ? 'Compile again' : 'Reload proof'}
            </button>
          </div>
        )}

        {!document && !loading && !loadError && buildState !== 'failed' && (
          <div className="pdfp-state">
            <span className="pdfp-state-mark"><FileText size={22} /></span>
            <p className="pdfp-kicker">PREPRINT PROOF</p>
            <h3>Ready for a clean proof.</h3>
            <p>Compile the paper to inspect every page here.</p>
            {onRequestBuild && (
              <button type="button" onClick={onRequestBuild} disabled={buildState === 'building'}>
                {buildState === 'building'
                  ? <LoaderCircle className="pdfp-spin" size={14} />
                  : <RefreshCw size={14} />}
                Compile paper
              </button>
            )}
          </div>
        )}
      </div>

      {document && loadError && (
        <div className="pdfp-error-strip" role="alert">
          <AlertTriangle size={14} />
          <span>New proof not loaded. {loadError}</span>
          <button type="button" onClick={retryLoad}>Retry</button>
        </div>
      )}
    </section>
  )
}

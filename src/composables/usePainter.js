import { ref, watch, onMounted, onUnmounted } from 'vue'

export function usePainter({
  canvasRef,
  canvasWrapRef,
  canvasPanLayerRef,
  appFooterRef,
  tool,
  brushSize,
  color1,
  color2,
  activeColorSlot,
  canvasSizePresetValue,
  customSizeOption,
  showConfirm,
  showToast,
}) {
  // ── Internal non-reactive state ───────────────────────────────────────────
  let ctx = null
  let drawing = false
  let lastX = 0
  let lastY = 0
  /** @type {{ kind: string; x0: number; y0: number; img: ImageData; isRight: boolean } | null} */
  let dragShape = null
  let panX = 0
  let panY = 0
  /** @type {{ pointerId: number; lastX: number; lastY: number } | null} */
  let panDrag = null
  let pinchTouchDist = 0
  let viewportSyncRaf = null
  let zoomScale = 1
  let keydownHandler = null

  const DEFAULT_LOGICAL_W = 1280
  const DEFAULT_LOGICAL_H = 800
  const CANVAS_VIEWPORT_OPTION = 'viewport'
  const ZOOM_MIN = 0.15
  const ZOOM_MAX = 6
  const ZOOM_BTN_FACTOR = 1.15
  const ZOOM_WHEEL_FACTOR = 1.06
  const HISTORY_MAX = 40

  const history = []

  // ── Reactive state exposed to UI ──────────────────────────────────────────
  const zoomLabel = ref('100%')
  const cursorPt = ref('—')
  const documents = ref([])
  const activeDocIndex = ref(0)
  const logicalW = ref(DEFAULT_LOGICAL_W)
  const logicalH = ref(DEFAULT_LOGICAL_H)

  // ── DOM accessors ─────────────────────────────────────────────────────────
  const canvas = () => canvasRef.value
  const canvasWrap = () => canvasWrapRef.value
  const canvasPanLayer = () => canvasPanLayerRef.value
  const appFooter = () => appFooterRef.value

  // ── Canvas setup ──────────────────────────────────────────────────────────
  function setupHighResCanvas() {
    const c = canvas()
    if (!c || !ctx) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5)
    c.width = Math.round(logicalW.value * dpr)
    c.height = Math.round(logicalH.value * dpr)
    applyCanvasDisplaySize()
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
  }

  function clampZoom(z) {
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z))
  }

  function getCanvasWrapAvailPx() {
    const wrap = canvasWrap()
    if (!wrap) return { w: Math.max(80, DEFAULT_LOGICAL_W), h: Math.max(80, DEFAULT_LOGICAL_H) }
    const cs = getComputedStyle(wrap)
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) || 0
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) || 0
    const rawW = wrap.clientWidth - padX
    const rawH = wrap.clientHeight - padY
    if (rawW < 2 || rawH < 2) return { w: DEFAULT_LOGICAL_W, h: DEFAULT_LOGICAL_H }
    return { w: Math.max(80, Math.floor(rawW)), h: Math.max(80, Math.floor(rawH)) }
  }

  function documentUsesViewport(d) {
    return Boolean(d && d.useViewportSize)
  }

  function syncZoomUi() {
    zoomLabel.value = Math.round(zoomScale * 100) + '% · ' + logicalW.value + '×' + logicalH.value
  }

  function syncPanTransform() {
    const layer = canvasPanLayer()
    if (layer) layer.style.transform = `translate3d(${panX}px, ${panY}px, 0)`
  }

  function clampPan() {
    const wrap = canvasWrap()
    const c = canvas()
    if (!wrap || !c || !wrap.classList.contains('canvas-wrap--pannable')) return
    const margin = 2
    for (let iter = 0; iter < 16; iter++) {
      syncPanTransform()
      const wr = wrap.getBoundingClientRect()
      const cr = c.getBoundingClientRect()
      let ax = 0
      let ay = 0
      if (cr.left > wr.left + margin) ax = wr.left + margin - cr.left
      else if (cr.right < wr.right - margin) ax = wr.right - margin - cr.right
      if (cr.top > wr.top + margin) ay = wr.top + margin - cr.top
      else if (cr.bottom < wr.bottom - margin) ay = wr.bottom - margin - cr.bottom
      if (ax === 0 && ay === 0) break
      panX += ax
      panY += ay
    }
    syncPanTransform()
  }

  function endPanDrag(e) {
    if (!panDrag) return
    if (e && e.pointerId !== undefined && e.pointerId !== panDrag.pointerId) return
    const pid = panDrag.pointerId
    panDrag = null
    const wrap = canvasWrap()
    if (wrap) {
      wrap.classList.remove('canvas-wrap--panning')
      try { wrap.releasePointerCapture(pid) } catch (_) {}
    }
    clampPan()
  }

  function applyCanvasDisplaySize() {
    const c = canvas()
    const wrap = canvasWrap()
    if (!c) return
    if (!wrap) {
      c.style.width = logicalW.value * zoomScale + 'px'
      c.style.height = logicalH.value * zoomScale + 'px'
      syncPanTransform()
      syncZoomUi()
      return
    }
    const { w: availW, h: availH } = getCanvasWrapAvailPx()
    let fit = Math.min(availW / logicalW.value, availH / logicalH.value)
    fit = Math.max(0.12, Math.min(fit, 8))
    const w = logicalW.value * fit * zoomScale
    const h = logicalH.value * fit * zoomScale
    c.style.width = w + 'px'
    c.style.height = h + 'px'
    const needPan = w > availW + 0.5 || h > availH + 0.5
    wrap.classList.toggle('canvas-wrap--pannable', needPan)
    if (!needPan) { panX = 0; panY = 0 }
    syncPanTransform()
    requestAnimationFrame(() => clampPan())
    syncZoomUi()
  }

  function applyZoomScaleInternal(next) {
    zoomScale = clampZoom(next)
    const d = documents.value[activeDocIndex.value]
    if (d) d.zoomScale = zoomScale
    applyCanvasDisplaySize()
  }

  // ── Viewport resize ───────────────────────────────────────────────────────
  function resizeActiveLogicalToAvail(opts) {
    const preserveDrawing = opts && opts.preserveDrawing !== false
    const d = documents.value[activeDocIndex.value]
    if (!d || !documentUsesViewport(d)) { applyCanvasDisplaySize(); return }
    const av = getCanvasWrapAvailPx()
    if (av.w === logicalW.value && av.h === logicalH.value) {
      applyCanvasDisplaySize()
      syncCanvasSizeSelect()
      return
    }
    endStroke()
    dragShape = null
    drawing = false

    const c = canvas()
    const oldLw = logicalW.value
    const oldLh = logicalH.value
    let oc = null
    if (preserveDrawing && c && c.width > 0 && c.height > 0) {
      oc = document.createElement('canvas')
      oc.width = c.width
      oc.height = c.height
      const octx = oc.getContext('2d')
      if (octx) octx.drawImage(c, 0, 0)
    }

    logicalW.value = av.w
    logicalH.value = av.h
    d.logicalW = av.w
    d.logicalH = av.h

    setupHighResCanvas()
    fillCanvasWhiteNoHistory()

    if (oc) {
      const rw = Math.min(logicalW.value, oldLw)
      const rh = Math.min(logicalH.value, oldLh)
      ctx.drawImage(oc, 0, 0, (rw / oldLw) * oc.width, (rh / oldLh) * oc.height, 0, 0, rw, rh)
    }

    history.length = 0
    d.history = []
    persistActiveDocument()
    syncCanvasSizeSelect()
    syncZoomUi()
  }

  function scheduleViewportLogicalSync() {
    const d = documents.value[activeDocIndex.value]
    if (!documentUsesViewport(d)) { applyCanvasDisplaySize(); return }
    if (viewportSyncRaf !== null) cancelAnimationFrame(viewportSyncRaf)
    viewportSyncRaf = requestAnimationFrame(() => {
      viewportSyncRaf = null
      resizeActiveLogicalToAvail({ preserveDrawing: true })
    })
  }

  // ── History ───────────────────────────────────────────────────────────────
  function pushHistory() {
    const c = canvas()
    if (!c || !ctx) return
    history.push(ctx.getImageData(0, 0, c.width, c.height))
    if (history.length > HISTORY_MAX) history.shift()
  }

  function restoreSnapshot(data) {
    if (!ctx) return
    ctx.putImageData(data, 0, 0)
  }

  function undo() {
    if (history.length === 0) return
    restoreSnapshot(history.pop())
  }

  // ── Document management ───────────────────────────────────────────────────
  function genDocId() {
    return 'doc-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8)
  }

  function cloneImageData(src) {
    if (!src || !src.data) return null
    try { return new ImageData(new Uint8ClampedArray(src.data), src.width, src.height) } catch (_) { return null }
  }

  function fillCanvasWhiteNoHistory() {
    if (!ctx) return
    const c = canvas()
    ctx.save()
    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, c.width, c.height)
    ctx.restore()
  }

  function persistActiveDocument() {
    const d = documents.value[activeDocIndex.value]
    if (!d || !ctx) return
    const c = canvas()
    d.zoomScale = zoomScale
    d.logicalW = logicalW.value
    d.logicalH = logicalH.value
    d.canvasSnapshot = cloneImageData(ctx.getImageData(0, 0, c.width, c.height))
    d.history = history.map(h => cloneImageData(h)).filter(Boolean)
  }

  function normalizeDocLogicalSize(d) {
    const minDim = 16
    const maxDim = 8192
    let w, h
    if (documentUsesViewport(d)) {
      const av = getCanvasWrapAvailPx()
      w = av.w; h = av.h
    } else {
      w = typeof d.logicalW === 'number' && Number.isFinite(d.logicalW) ? Math.round(d.logicalW) : DEFAULT_LOGICAL_W
      h = typeof d.logicalH === 'number' && Number.isFinite(d.logicalH) ? Math.round(d.logicalH) : DEFAULT_LOGICAL_H
    }
    w = Math.min(maxDim, Math.max(minDim, w))
    h = Math.min(maxDim, Math.max(minDim, h))
    d.logicalW = w; d.logicalH = h
    return { w, h }
  }

  function loadDocumentAt(index) {
    const d = documents.value[index]
    if (!d) return
    panX = 0; panY = 0; panDrag = null
    const wrap = canvasWrap()
    if (wrap) wrap.classList.remove('canvas-wrap--panning')

    const oldSnap = d.canvasSnapshot ? cloneImageData(d.canvasSnapshot) : null
    const oldLwStored = typeof d.logicalW === 'number' && Number.isFinite(d.logicalW) ? Math.round(d.logicalW) : DEFAULT_LOGICAL_W
    const oldLhStored = typeof d.logicalH === 'number' && Number.isFinite(d.logicalH) ? Math.round(d.logicalH) : DEFAULT_LOGICAL_H

    const { w, h } = normalizeDocLogicalSize(d)
    logicalW.value = w
    logicalH.value = h
    zoomScale = clampZoom(typeof d.zoomScale === 'number' && Number.isFinite(d.zoomScale) ? d.zoomScale : 1)
    setupHighResCanvas()
    history.length = 0

    const c = canvas()
    if (oldSnap && oldSnap.width === c.width && oldSnap.height === c.height) {
      restoreSnapshot(oldSnap)
      ;(d.history || []).forEach(snap => { const cl = cloneImageData(snap); if (cl) history.push(cl) })
    } else if (oldSnap && oldLwStored > 0 && oldLhStored > 0) {
      fillCanvasWhiteNoHistory()
      const t = document.createElement('canvas')
      t.width = oldSnap.width; t.height = oldSnap.height
      const tctx = t.getContext('2d')
      if (tctx) tctx.putImageData(oldSnap, 0, 0)
      const rw = Math.min(logicalW.value, oldLwStored)
      const rh = Math.min(logicalH.value, oldLhStored)
      ctx.drawImage(t, 0, 0, (rw / oldLwStored) * t.width, (rh / oldLhStored) * t.height, 0, 0, rw, rh)
      d.history = []
    } else {
      fillCanvasWhiteNoHistory()
      ;(d.history || []).forEach(snap => { const cl = cloneImageData(snap); if (cl) history.push(cl) })
    }
    syncCanvasSizeSelect()
  }

  function parseCanvasSizeValue(val) {
    const m = String(val || '').match(/^(\d+)\s*[x×]\s*(\d+)$/i)
    if (!m) return null
    const w = parseInt(m[1], 10)
    const h = parseInt(m[2], 10)
    if (w < 16 || h < 16 || w > 8192 || h > 8192) return null
    return { w, h }
  }

  function syncCanvasSizeSelect() {
    const d = documents.value[activeDocIndex.value]
    if (documentUsesViewport(d)) {
      canvasSizePresetValue.value = CANVAS_VIEWPORT_OPTION
      if (customSizeOption) customSizeOption.value = null
      return
    }
    const key = logicalW.value + 'x' + logicalH.value
    const presets = ['2560x1440', '1920x1080', '1600x900', '1280x800', '1366x768', '1024x768', '800x600', '640x480']
    if (presets.includes(key)) {
      if (customSizeOption) customSizeOption.value = null
      canvasSizePresetValue.value = key
    } else {
      if (customSizeOption) customSizeOption.value = { value: key, label: logicalW.value + ' × ' + logicalH.value }
      canvasSizePresetValue.value = key
    }
  }

  async function applyCanvasSizeFromUserSelect() {
    const val = canvasSizePresetValue.value
    if (val === CANVAS_VIEWPORT_OPTION) {
      const d = documents.value[activeDocIndex.value]
      if (!d) return
      if (documentUsesViewport(d)) { syncCanvasSizeSelect(); return }
      const ok = await showConfirm('改為「跟隨視窗」後，畫布會隨瀏覽器／視窗調整；版面變小時僅保留左上角內容。確定嗎？')
      if (!ok) { syncCanvasSizeSelect(); return }
      endStroke(); dragShape = null; drawing = false
      d.useViewportSize = true
      resizeActiveLogicalToAvail({ preserveDrawing: true })
      return
    }

    const parsed = parseCanvasSizeValue(val)
    if (!parsed) return
    const dFixed = documents.value[activeDocIndex.value]
    if (!dFixed) return
    if (parsed.w === logicalW.value && parsed.h === logicalH.value && !documentUsesViewport(dFixed)) return

    const ok2 = await showConfirm('改變畫布大小會清除此分頁內容並重設復原紀錄，確定嗎？')
    if (!ok2) { syncCanvasSizeSelect(); return }

    endStroke(); dragShape = null; drawing = false
    dFixed.useViewportSize = false
    dFixed.logicalW = parsed.w; dFixed.logicalH = parsed.h
    logicalW.value = parsed.w; logicalH.value = parsed.h
    setupHighResCanvas()
    fillCanvasWhiteNoHistory()
    history.length = 0
    dFixed.history = []; dFixed.canvasSnapshot = null
    persistActiveDocument()
    applyCanvasDisplaySize()
  }

  function switchToDocument(nextIndex) {
    if (nextIndex < 0 || nextIndex >= documents.value.length || nextIndex === activeDocIndex.value) return
    endStroke(); dragShape = null; drawing = false
    persistActiveDocument()
    activeDocIndex.value = nextIndex
    loadDocumentAt(activeDocIndex.value)
    applyCanvasDisplaySize()
  }

  function addDocument() {
    endStroke(); dragShape = null; drawing = false
    persistActiveDocument()
    const nextNum = documents.value.length + 1
    const vp = canvasSizePresetValue.value === CANVAS_VIEWPORT_OPTION
    let nw, nh, useVp
    if (vp) {
      const av = getCanvasWrapAvailPx()
      nw = av.w; nh = av.h; useVp = true
    } else {
      const fromSelect = parseCanvasSizeValue(canvasSizePresetValue.value)
      nw = fromSelect ? fromSelect.w : logicalW.value
      nh = fromSelect ? fromSelect.h : logicalH.value
      useVp = false
    }
    documents.value.push({
      id: genDocId(), title: '分頁 ' + nextNum,
      zoomScale: 1, useViewportSize: useVp,
      logicalW: nw, logicalH: nh,
      canvasSnapshot: null, history: [],
    })
    activeDocIndex.value = documents.value.length - 1
    logicalW.value = nw; logicalH.value = nh
    zoomScale = 1
    setupHighResCanvas()
    fillCanvasWhiteNoHistory()
    history.length = 0
    persistActiveDocument()
    applyCanvasDisplaySize()
  }

  function closeDocumentAt(closeIdx) {
    if (documents.value.length <= 1) { showToast('至少保留一個分頁'); return }
    endStroke(); dragShape = null; drawing = false
    persistActiveDocument()
    const wasActive = closeIdx === activeDocIndex.value
    documents.value.splice(closeIdx, 1)
    if (wasActive) {
      activeDocIndex.value = Math.min(closeIdx, documents.value.length - 1)
    } else if (activeDocIndex.value > closeIdx) {
      activeDocIndex.value--
    }
    loadDocumentAt(activeDocIndex.value)
    applyCanvasDisplaySize()
  }

  // ── Drawing utilities ─────────────────────────────────────────────────────
  function clientToCanvas(clientX, clientY) {
    const c = canvas()
    if (!c) return { x: 0, y: 0 }
    const rect = c.getBoundingClientRect()
    if (rect.width < 1e-6 || rect.height < 1e-6) return { x: 0, y: 0 }
    return {
      x: (clientX - rect.left) * (logicalW.value / rect.width),
      y: (clientY - rect.top) * (logicalH.value / rect.height),
    }
  }

  function updateCursorPt(clientX, clientY) {
    const c = canvas()
    if (!c) return
    const rect = c.getBoundingClientRect()
    const tol = 0.5
    if (clientX < rect.left - tol || clientX > rect.right + tol || clientY < rect.top - tol || clientY > rect.bottom + tol) {
      cursorPt.value = '—'; return
    }
    const { x, y } = clientToCanvas(clientX, clientY)
    let xi = Math.max(0, Math.min(Math.max(0, logicalW.value - 1), Math.round(x)))
    let yi = Math.max(0, Math.min(Math.max(0, logicalH.value - 1), Math.round(y)))
    cursorPt.value = xi + ', ' + yi + ' px'
  }

  function rgbToHex(r, g, b) {
    const h = n => n.toString(16).padStart(2, '0')
    return '#' + h(r) + h(g) + h(b)
  }

  function getStrokeColor(isRight) {
    return isRight ? color2.value : color1.value
  }

  function sampleAtLogical(lx, ly) {
    const c = canvas()
    if (!c || !ctx) return '#000000'
    const w = c.width, h = c.height
    const px = Math.min(w - 1, Math.max(0, Math.floor((lx / logicalW.value) * w)))
    const py = Math.min(h - 1, Math.max(0, Math.floor((ly / logicalH.value) * h)))
    const d = ctx.getImageData(px, py, 1, 1).data
    return rgbToHex(d[0], d[1], d[2])
  }

  function applyCanvasCursor() {
    const c = canvas()
    if (!c) return
    c.style.cursor = tool.value === 'pick' ? 'cell' : 'crosshair'
  }

  function applyFreehandStrokeStyle() {
    if (!ctx) return
    let w = Number(brushSize.value)
    if (!Number.isFinite(w) || w < 1) w = 1
    if (w > 48) w = 48
    if (tool.value === 'pencil') {
      ctx.lineWidth = w
      ctx.lineCap = w <= 1 ? 'butt' : 'round'
      ctx.lineJoin = w <= 1 ? 'miter' : 'round'
    } else {
      ctx.lineWidth = w
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
    }
    ctx.miterLimit = 2
  }

  function strokeRoundRect(x, y, w, h, r) {
    if (!ctx) return
    const rr = Math.min(r, w / 2, h / 2)
    if (typeof ctx.roundRect === 'function') {
      ctx.beginPath(); ctx.roundRect(x, y, w, h, rr); ctx.stroke(); return
    }
    ctx.beginPath()
    ctx.moveTo(x + rr, y)
    ctx.lineTo(x + w - rr, y); ctx.quadraticCurveTo(x + w, y, x + w, y + rr)
    ctx.lineTo(x + w, y + h - rr); ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h)
    ctx.lineTo(x + rr, y + h); ctx.quadraticCurveTo(x, y + h, x, y + h - rr)
    ctx.lineTo(x, y + rr); ctx.quadraticCurveTo(x, y, x + rr, y)
    ctx.closePath(); ctx.stroke()
  }

  function drawShapePreview(x1, y1) {
    if (!dragShape || !ctx) return
    restoreSnapshot(dragShape.img)
    const cl = getStrokeColor(dragShape.isRight)
    ctx.save()
    ctx.globalCompositeOperation = 'source-over'
    ctx.strokeStyle = cl
    ctx.lineWidth = Number(brushSize.value)
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    const { x0, y0 } = dragShape
    const nx = Math.min(x0, x1), ny = Math.min(y0, y1)
    const nw = Math.abs(x1 - x0), nh = Math.abs(y1 - y0)
    if (dragShape.kind === 'line') {
      ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(x1, y1); ctx.stroke()
    } else if (dragShape.kind === 'rect') {
      if (nw < 1 && nh < 1) { ctx.restore(); return }
      ctx.strokeRect(nx, ny, Math.max(nw, 0.5), Math.max(nh, 0.5))
    } else if (dragShape.kind === 'ellipse') {
      if (nw < 1 || nh < 1) { ctx.restore(); return }
      ctx.beginPath()
      ctx.ellipse(nx + nw / 2, ny + nh / 2, nw / 2, nh / 2, 0, 0, Math.PI * 2)
      ctx.stroke()
    } else if (dragShape.kind === 'roundrect') {
      if (nw < 1 && nh < 1) { ctx.restore(); return }
      strokeRoundRect(nx, ny, Math.max(nw, 0.5), Math.max(nh, 0.5), Math.min(12, nw / 4, nh / 4, 8))
    }
    ctx.restore()
    lastX = x1; lastY = y1
  }

  function beginStroke(x, y, isRightButton) {
    if (tool.value === 'pick') {
      const hex = sampleAtLogical(x, y)
      if (isRightButton) { color2.value = hex; activeColorSlot.value = 2 }
      else { color1.value = hex; activeColorSlot.value = 1 }
      return
    }
    if (tool.value === 'fill') {
      pushHistory()
      floodFill(x, y, getStrokeColor(isRightButton))
      return
    }
    if (['line', 'rect', 'ellipse', 'roundrect'].includes(tool.value)) {
      pushHistory()
      const c = canvas()
      dragShape = { kind: tool.value, x0: x, y0: y, img: ctx.getImageData(0, 0, c.width, c.height), isRight: isRightButton }
      drawing = true; lastX = x; lastY = y
      return
    }
    pushHistory()
    drawing = true; lastX = x; lastY = y
    const strokeColor = (tool.value === 'eraser' || isRightButton) ? color2.value : color1.value
    applyFreehandStrokeStyle()
    ctx.globalCompositeOperation = 'source-over'
    ctx.strokeStyle = strokeColor
  }

  function drawSegment(x, y) {
    if (!drawing) return
    if (dragShape) { drawShapePreview(x, y); return }
    const dx = x - lastX, dy = y - lastY
    if (dx * dx + dy * dy < 0.25) return
    applyFreehandStrokeStyle()
    ctx.beginPath(); ctx.moveTo(lastX, lastY); ctx.lineTo(x, y); ctx.stroke()
    lastX = x; lastY = y
  }

  function endStroke() {
    if (dragShape) dragShape = null
    drawing = false
    if (ctx) ctx.globalCompositeOperation = 'source-over'
  }

  function hexToRgb(hex) {
    const m = hex.replace('#', '').match(/^([0-9a-f]{6})$/i)
    if (!m) return { r: 0, g: 0, b: 0, a: 255 }
    const n = parseInt(m[1], 16)
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 255 }
  }

  function floodFill(sx, sy, fillHex) {
    const c = canvas()
    if (!c || !ctx) return
    const w = c.width, h = c.height
    const sxPx = Math.min(w - 1, Math.max(0, Math.floor((sx / logicalW.value) * w)))
    const syPx = Math.min(h - 1, Math.max(0, Math.floor((sy / logicalH.value) * h)))
    const img = ctx.getImageData(0, 0, w, h)
    const d = img.data
    const ti = (syPx * w + sxPx) * 4
    const tr = d[ti], tg = d[ti + 1], tb = d[ti + 2], ta = d[ti + 3]
    const fill = hexToRgb(fillHex)
    if (tr === fill.r && tg === fill.g && tb === fill.b && ta === fill.a) return
    const stack = [[sxPx, syPx]]
    const seen = new Uint8Array(w * h)
    const match = i => d[i] === tr && d[i + 1] === tg && d[i + 2] === tb && d[i + 3] === ta
    while (stack.length) {
      const [px, py] = stack.pop()
      if (px < 0 || py < 0 || px >= w || py >= h) continue
      const p = py * w + px
      if (seen[p]) continue
      seen[p] = 1
      const i = p * 4
      if (!match(i)) continue
      d[i] = fill.r; d[i + 1] = fill.g; d[i + 2] = fill.b; d[i + 3] = fill.a
      stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1])
    }
    ctx.putImageData(img, 0, 0)
  }

  // ── Public actions ────────────────────────────────────────────────────────
  function clearCanvas() {
    pushHistory()
    const c = canvas()
    if (!ctx || !c) return
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height)
    ctx.restore()
  }

  function savePng() {
    const c = canvas()
    if (!c) return
    const a = document.createElement('a')
    a.download = 'drawing-' + new Date().toISOString().slice(0, 19).replace(/:/g, '-') + '.png'
    a.href = c.toDataURL('image/png')
    a.click()
  }

  async function copyCanvasPng() {
    const c = canvas()
    if (!c) return
    if (!navigator.clipboard || typeof ClipboardItem === 'undefined') { showToast('此環境不支援複製圖片到剪貼簿'); return }
    try {
      const blob = await new Promise((resolve, reject) => {
        c.toBlob(b => b ? resolve(b) : reject(new Error('toBlob')), 'image/png', 1)
      })
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      showToast('已複製 PNG 到剪貼簿')
    } catch (_) { showToast('複製失敗：請使用 HTTPS，或檢查剪貼簿權限') }
  }

  function getDrawnPixelBounds(imageData) {
    const w = imageData.width, h = imageData.height, d = imageData.data
    let minX = w, minY = h, maxX = -1, maxY = -1
    for (let y = 0; y < h; y++) {
      const row = y * w * 4
      for (let x = 0; x < w; x++) {
        const i = row + x * 4
        if (d[i] !== 255 || d[i + 1] !== 255 || d[i + 2] !== 255 || d[i + 3] !== 255) {
          if (x < minX) minX = x; if (x > maxX) maxX = x
          if (y < minY) minY = y; if (y > maxY) maxY = y
        }
      }
    }
    if (maxX < minX || maxY < minY) return null
    return { minX, minY, maxX, maxY }
  }

  async function copyCanvasPngDrawnBounds() {
    const c = canvas()
    if (!c || !ctx) return
    if (!navigator.clipboard || typeof ClipboardItem === 'undefined') { showToast('此環境不支援複製圖片到剪貼簿'); return }
    let img
    try { img = ctx.getImageData(0, 0, c.width, c.height) } catch (_) { showToast('無法讀取畫布像素'); return }
    const b = getDrawnPixelBounds(img)
    if (!b) { showToast('目前沒有繪製內容（全為留白）'); return }
    const pad = 1
    const minX = Math.max(0, b.minX - pad), minY = Math.max(0, b.minY - pad)
    const maxX = Math.min(c.width - 1, b.maxX + pad), maxY = Math.min(c.height - 1, b.maxY + pad)
    const cw = maxX - minX + 1, ch = maxY - minY + 1
    let crop
    try { crop = ctx.getImageData(minX, minY, cw, ch) } catch (_) { showToast('無法讀取繪製範圍'); return }
    const tmp = document.createElement('canvas')
    tmp.width = cw; tmp.height = ch
    const tctx = tmp.getContext('2d')
    if (!tctx) { showToast('無法建立裁切畫布'); return }
    tctx.putImageData(crop, 0, 0)
    try {
      const blob = await new Promise((resolve, reject) => {
        tmp.toBlob(bl => bl ? resolve(bl) : reject(new Error('toBlob')), 'image/png', 1)
      })
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      const lw = Math.round(cw / (c.width / logicalW.value || 1))
      const lh = Math.round(ch / (c.height / logicalH.value || 1))
      showToast(`已複製繪製範圍 PNG（${lw}×${lh}）`)
    } catch (_) { showToast('複製失敗：請使用 HTTPS，或檢查剪貼簿權限') }
  }

  // ── Zoom public API ───────────────────────────────────────────────────────
  function zoomIn() { applyZoomScaleInternal(zoomScale * ZOOM_BTN_FACTOR) }
  function zoomOut() { applyZoomScaleInternal(zoomScale / ZOOM_BTN_FACTOR) }
  function zoomReset() { applyZoomScaleInternal(1) }

  function handleCanvasSizeChange() {
    void applyCanvasSizeFromUserSelect()
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  watch(tool, applyCanvasCursor)

  onMounted(() => {
    const c = canvas()
    if (!c) return
    ctx = c.getContext('2d', { willReadFrequently: true })

    const avInit = getCanvasWrapAvailPx()
    documents.value = [{
      id: genDocId(), title: '分頁 1', zoomScale: 1,
      useViewportSize: true, logicalW: avInit.w, logicalH: avInit.h,
      canvasSnapshot: null, history: [],
    }]
    activeDocIndex.value = 0
    logicalW.value = avInit.w; logicalH.value = avInit.h; zoomScale = 1
    setupHighResCanvas()
    fillCanvasWhiteNoHistory()
    persistActiveDocument()
    syncCanvasSizeSelect()
    applyCanvasCursor()

    // Canvas events
    c.addEventListener('contextmenu', e => e.preventDefault())
    c.addEventListener('pointerdown', e => {
      if (e.pointerType === 'mouse' && e.button === 1) return
      if (e.pointerType === 'mouse' && e.button === 0 && e.altKey) return
      c.setPointerCapture(e.pointerId)
      const { x, y } = clientToCanvas(e.clientX, e.clientY)
      beginStroke(x, y, e.pointerType === 'mouse' && e.button === 2)
      e.preventDefault()
    })
    c.addEventListener('pointermove', e => {
      if (!drawing) return
      const list = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e]
      for (const ev of list) {
        const { x, y } = clientToCanvas(ev.clientX, ev.clientY)
        drawSegment(x, y)
      }
      e.preventDefault()
    })
    const onPointerUp = e => {
      try { c.releasePointerCapture(e.pointerId) } catch (_) {}
      endStroke()
    }
    c.addEventListener('pointerup', onPointerUp)
    c.addEventListener('pointercancel', onPointerUp)
    c.addEventListener('lostpointercapture', onPointerUp)

    // Wrap events
    const wrap = canvasWrap()
    if (wrap) {
      wrap.addEventListener('pointermove', e => {
        if (panDrag && e.pointerId === panDrag.pointerId) {
          panX += e.clientX - panDrag.lastX
          panY += e.clientY - panDrag.lastY
          panDrag.lastX = e.clientX; panDrag.lastY = e.clientY
          syncPanTransform()
        }
        updateCursorPt(e.clientX, e.clientY)
      }, { passive: true })

      wrap.addEventListener('pointerleave', e => {
        const rt = e.relatedTarget
        const footer = appFooter()
        if (rt && footer && footer.contains(rt)) return
        cursorPt.value = '—'
      })

      wrap.addEventListener('pointerdown', e => {
        if (!wrap.classList.contains('canvas-wrap--pannable')) return
        const wantPan = e.button === 1 || (e.button === 0 && e.altKey)
        if (!wantPan || !wrap.contains(e.target)) return
        e.preventDefault(); e.stopPropagation()
        try { wrap.setPointerCapture(e.pointerId) } catch (_) {}
        panDrag = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY }
        wrap.classList.add('canvas-wrap--panning')
      }, true)

      wrap.addEventListener('pointerup', endPanDrag)
      wrap.addEventListener('pointercancel', endPanDrag)
      wrap.addEventListener('lostpointercapture', e => { if (panDrag && e.pointerId === panDrag.pointerId) endPanDrag(e) })

      wrap.addEventListener('wheel', e => {
        if (!wrap.contains(e.target)) return
        e.preventDefault()
        applyZoomScaleInternal(zoomScale * (e.deltaY < 0 ? ZOOM_WHEEL_FACTOR : 1 / ZOOM_WHEEL_FACTOR))
      }, { passive: false })

      const pinchDist = tl => tl.length < 2 ? 0 : Math.hypot(tl[0].clientX - tl[1].clientX, tl[0].clientY - tl[1].clientY)
      wrap.addEventListener('touchstart', e => { if (e.touches.length === 2) { e.preventDefault(); pinchTouchDist = pinchDist(e.touches) } }, { passive: false })
      wrap.addEventListener('touchmove', e => {
        if (e.touches.length === 2 && pinchTouchDist > 1) {
          e.preventDefault()
          const d = pinchDist(e.touches)
          applyZoomScaleInternal(zoomScale * Math.min(1.12, Math.max(1 / 1.12, d / pinchTouchDist)))
          pinchTouchDist = d
        }
      }, { passive: false })
      wrap.addEventListener('touchend', e => { if (e.touches.length < 2) pinchTouchDist = 0 })
      wrap.addEventListener('touchcancel', () => { pinchTouchDist = 0 })
      wrap.addEventListener('gesturestart', e => e.preventDefault(), { passive: false })
      wrap.addEventListener('gesturechange', e => e.preventDefault(), { passive: false })
      wrap.addEventListener('gestureend', e => e.preventDefault(), { passive: false })

      if (typeof ResizeObserver !== 'undefined') {
        new ResizeObserver(() => scheduleViewportLogicalSync()).observe(wrap)
      }
    }

    // Footer hover
    const footer = appFooter()
    if (footer) {
      footer.addEventListener('pointerenter', () => footer.classList.add('app-footer--hover'))
      footer.addEventListener('pointerleave', () => footer.classList.remove('app-footer--hover'))
    }

    // Keyboard shortcuts
    keydownHandler = e => {
      const tag = e.target && e.target.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'OPTION') return
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo() }
      if ((e.ctrlKey || e.metaKey) && (e.code === 'Digit0' || e.code === 'Numpad0')) { e.preventDefault(); applyZoomScaleInternal(1) }
      if (e.ctrlKey || e.metaKey) {
        if (e.code === 'Equal' || e.code === 'NumpadAdd') { e.preventDefault(); applyZoomScaleInternal(zoomScale * ZOOM_BTN_FACTOR) }
        else if (e.code === 'Minus' || e.code === 'NumpadSubtract') { e.preventDefault(); applyZoomScaleInternal(zoomScale / ZOOM_BTN_FACTOR) }
      }
    }
    document.addEventListener('keydown', keydownHandler)

    window.addEventListener('resize', scheduleViewportLogicalSync)
    requestAnimationFrame(() => scheduleViewportLogicalSync())
  })

  onUnmounted(() => {
    window.removeEventListener('resize', scheduleViewportLogicalSync)
    if (keydownHandler) document.removeEventListener('keydown', keydownHandler)
    if (viewportSyncRaf !== null) cancelAnimationFrame(viewportSyncRaf)
  })

  return {
    zoomLabel, cursorPt, documents, activeDocIndex,
    undo, clearCanvas, savePng, copyCanvasPng, copyCanvasPngDrawnBounds,
    switchToDocument, addDocument, closeDocumentAt,
    handleCanvasSizeChange, zoomIn, zoomOut, zoomReset,
  }
}

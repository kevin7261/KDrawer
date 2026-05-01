(function () {
  const canvas = document.getElementById("board");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const colorPicker = document.getElementById("colorPicker");
  const brushSize = document.getElementById("brushSize");
  const brushSizeVal = document.getElementById("brushSizeVal");
  const swatchesEl = document.getElementById("swatches");
  const undoBtn = document.getElementById("undo");
  const clearBtn = document.getElementById("clear");
  const saveBtn = document.getElementById("save");
  const copyPngBtn = document.getElementById("copyPng");
  const copyPngDrawnBtn = document.getElementById("copyPngDrawn");
  const canvasWrap = document.getElementById("canvasWrap");
  const appFooter = document.getElementById("appFooter");
  const canvasPanLayer = document.getElementById("canvasPanLayer");
  const cursorPtEl = document.getElementById("cursorPt");
  const docTabsEl = document.getElementById("docTabs");
  const newDocTabBtn = document.getElementById("newDocTab");
  const btnColor1 = document.getElementById("btnColor1");
  const btnColor2 = document.getElementById("btnColor2");
  const swapColorsBtn = document.getElementById("swapColors");
  const canvasSizePreset = document.getElementById("canvasSizePreset");

  const DEFAULT_LOGICAL_W = 1280;
  const DEFAULT_LOGICAL_H = 800;
  let logicalW = DEFAULT_LOGICAL_W;
  let logicalH = DEFAULT_LOGICAL_H;

  /** 下拉選項：畫布邏輯尺寸跟隨 #canvasWrap 可用區（瀏覽器／視窗可視範圍） */
  const CANVAS_VIEWPORT_OPTION = "viewport";

  /** 跟隨視窗時合併 layout 底部的 resize／同步 */
  let viewportSyncRaf = null;

  /** 常用調色盤色票 */
  const SWATCHES = [
    "#000000",
    "#7f7f7f",
    "#880015",
    "#ed1c24",
    "#ff7f27",
    "#fff200",
    "#22b14c",
    "#00a2e8",
    "#3f48cc",
    "#a349a4",
    "#ffffff",
    "#c3c3c3",
    "#b97a57",
    "#ffaec9",
    "#ffc90e",
    "#efe4b0",
    "#b5e61d",
    "#99d9ea",
    "#7092be",
    "#c8bfe7",
  ];

  let color1 = "#000000";
  let color2 = "#ffffff";
  /** @type {1 | 2} */
  let activeColorSlot = 1;

  let tool = "pencil";
  let drawing = false;
  let lastX = 0;
  let lastY = 0;
  /** @type {{ kind: string; x0: number; y0: number; img: ImageData; isRight: boolean } | null} */
  let dragShape = null;
  /** 顯示縮放倍率（與 fit 相乘）；每個分頁會各自記住 */
  const ZOOM_MIN = 0.15;
  const ZOOM_MAX = 6;
  let zoomScale = 1;

  /** 畫布區平移（無捲軸，以 transform 移動） */
  let panX = 0;
  let panY = 0;
  /** @type {{ pointerId: number; lastX: number; lastY: number } | null} */
  let panDrag = null;
  let pinchTouchDist = 0;

  /** @type {{ id: string; title: string; zoomScale?: number; logicalW?: number; logicalH?: number; canvasSnapshot: ImageData | null; history: ImageData[] }[]} */
  let documents = [];
  let activeDocIndex = 0;

  const history = [];
  const HISTORY_MAX = 40;

  function setupHighResCanvas() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2.5);
    canvas.width = Math.round(logicalW * dpr);
    canvas.height = Math.round(logicalH * dpr);
    applyCanvasDisplaySize();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = "high";
  }

  function clampZoom(z) {
    return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));
  }

  /** @returns {{ w: number; h: number }} 畫布區可用 CSS 像素（與瀏覽器顯示一致） */
  function getCanvasWrapAvailPx() {
    if (!canvasWrap) {
      return { w: Math.max(80, DEFAULT_LOGICAL_W), h: Math.max(80, DEFAULT_LOGICAL_H) };
    }
    const cs = getComputedStyle(canvasWrap);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight) || 0;
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) || 0;
    const rawW = canvasWrap.clientWidth - padX;
    const rawH = canvasWrap.clientHeight - padY;
    if (rawW < 2 || rawH < 2) {
      return { w: DEFAULT_LOGICAL_W, h: DEFAULT_LOGICAL_H };
    }
    return {
      w: Math.max(80, Math.floor(rawW)),
      h: Math.max(80, Math.floor(rawH)),
    };
  }

  /** @param {{ zoomScale?: number; logicalW?: number; logicalH?: number; useViewportSize?: boolean } | null | undefined} d */
  function documentUsesViewport(d) {
    return Boolean(d && d.useViewportSize);
  }

  function syncZoomUi() {
    const el = document.getElementById("zoomLabel");
    if (el) el.textContent = Math.round(zoomScale * 100) + "% · " + logicalW + "×" + logicalH;
  }

  function syncPanTransform() {
    if (canvasPanLayer) {
      canvasPanLayer.style.transform = "translate3d(" + panX + "px, " + panY + "px, 0)";
    }
  }

  function clampPan() {
    if (!canvasWrap || !canvas || !canvasWrap.classList.contains("canvas-wrap--pannable")) return;
    const margin = 2;
    for (let iter = 0; iter < 16; iter++) {
      syncPanTransform();
      const wr = canvasWrap.getBoundingClientRect();
      const cr = canvas.getBoundingClientRect();
      let ax = 0;
      let ay = 0;
      if (cr.left > wr.left + margin) ax = wr.left + margin - cr.left;
      else if (cr.right < wr.right - margin) ax = wr.right - margin - cr.right;
      if (cr.top > wr.top + margin) ay = wr.top + margin - cr.top;
      else if (cr.bottom < wr.bottom - margin) ay = wr.bottom - margin - cr.bottom;
      if (ax === 0 && ay === 0) break;
      panX += ax;
      panY += ay;
    }
    syncPanTransform();
  }

  function endPanDrag(e) {
    if (!panDrag) return;
    if (e && e.pointerId !== undefined && e.pointerId !== panDrag.pointerId) return;
    const pid = panDrag.pointerId;
    panDrag = null;
    if (canvasWrap) {
      canvasWrap.classList.remove("canvas-wrap--panning");
      try {
        canvasWrap.releasePointerCapture(pid);
      } catch (_) {
        /* ignore */
      }
    }
    clampPan();
  }

  function applyZoomScale(next) {
    zoomScale = clampZoom(next);
    const d = documents[activeDocIndex];
    if (d) d.zoomScale = zoomScale;
    applyCanvasDisplaySize();
  }

  function applyCanvasDisplaySize() {
    if (!canvasWrap) {
      canvas.style.width = logicalW * zoomScale + "px";
      canvas.style.height = logicalH * zoomScale + "px";
      syncPanTransform();
      syncZoomUi();
      return;
    }
    const { w: availW, h: availH } = getCanvasWrapAvailPx();
    /* 完整顯示（contain）：整張邏輯畫布都在視區內，比例不足處留白 */
    let fit = Math.min(availW / logicalW, availH / logicalH);
    fit = Math.max(0.12, Math.min(fit, 8));
    const w = logicalW * fit * zoomScale;
    const h = logicalH * fit * zoomScale;
    canvas.style.width = w + "px";
    canvas.style.height = h + "px";
    const needPan = w > availW + 0.5 || h > availH + 0.5;
    canvasWrap.classList.toggle("canvas-wrap--pannable", needPan);
    if (!needPan) {
      panX = 0;
      panY = 0;
    }
    syncPanTransform();
    requestAnimationFrame(() => clampPan());
    syncZoomUi();
  }

  /**
   * 「跟隨視窗」分頁：邏輯畫素 = 目前畫布區 CSS 像素；視窗縮放時左上角保留、必要時留白或裁切。
   * @param {{ preserveDrawing: boolean }} opts
   */
  function resizeActiveLogicalToAvail(opts) {
    const preserveDrawing = opts && opts.preserveDrawing !== false;
    const d = documents[activeDocIndex];
    if (!d || !documentUsesViewport(d)) {
      applyCanvasDisplaySize();
      return;
    }
    const av = getCanvasWrapAvailPx();
    if (av.w === logicalW && av.h === logicalH) {
      applyCanvasDisplaySize();
      syncCanvasSizeSelect();
      return;
    }
    endStroke();
    dragShape = null;
    drawing = false;

    const oldLw = logicalW;
    const oldLh = logicalH;

    /** @type {HTMLCanvasElement | null} */
    let oc = null;
    if (preserveDrawing && canvas.width > 0 && canvas.height > 0) {
      oc = document.createElement("canvas");
      oc.width = canvas.width;
      oc.height = canvas.height;
      const octx = oc.getContext("2d");
      if (octx) octx.drawImage(canvas, 0, 0);
    }

    logicalW = av.w;
    logicalH = av.h;
    d.logicalW = av.w;
    d.logicalH = av.h;

    setupHighResCanvas();
    fillCanvasWhiteNoHistory();

    if (oc) {
      const rw = Math.min(logicalW, oldLw);
      const rh = Math.min(logicalH, oldLh);
      ctx.drawImage(oc, 0, 0, (rw / oldLw) * oc.width, (rh / oldLh) * oc.height, 0, 0, rw, rh);
    }

    history.length = 0;
    d.history = [];
    persistActiveDocument();
    syncCanvasSizeSelect();
    syncZoomUi();
  }

  function scheduleViewportLogicalSync() {
    const d = documents[activeDocIndex];
    if (!documentUsesViewport(d)) {
      applyCanvasDisplaySize();
      return;
    }
    if (viewportSyncRaf !== null) cancelAnimationFrame(viewportSyncRaf);
    viewportSyncRaf = requestAnimationFrame(() => {
      viewportSyncRaf = null;
      resizeActiveLogicalToAvail({ preserveDrawing: true });
    });
  }

  function pushHistory() {
    history.push(ctx.getImageData(0, 0, canvas.width, canvas.height));
    if (history.length > HISTORY_MAX) history.shift();
  }

  function restoreSnapshot(data) {
    ctx.putImageData(data, 0, 0);
  }

  function undo() {
    if (history.length === 0) return;
    const snap = history.pop();
    restoreSnapshot(snap);
  }

  function genDocId() {
    return "doc-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
  }

  function cloneImageData(src) {
    if (!src || !src.data) return null;
    try {
      return new ImageData(new Uint8ClampedArray(src.data), src.width, src.height);
    } catch (_) {
      return null;
    }
  }

  function fillCanvasWhiteNoHistory() {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  function persistActiveDocument() {
    const d = documents[activeDocIndex];
    if (!d) return;
    d.zoomScale = zoomScale;
    d.logicalW = logicalW;
    d.logicalH = logicalH;
    d.canvasSnapshot = cloneImageData(ctx.getImageData(0, 0, canvas.width, canvas.height));
    d.history = history.map((h) => cloneImageData(h)).filter(Boolean);
  }

  function normalizeDocLogicalSize(d) {
    const minDim = 16;
    const maxDim = 8192;
    let w;
    let h;
    if (documentUsesViewport(d)) {
      const av = getCanvasWrapAvailPx();
      w = av.w;
      h = av.h;
    } else {
      w =
        typeof d.logicalW === "number" && Number.isFinite(d.logicalW) ? Math.round(d.logicalW) : DEFAULT_LOGICAL_W;
      h =
        typeof d.logicalH === "number" && Number.isFinite(d.logicalH) ? Math.round(d.logicalH) : DEFAULT_LOGICAL_H;
    }
    w = Math.min(maxDim, Math.max(minDim, w));
    h = Math.min(maxDim, Math.max(minDim, h));
    d.logicalW = w;
    d.logicalH = h;
    return { w, h };
  }

  function loadDocumentAt(index) {
    const d = documents[index];
    if (!d) return;

    panX = 0;
    panY = 0;
    panDrag = null;
    if (canvasWrap) canvasWrap.classList.remove("canvas-wrap--panning");

    const oldSnap = d.canvasSnapshot ? cloneImageData(d.canvasSnapshot) : null;
    const oldLwStored =
      typeof d.logicalW === "number" && Number.isFinite(d.logicalW) ? Math.round(d.logicalW) : DEFAULT_LOGICAL_W;
    const oldLhStored =
      typeof d.logicalH === "number" && Number.isFinite(d.logicalH) ? Math.round(d.logicalH) : DEFAULT_LOGICAL_H;

    const { w, h } = normalizeDocLogicalSize(d);
    logicalW = w;
    logicalH = h;
    zoomScale = clampZoom(typeof d.zoomScale === "number" && Number.isFinite(d.zoomScale) ? d.zoomScale : 1);
    setupHighResCanvas();
    history.length = 0;

    if (oldSnap && oldSnap.width === canvas.width && oldSnap.height === canvas.height) {
      restoreSnapshot(oldSnap);
      (d.history || []).forEach((snap) => {
        const c = cloneImageData(snap);
        if (c) history.push(c);
      });
    } else if (oldSnap && oldLwStored > 0 && oldLhStored > 0) {
      fillCanvasWhiteNoHistory();
      const t = document.createElement("canvas");
      t.width = oldSnap.width;
      t.height = oldSnap.height;
      const tctx = t.getContext("2d");
      if (tctx) tctx.putImageData(oldSnap, 0, 0);
      const rw = Math.min(logicalW, oldLwStored);
      const rh = Math.min(logicalH, oldLhStored);
      ctx.drawImage(t, 0, 0, (rw / oldLwStored) * t.width, (rh / oldLhStored) * t.height, 0, 0, rw, rh);
      d.history = [];
    } else {
      fillCanvasWhiteNoHistory();
      (d.history || []).forEach((snap) => {
        const c = cloneImageData(snap);
        if (c) history.push(c);
      });
    }
    syncCanvasSizeSelect();
  }

  function parseCanvasSizeValue(val) {
    const m = String(val || "").match(/^(\d+)\s*[x×]\s*(\d+)$/i);
    if (!m) return null;
    const w = parseInt(m[1], 10);
    const h = parseInt(m[2], 10);
    if (w < 16 || h < 16 || w > 8192 || h > 8192) return null;
    return { w, h };
  }

  /**
   * @param {string} message
   * @returns {Promise<boolean>}
   */
  function showConfirm(message) {
    return new Promise((resolve) => {
      const modalEl = document.getElementById("appConfirmModal");
      const bodyEl = document.getElementById("appConfirmModalBody");
      const okBtn = document.getElementById("appConfirmModalOk");
      if (!modalEl || !bodyEl || !okBtn || typeof bootstrap === "undefined" || !bootstrap.Modal) {
        resolve(window.confirm(message));
        return;
      }
      bodyEl.textContent = message;
      const inst = bootstrap.Modal.getOrCreateInstance(modalEl);
      let settled = false;
      const done = (v) => {
        if (settled) return;
        settled = true;
        resolve(v);
      };
      const onOk = (e) => {
        e.preventDefault();
        done(true);
        inst.hide();
      };
      const onHidden = () => {
        modalEl.removeEventListener("hidden.bs.modal", onHidden);
        okBtn.removeEventListener("click", onOk);
        done(false);
      };
      okBtn.addEventListener("click", onOk, { once: true });
      modalEl.addEventListener("hidden.bs.modal", onHidden, { once: true });
      inst.show();
    });
  }

  function syncCanvasSizeSelect() {
    if (!canvasSizePreset) return;
    const d = documents[activeDocIndex];
    if (documentUsesViewport(d)) {
      canvasSizePreset.value = CANVAS_VIEWPORT_OPTION;
      const staleCustom = canvasSizePreset.querySelector("option[data-custom-size]");
      if (staleCustom) staleCustom.remove();
      return;
    }
    const key = logicalW + "x" + logicalH;
    const opt = Array.from(canvasSizePreset.options).find((o) => o.value === key);
    if (opt) {
      const staleCustom = canvasSizePreset.querySelector("option[data-custom-size]");
      if (staleCustom) staleCustom.remove();
      canvasSizePreset.value = key;
      return;
    }
    let custom = canvasSizePreset.querySelector("option[data-custom-size]");
    if (!custom) {
      custom = document.createElement("option");
      custom.setAttribute("data-custom-size", "1");
      canvasSizePreset.insertBefore(custom, canvasSizePreset.firstChild);
    }
    custom.value = key;
    custom.textContent = logicalW + " × " + logicalH;
    canvasSizePreset.value = key;
  }

  async function applyCanvasSizeFromUserSelect() {
    if (!canvasSizePreset) return;

    if (canvasSizePreset.value === CANVAS_VIEWPORT_OPTION) {
      const d = documents[activeDocIndex];
      if (!d) return;
      if (documentUsesViewport(d)) {
        syncCanvasSizeSelect();
        return;
      }
      const ok = await showConfirm(
        "改為「跟隨視窗」後，畫布會隨瀏覽器／視窗調整；版面變小時僅保留左上角內容。確定嗎？"
      );
      if (!ok) {
        syncCanvasSizeSelect();
        return;
      }
      endStroke();
      dragShape = null;
      drawing = false;
      d.useViewportSize = true;
      resizeActiveLogicalToAvail({ preserveDrawing: true });
      return;
    }

    const parsed = parseCanvasSizeValue(canvasSizePreset.value);
    if (!parsed) return;

    const dFixed = documents[activeDocIndex];
    if (!dFixed) return;
    if (parsed.w === logicalW && parsed.h === logicalH && !documentUsesViewport(dFixed)) return;

    const ok2 = await showConfirm("改變畫布大小會清除此分頁內容並重設復原紀錄，確定嗎？");
    if (!ok2) {
      syncCanvasSizeSelect();
      return;
    }
    endStroke();
    dragShape = null;
    drawing = false;
    dFixed.useViewportSize = false;
    dFixed.logicalW = parsed.w;
    dFixed.logicalH = parsed.h;
    logicalW = parsed.w;
    logicalH = parsed.h;
    setupHighResCanvas();
    fillCanvasWhiteNoHistory();
    history.length = 0;
    dFixed.history = [];
    dFixed.canvasSnapshot = null;
    persistActiveDocument();
    applyCanvasDisplaySize();
  }

  function switchToDocument(nextIndex) {
    if (nextIndex < 0 || nextIndex >= documents.length || nextIndex === activeDocIndex) return;
    endStroke();
    dragShape = null;
    drawing = false;
    persistActiveDocument();
    activeDocIndex = nextIndex;
    loadDocumentAt(activeDocIndex);
    renderDocTabs();
    applyCanvasDisplaySize();
  }

  function addDocument() {
    endStroke();
    dragShape = null;
    drawing = false;
    persistActiveDocument();
    const nextNum = documents.length + 1;
    const vp = canvasSizePreset && canvasSizePreset.value === CANVAS_VIEWPORT_OPTION;
    /** @type {number} */
    let nw;
    /** @type {number} */
    let nh;
    /** @type {boolean} */
    let useVp;
    if (vp) {
      const av = getCanvasWrapAvailPx();
      nw = av.w;
      nh = av.h;
      useVp = true;
    } else {
      const fromSelect = parseCanvasSizeValue(canvasSizePreset.value);
      nw = fromSelect ? fromSelect.w : logicalW;
      nh = fromSelect ? fromSelect.h : logicalH;
      useVp = false;
    }
    documents.push({
      id: genDocId(),
      title: "分頁 " + nextNum,
      zoomScale: 1,
      useViewportSize: useVp,
      logicalW: nw,
      logicalH: nh,
      canvasSnapshot: null,
      history: [],
    });
    activeDocIndex = documents.length - 1;
    logicalW = nw;
    logicalH = nh;
    zoomScale = 1;
    setupHighResCanvas();
    fillCanvasWhiteNoHistory();
    history.length = 0;
    persistActiveDocument();
    renderDocTabs();
    applyCanvasDisplaySize();
  }

  function closeDocumentAt(closeIdx) {
    if (documents.length <= 1) {
      showToast("至少保留一個分頁");
      return;
    }
    endStroke();
    dragShape = null;
    drawing = false;
    persistActiveDocument();
    const wasActive = closeIdx === activeDocIndex;
    documents.splice(closeIdx, 1);
    if (wasActive) {
      activeDocIndex = Math.min(closeIdx, documents.length - 1);
    } else if (activeDocIndex > closeIdx) {
      activeDocIndex--;
    }
    loadDocumentAt(activeDocIndex);
    renderDocTabs();
    applyCanvasDisplaySize();
  }

  function renderDocTabs() {
    if (!docTabsEl) return;
    docTabsEl.innerHTML = "";
    documents.forEach((doc, i) => {
      const wrap = document.createElement("div");
      wrap.className = "doc-tab" + (i === activeDocIndex ? " doc-tab--active" : "");

      const main = document.createElement("button");
      main.type = "button";
      main.className = "doc-tab__main";
      main.setAttribute("role", "tab");
      main.setAttribute("aria-selected", i === activeDocIndex ? "true" : "false");
      main.textContent = doc.title;
      main.addEventListener("click", () => switchToDocument(i));

      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "btn btn-sm btn-outline-secondary border-0 doc-tab__close";
      closeBtn.setAttribute("aria-label", "關閉「" + doc.title + "」");
      closeBtn.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
      closeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        closeDocumentAt(i);
      });

      wrap.appendChild(main);
      wrap.appendChild(closeBtn);
      docTabsEl.appendChild(wrap);
    });
  }

  function clientToCanvas(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 1e-6 || rect.height < 1e-6) {
      return { x: 0, y: 0 };
    }
    const scaleX = logicalW / rect.width;
    const scaleY = logicalH / rect.height;
    return {
      x: (clientX - rect.left) * scaleX,
      y: (clientY - rect.top) * scaleY,
    };
  }

  function clearCursorPt() {
    if (cursorPtEl) cursorPtEl.textContent = "—";
  }

  function updateCursorPt(clientX, clientY) {
    if (!cursorPtEl) return;
    const rect = canvas.getBoundingClientRect();
    const tol = 0.5;
    if (
      clientX < rect.left - tol ||
      clientX > rect.right + tol ||
      clientY < rect.top - tol ||
      clientY > rect.bottom + tol
    ) {
      cursorPtEl.textContent = "—";
      return;
    }
    const { x, y } = clientToCanvas(clientX, clientY);
    let xi = Math.round(x);
    let yi = Math.round(y);
    const maxXi = Math.max(0, logicalW - 1);
    const maxYi = Math.max(0, logicalH - 1);
    xi = Math.max(0, Math.min(maxXi, xi));
    yi = Math.max(0, Math.min(maxYi, yi));
    cursorPtEl.textContent = xi + ", " + yi + " px";
  }

  function rgbToHex(r, g, b) {
    const h = (n) => n.toString(16).padStart(2, "0");
    return "#" + h(r) + h(g) + h(b);
  }

  function getStrokeColor(isRight) {
    return isRight ? color2 : color1;
  }

  function syncColorUi() {
    btnColor1.style.background = color1;
    btnColor2.style.background = color2;
    const v = activeColorSlot === 1 ? color1 : color2;
    if (colorPicker.value.toLowerCase() !== v.toLowerCase()) colorPicker.value = v;
    btnColor1.classList.toggle("active", activeColorSlot === 1);
    btnColor2.classList.toggle("active", activeColorSlot === 2);
  }

  function setActiveSlot(slot) {
    activeColorSlot = slot;
    colorPicker.value = slot === 1 ? color1 : color2;
    syncColorUi();
  }

  function sampleAtLogical(logicalX, logicalY) {
    const w = canvas.width;
    const h = canvas.height;
    const px = Math.min(w - 1, Math.max(0, Math.floor((logicalX / logicalW) * w)));
    const py = Math.min(h - 1, Math.max(0, Math.floor((logicalY / logicalH) * h)));
    const d = ctx.getImageData(px, py, 1, 1).data;
    return rgbToHex(d[0], d[1], d[2]);
  }

  function applyCanvasCursor() {
    if (tool === "pick") canvas.style.cursor = "cell";
    else canvas.style.cursor = "crosshair";
  }

  /** 筆刷／鉛筆／橡皮擦的線寬（每段線讀一次，拖曳時改滑桿也會生效） */
  function applyFreehandStrokeStyle() {
    let w = Number(brushSize.value);
    if (!Number.isFinite(w) || w < 1) w = 1;
    if (w > 48) w = 48;

    ctx.shadowBlur = 0;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 0;
    ctx.shadowColor = "transparent";

    if (tool === "pencil") {
      ctx.lineWidth = Math.max(1, w * 0.82);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
    } else if (tool === "pen") {
      ctx.lineWidth = Math.max(1, w * 1.28);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const ss = ctx.strokeStyle;
      ctx.shadowColor = typeof ss === "string" ? ss : "#000000";
      ctx.shadowBlur = Math.min(72, w * 3.5);
    } else {
      ctx.lineWidth = w;
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
    }
    ctx.miterLimit = 2;
  }

  function strokeRoundRect(x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    if (typeof ctx.roundRect === "function") {
      ctx.beginPath();
      ctx.roundRect(x, y, w, h, rr);
      ctx.stroke();
      return;
    }
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.lineTo(x + w - rr, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
    ctx.lineTo(x + w, y + h - rr);
    ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
    ctx.lineTo(x + rr, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
    ctx.lineTo(x, y + rr);
    ctx.quadraticCurveTo(x, y, x + rr, y);
    ctx.closePath();
    ctx.stroke();
  }

  function drawShapePreview(x1, y1) {
    if (!dragShape) return;
    restoreSnapshot(dragShape.img);
    const c = getStrokeColor(dragShape.isRight);
    ctx.save();
    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = c;
    ctx.lineWidth = Number(brushSize.value);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    const x0 = dragShape.x0;
    const y0 = dragShape.y0;
    const nx = Math.min(x0, x1);
    const ny = Math.min(y0, y1);
    const nw = Math.abs(x1 - x0);
    const nh = Math.abs(y1 - y0);

    if (dragShape.kind === "line") {
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    } else if (dragShape.kind === "rect") {
      if (nw < 1 && nh < 1) return;
      ctx.strokeRect(nx, ny, Math.max(nw, 0.5), Math.max(nh, 0.5));
    } else if (dragShape.kind === "ellipse") {
      if (nw < 1 || nh < 1) return;
      const cx = nx + nw / 2;
      const cy = ny + nh / 2;
      const rx = nw / 2;
      const ry = nh / 2;
      ctx.beginPath();
      ctx.ellipse(cx, cy, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
    } else if (dragShape.kind === "roundrect") {
      if (nw < 1 && nh < 1) return;
      const rad = Math.min(12, nw / 4, nh / 4, 8);
      strokeRoundRect(nx, ny, Math.max(nw, 0.5), Math.max(nh, 0.5), rad);
    }
    ctx.restore();
    lastX = x1;
    lastY = y1;
  }

  function beginStroke(x, y, isRightButton) {
    if (tool === "pick") {
      const hex = sampleAtLogical(x, y);
      if (isRightButton) {
        color2 = hex;
        activeColorSlot = 2;
      } else {
        color1 = hex;
        activeColorSlot = 1;
      }
      colorPicker.value = hex;
      syncColorUi();
      return;
    }
    if (tool === "fill") {
      pushHistory();
      const fillHex = getStrokeColor(isRightButton);
      floodFill(x, y, fillHex);
      return;
    }
    if (tool === "line" || tool === "rect" || tool === "ellipse" || tool === "roundrect") {
      pushHistory();
      dragShape = {
        kind: tool,
        x0: x,
        y0: y,
        img: ctx.getImageData(0, 0, canvas.width, canvas.height),
        isRight: isRightButton,
      };
      drawing = true;
      lastX = x;
      lastY = y;
      return;
    }

    pushHistory();
    drawing = true;
    lastX = x;
    lastY = y;

    const isEraser = tool === "eraser";
    const useBg = isEraser || isRightButton;
    const strokeColor = useBg ? color2 : color1;

    ctx.globalCompositeOperation = "source-over";
    ctx.strokeStyle = strokeColor;
    applyFreehandStrokeStyle();
  }

  function drawSegment(x, y) {
    if (!drawing) return;
    if (dragShape) {
      drawShapePreview(x, y);
      return;
    }

    const dx = x - lastX;
    const dy = y - lastY;
    if (dx * dx + dy * dy < 0.25) return;
    applyFreehandStrokeStyle();
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(x, y);
    ctx.stroke();
    lastX = x;
    lastY = y;
  }

  function endStroke() {
    if (dragShape) dragShape = null;
    drawing = false;
    ctx.globalCompositeOperation = "source-over";
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
  }

  function hexToRgb(hex) {
    const m = hex.replace("#", "").match(/^([0-9a-f]{6})$/i);
    if (!m) return { r: 0, g: 0, b: 0, a: 255 };
    const n = parseInt(m[1], 16);
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 255 };
  }

  function floodFill(sx, sy, fillHex) {
    const w = canvas.width;
    const h = canvas.height;
    const sxPx = Math.min(w - 1, Math.max(0, Math.floor((sx / logicalW) * w)));
    const syPx = Math.min(h - 1, Math.max(0, Math.floor((sy / logicalH) * h)));
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    const targetIdx = (syPx * w + sxPx) * 4;
    const tr = d[targetIdx];
    const tg = d[targetIdx + 1];
    const tb = d[targetIdx + 2];
    const ta = d[targetIdx + 3];
    const fill = hexToRgb(fillHex);
    if (tr === fill.r && tg === fill.g && tb === fill.b && ta === fill.a) return;

    const stack = [[sxPx, syPx]];
    const seen = new Uint8Array(w * h);

    function match(i) {
      return d[i] === tr && d[i + 1] === tg && d[i + 2] === tb && d[i + 3] === ta;
    }

    while (stack.length) {
      const [px, py] = stack.pop();
      if (px < 0 || py < 0 || px >= w || py >= h) continue;
      const p = py * w + px;
      if (seen[p]) continue;
      seen[p] = 1;
      const i = p * 4;
      if (!match(i)) continue;
      d[i] = fill.r;
      d[i + 1] = fill.g;
      d[i + 2] = fill.b;
      d[i + 3] = fill.a;
      stack.push([px + 1, py], [px - 1, py], [px, py + 1], [px, py - 1]);
    }
    ctx.putImageData(img, 0, 0);
  }

  function clearCanvas() {
    pushHistory();
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
  }

  function savePng() {
    const a = document.createElement("a");
    a.download = "drawing-" + new Date().toISOString().slice(0, 19).replace(/:/g, "-") + ".png";
    a.href = canvas.toDataURL("image/png");
    a.click();
  }

  function showToast(message) {
    const toastEl = document.getElementById("appToast");
    const bodyEl = document.getElementById("appToastBody");
    if (!toastEl || !bodyEl) return;
    bodyEl.textContent = message;
    if (typeof bootstrap !== "undefined" && bootstrap.Toast) {
      const t = bootstrap.Toast.getOrCreateInstance(toastEl, { autohide: true, delay: 2800 });
      t.show();
    } else {
      toastEl.classList.add("show");
      clearTimeout(showToast._timer);
      showToast._timer = setTimeout(() => {
        toastEl.classList.remove("show");
      }, 2800);
    }
  }

  async function copyCanvasPng() {
    if (!navigator.clipboard || typeof ClipboardItem === "undefined") {
      showToast("此環境不支援複製圖片到剪貼簿");
      return;
    }
    try {
      const blob = await new Promise((resolve, reject) => {
        canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("toBlob"))), "image/png", 1);
      });
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      showToast("已複製 PNG 到剪貼簿");
    } catch (_) {
      showToast("複製失敗：請使用 HTTPS，或檢查剪貼簿權限");
    }
  }

  /**
   * 與 fillCanvasWhiteNoHistory／清空相同：視為「未繪製」的像素（RGB 255,255,255 不透明）。
   * @param {ImageData} imageData
   * @returns {{ minX: number; minY: number; maxX: number; maxY: number } | null}
   */
  function getDrawnPixelBounds(imageData) {
    const w = imageData.width;
    const h = imageData.height;
    const d = imageData.data;
    let minX = w;
    let minY = h;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < h; y++) {
      const row = y * w * 4;
      for (let x = 0; x < w; x++) {
        const i = row + x * 4;
        if (d[i] !== 255 || d[i + 1] !== 255 || d[i + 2] !== 255 || d[i + 3] !== 255) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX < minX || maxY < minY) return null;
    return { minX, minY, maxX, maxY };
  }

  /** 僅複製非留白區域的 PNG（與 copyCanvasPng 分開，不改既有行為） */
  async function copyCanvasPngDrawnBounds() {
    if (!navigator.clipboard || typeof ClipboardItem === "undefined") {
      showToast("此環境不支援複製圖片到剪貼簿");
      return;
    }
    let img;
    try {
      img = ctx.getImageData(0, 0, canvas.width, canvas.height);
    } catch (_) {
      showToast("無法讀取畫布像素");
      return;
    }
    const b = getDrawnPixelBounds(img);
    if (!b) {
      showToast("目前沒有繪製內容（全為留白）");
      return;
    }
    const pad = 1;
    const minX = Math.max(0, b.minX - pad);
    const minY = Math.max(0, b.minY - pad);
    const maxX = Math.min(canvas.width - 1, b.maxX + pad);
    const maxY = Math.min(canvas.height - 1, b.maxY + pad);
    const cw = maxX - minX + 1;
    const ch = maxY - minY + 1;
    let crop;
    try {
      crop = ctx.getImageData(minX, minY, cw, ch);
    } catch (_) {
      showToast("無法讀取繪製範圍");
      return;
    }
    const tmp = document.createElement("canvas");
    tmp.width = cw;
    tmp.height = ch;
    const tctx = tmp.getContext("2d");
    if (!tctx) {
      showToast("無法建立裁切畫布");
      return;
    }
    tctx.putImageData(crop, 0, 0);
    try {
      const blob = await new Promise((resolve, reject) => {
        tmp.toBlob((bl) => (bl ? resolve(bl) : reject(new Error("toBlob"))), "image/png", 1);
      });
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      const dprX = canvas.width / logicalW || 1;
      const dprY = canvas.height / logicalH || 1;
      const lw = Math.round(cw / dprX);
      const lh = Math.round(ch / dprY);
      showToast("已複製繪製範圍 PNG（" + lw + "×" + lh + "）");
    } catch (_) {
      showToast("複製失敗：請使用 HTTPS，或檢查剪貼簿權限");
    }
  }

  const avInit = getCanvasWrapAvailPx();
  documents = [
    {
      id: genDocId(),
      title: "分頁 1",
      zoomScale: 1,
      useViewportSize: true,
      logicalW: avInit.w,
      logicalH: avInit.h,
      canvasSnapshot: null,
      history: [],
    },
  ];
  activeDocIndex = 0;
  logicalW = avInit.w;
  logicalH = avInit.h;
  zoomScale = 1;
  setupHighResCanvas();
  fillCanvasWhiteNoHistory();
  syncColorUi();

  persistActiveDocument();
  syncCanvasSizeSelect();
  renderDocTabs();
  if (newDocTabBtn) {
    newDocTabBtn.addEventListener("click", addDocument);
  }
  if (canvasSizePreset) {
    canvasSizePreset.addEventListener("change", () => {
      void applyCanvasSizeFromUserSelect();
    });
  }

  if (appFooter) {
    appFooter.addEventListener("pointerenter", () => appFooter.classList.add("app-footer--hover"));
    appFooter.addEventListener("pointerleave", () => appFooter.classList.remove("app-footer--hover"));
  }

  SWATCHES.forEach((hex) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch btn btn-sm p-0 border";
    b.style.background = hex;
    b.setAttribute("aria-label", "色票 " + hex);
    b.addEventListener("click", () => {
      if (activeColorSlot === 1) color1 = hex;
      else color2 = hex;
      colorPicker.value = hex;
      syncColorUi();
    });
    swatchesEl.appendChild(b);
  });

  colorPicker.addEventListener("input", () => {
    const v = colorPicker.value;
    if (activeColorSlot === 1) color1 = v;
    else color2 = v;
    syncColorUi();
  });

  btnColor1.addEventListener("click", () => setActiveSlot(1));
  btnColor2.addEventListener("click", () => setActiveSlot(2));

  swapColorsBtn.addEventListener("click", () => {
    const t = color1;
    color1 = color2;
    color2 = t;
    syncColorUi();
  });

  brushSize.addEventListener("input", () => {
    brushSizeVal.textContent = brushSize.value;
  });

  document.querySelectorAll(".ctrl-tool").forEach((btn) => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".ctrl-tool").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      tool = btn.getAttribute("data-tool");
      applyCanvasCursor();
    });
  });

  undoBtn.addEventListener("click", undo);
  clearBtn.addEventListener("click", clearCanvas);
  saveBtn.addEventListener("click", savePng);
  if (copyPngBtn) {
    copyPngBtn.addEventListener("click", () => {
      copyCanvasPng();
    });
  }
  if (copyPngDrawnBtn) {
    copyPngDrawnBtn.addEventListener("click", () => {
      void copyCanvasPngDrawnBounds();
    });
  }

  const zoomInBtn = document.getElementById("zoomInBtn");
  const zoomOutBtn = document.getElementById("zoomOutBtn");
  const zoomLabelBtn = document.getElementById("zoomLabel");
  const ZOOM_BTN_FACTOR = 1.15;
  const ZOOM_WHEEL_FACTOR = 1.06;
  if (zoomInBtn) zoomInBtn.addEventListener("click", () => applyZoomScale(zoomScale * ZOOM_BTN_FACTOR));
  if (zoomOutBtn) zoomOutBtn.addEventListener("click", () => applyZoomScale(zoomScale / ZOOM_BTN_FACTOR));
  if (zoomLabelBtn) zoomLabelBtn.addEventListener("click", () => applyZoomScale(1));

  if (canvasWrap) {
    canvasWrap.addEventListener(
      "pointermove",
      (e) => {
        if (panDrag && e.pointerId === panDrag.pointerId) {
          panX += e.clientX - panDrag.lastX;
          panY += e.clientY - panDrag.lastY;
          panDrag.lastX = e.clientX;
          panDrag.lastY = e.clientY;
          syncPanTransform();
        }
        updateCursorPt(e.clientX, e.clientY);
      },
      { passive: true }
    );
    canvasWrap.addEventListener("pointerleave", (e) => {
      const rt = e.relatedTarget;
      if (rt && appFooter && appFooter.contains(/** @type {Node} */ (rt))) return;
      clearCursorPt();
    });
    canvasWrap.addEventListener(
      "pointerdown",
      (e) => {
        if (!canvasWrap.classList.contains("canvas-wrap--pannable")) return;
        const wantPan = e.button === 1 || (e.button === 0 && e.altKey);
        if (!wantPan) return;
        if (!canvasWrap.contains(e.target)) return;
        e.preventDefault();
        e.stopPropagation();
        try {
          canvasWrap.setPointerCapture(e.pointerId);
        } catch (_) {
          /* ignore */
        }
        panDrag = { pointerId: e.pointerId, lastX: e.clientX, lastY: e.clientY };
        canvasWrap.classList.add("canvas-wrap--panning");
      },
      true
    );
    canvasWrap.addEventListener("pointerup", endPanDrag);
    canvasWrap.addEventListener("pointercancel", endPanDrag);
    canvasWrap.addEventListener("lostpointercapture", (e) => {
      if (panDrag && e.pointerId === panDrag.pointerId) endPanDrag(e);
    });
    canvasWrap.addEventListener(
      "wheel",
      (e) => {
        if (!canvasWrap.contains(e.target)) return;
        e.preventDefault();
        const mult = e.deltaY < 0 ? ZOOM_WHEEL_FACTOR : 1 / ZOOM_WHEEL_FACTOR;
        applyZoomScale(zoomScale * mult);
      },
      { passive: false }
    );

    function touchPinchDist(tl) {
      if (tl.length < 2) return 0;
      const a = tl[0];
      const b = tl[1];
      return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
    }
    canvasWrap.addEventListener(
      "touchstart",
      (e) => {
        if (e.touches.length === 2) {
          e.preventDefault();
          pinchTouchDist = touchPinchDist(e.touches);
        }
      },
      { passive: false }
    );
    canvasWrap.addEventListener(
      "touchmove",
      (e) => {
        if (e.touches.length === 2 && pinchTouchDist > 1) {
          e.preventDefault();
          const d = touchPinchDist(e.touches);
          let ratio = d / pinchTouchDist;
          ratio = Math.min(1.12, Math.max(1 / 1.12, ratio));
          applyZoomScale(zoomScale * ratio);
          pinchTouchDist = d;
        }
      },
      { passive: false }
    );
    canvasWrap.addEventListener("touchend", (e) => {
      if (e.touches.length < 2) pinchTouchDist = 0;
    });
    canvasWrap.addEventListener("touchcancel", () => {
      pinchTouchDist = 0;
    });

    /* Safari（iOS）：避免瀏覽器搶走雙指縮放，讓畫布區用自訂捏合縮放 */
    canvasWrap.addEventListener(
      "gesturestart",
      (e) => {
        e.preventDefault();
      },
      { passive: false }
    );
    canvasWrap.addEventListener(
      "gesturechange",
      (e) => {
        e.preventDefault();
      },
      { passive: false }
    );
    canvasWrap.addEventListener(
      "gestureend",
      (e) => {
        e.preventDefault();
      },
      { passive: false }
    );
  }

  canvas.addEventListener("contextmenu", (e) => e.preventDefault());

  function pointerDown(e) {
    if (e.pointerType === "mouse" && e.button === 1) return;
    if (e.pointerType === "mouse" && e.button === 0 && e.altKey) return;
    canvas.setPointerCapture(e.pointerId);
    const { x, y } = clientToCanvas(e.clientX, e.clientY);
    const right = e.pointerType === "mouse" && e.button === 2;
    beginStroke(x, y, right);
    e.preventDefault();
  }

  function pointerMove(e) {
    if (!drawing) return;
    const list = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : [e];
    for (let i = 0; i < list.length; i++) {
      const ev = list[i];
      const { x, y } = clientToCanvas(ev.clientX, ev.clientY);
      drawSegment(x, y);
    }
    e.preventDefault();
  }

  function pointerUp(e) {
    try {
      canvas.releasePointerCapture(e.pointerId);
    } catch (_) {
      /* ignore */
    }
    endStroke();
  }

  canvas.addEventListener("pointerdown", pointerDown);
  canvas.addEventListener("pointermove", pointerMove);
  canvas.addEventListener("pointerup", pointerUp);
  canvas.addEventListener("pointercancel", pointerUp);
  canvas.addEventListener("lostpointercapture", pointerUp);

  document.addEventListener("keydown", (e) => {
    const tag = e.target && e.target.tagName;
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || tag === "OPTION") return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") {
      e.preventDefault();
      undo();
    }
    if ((e.ctrlKey || e.metaKey) && (e.code === "Digit0" || e.code === "Numpad0")) {
      e.preventDefault();
      applyZoomScale(1);
    }
    if (e.ctrlKey || e.metaKey) {
      if (e.code === "Equal" || e.code === "NumpadAdd") {
        e.preventDefault();
        applyZoomScale(zoomScale * ZOOM_BTN_FACTOR);
      } else if (e.code === "Minus" || e.code === "NumpadSubtract") {
        e.preventDefault();
        applyZoomScale(zoomScale / ZOOM_BTN_FACTOR);
      }
    }
  });

  if (canvasWrap && typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => scheduleViewportLogicalSync()).observe(canvasWrap);
  }
  window.addEventListener("resize", scheduleViewportLogicalSync);
  requestAnimationFrame(() => scheduleViewportLogicalSync());

  applyCanvasCursor();
})();

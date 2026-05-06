<template>
  <div class="app">

    <!-- ── 頂部控制列 ── -->
    <header
      class="control-bar kd-toolbar d-flex flex-wrap align-items-center justify-content-start gap-2 w-100 py-2 px-3"
      aria-label="控制列"
    >
      <!-- Google Drive：已設定時僅「登入」或「登出」一鍵 -->
      <template v-if="!driveState.configured">
        <div class="d-flex align-items-center kd-drive-zone kd-drive-zone--toolbar flex-shrink-0" role="region" aria-label="雲端同步">
          <span class="kd-drive-status kd-drive-status--off d-inline-flex align-items-center gap-1" title="尚未設定 VITE_GOOGLE_CLIENT_ID">
            <span class="kd-drive-label">雲端未設定</span>
          </span>
        </div>
        <div class="vr opacity-50 align-self-center control-bar-vr" role="presentation"></div>
      </template>
      <template v-else>
        <div class="d-flex align-items-center kd-drive-zone kd-drive-zone--toolbar flex-shrink-0" role="region" aria-label="雲端同步">
          <button
            v-if="!driveState.signedIn"
            type="button"
            class="btn btn-sm btn-outline-light ctrl-action ctrl-action--accent px-3 text-nowrap flex-shrink-0"
            :disabled="driveState.busy"
            title="使用 Google 帳號登入，啟用雲端同步"
            :aria-label="driveState.busy ? '登入中' : '登入雲端'"
            @click="driveSignIn()"
          >
            {{ driveState.busy ? '登入中' : '登入' }}
          </button>
          <button
            v-else
            type="button"
            class="btn btn-sm btn-outline-light ctrl-action ctrl-action--danger px-3 text-nowrap flex-shrink-0"
            :disabled="driveState.busy"
            title="登出 Google Drive（改為僅本機）"
            aria-label="登出雲端"
            @click="driveSignOut()"
          >
            登出
          </button>
        </div>
        <div class="vr opacity-50 align-self-center control-bar-vr" role="presentation"></div>
      </template>

      <!-- 動作群組 -->
      <div class="btn-group btn-group-sm" role="group" aria-label="剪貼簿與檔案">
        <button type="button" class="btn btn-sm btn-outline-light ctrl-action btn-icon-tiny p-0"
          title="復原上一步繪圖（可多次）"
          @click="undo" aria-label="復原">
          <i class="fa-solid fa-arrow-rotate-left" aria-hidden="true"></i>
        </button>
        <button type="button" class="btn btn-sm btn-outline-light ctrl-action ctrl-action--accent btn-icon-tiny p-0"
          title="將整張畫布複製為 PNG 到剪貼簿"
          @click="copyCanvasPng" aria-label="複製 PNG">
          <i class="fa-solid fa-copy" aria-hidden="true"></i>
        </button>
        <button type="button" class="btn btn-sm btn-outline-light ctrl-action ctrl-action--accent btn-icon-tiny p-0"
          title="只複製有內容的範圍（裁切邊界）為 PNG"
          @click="copyCanvasPngDrawnBounds" aria-label="複製繪製範圍 PNG">
          <i class="fa-solid fa-crop-simple" aria-hidden="true"></i>
        </button>
        <button type="button" class="btn btn-sm btn-outline-light ctrl-action ctrl-action--accent btn-icon-tiny p-0"
          title="下載目前畫布為 PNG 檔"
          @click="savePng" aria-label="另存新檔">
          <i class="fa-solid fa-download" aria-hidden="true"></i>
        </button>
        <button type="button" class="btn btn-sm btn-outline-light ctrl-action ctrl-action--danger btn-icon-tiny p-0"
          title="清空畫布內容（會先確認）"
          @click="clearCanvas" aria-label="清空畫布">
          <i class="fa-solid fa-trash-can" aria-hidden="true"></i>
        </button>
      </div>

      <div class="vr opacity-50 align-self-center control-bar-vr" role="presentation"></div>

      <!-- 繪圖工具 -->
      <nav
        class="control-bar__tools kd-tool-well d-flex flex-wrap flex-shrink-0 align-items-center gap-2 px-2 py-2"
        role="toolbar"
        aria-label="繪圖工具"
      >
        <button
          v-for="t in TOOLS"
          :key="t.value"
          type="button"
          :class="['btn', 'btn-sm', 'btn-outline-light', 'ctrl-tool', 'btn-icon-tiny', 'p-0', { active: tool === t.value }]"
          :title="t.label"
          :aria-label="t.label"
          @click="tool = t.value"
        >
          <i :class="t.icon" aria-hidden="true"></i>
        </button>
      </nav>

      <div class="vr opacity-50 align-self-center control-bar-vr" role="presentation"></div>

      <!-- 縮放 -->
      <div class="btn-group btn-group-sm ctrl-zoom-group" role="group" aria-label="畫布縮放">
        <button type="button" class="btn btn-sm ctrl-zoom-btn btn-icon-tiny p-0"
          title="縮小畫布顯示"
          @click="zoomOut" aria-label="縮小">
          <i class="fa-solid fa-magnifying-glass-minus" aria-hidden="true"></i>
        </button>
        <button type="button" class="btn btn-sm ctrl-zoom-label ctrl-zoom-readout px-2 text-nowrap"
          title="目前縮放比例；點擊還原為 100%"
          @click="zoomReset" aria-label="縮放比例，點擊重設">
          {{ zoomLabel }}
        </button>
        <button type="button" class="btn btn-sm ctrl-zoom-btn btn-icon-tiny p-0"
          title="放大畫布顯示"
          @click="zoomIn" aria-label="放大">
          <i class="fa-solid fa-magnifying-glass-plus" aria-hidden="true"></i>
        </button>
      </div>

      <div class="vr opacity-50 align-self-center control-bar-vr" role="presentation"></div>

      <!-- 畫布大小 -->
      <div class="d-flex flex-shrink-0 align-items-center gap-2 kd-field" role="group" aria-label="畫布大小">
        <label class="form-label kd-label mb-0 text-nowrap" for="canvasSizePreset">畫布</label>
        <select
          id="canvasSizePreset"
          class="form-select form-select-sm ctrl-select-on-dark kd-select"
          title="畫布像素寬高；「跟隨視窗」會隨視窗變化"
          aria-label="畫布像素尺寸"
          v-model="canvasSizePresetValue"
          @change="handleCanvasSizeChange"
        >
          <option v-if="customSizeOption" :value="customSizeOption.value">{{ customSizeOption.label }}</option>
          <option value="viewport">跟隨視窗</option>
          <option value="2560x1440">2560 × 1440</option>
          <option value="1920x1080">1920 × 1080</option>
          <option value="1600x900">1600 × 900</option>
          <option value="1280x800">1280 × 800</option>
          <option value="1366x768">1366 × 768</option>
          <option value="1024x768">1024 × 768</option>
          <option value="800x600">800 × 600</option>
          <option value="640x480">640 × 480</option>
        </select>
      </div>

      <div class="vr opacity-50 align-self-center control-bar-vr" role="presentation"></div>

      <!-- 筆觸大小 -->
      <div class="d-flex flex-shrink-0 align-items-center gap-2 kd-field" role="group" aria-label="筆觸大小">
        <label class="form-label kd-label mb-0 text-nowrap" for="brushSizeInput">
          <span>大小</span> <strong class="kd-brush-val">{{ brushSize }}</strong>px
        </label>
        <input
          type="range"
          class="form-range brush-range"
          id="brushSizeInput"
          min="1"
          max="48"
          v-model.number="brushSize"
          title="鉛筆、筆刷、橡皮擦與形狀線條的寬度（像素）"
          aria-label="筆觸大小"
        />
      </div>

      <div class="vr opacity-50 align-self-center control-bar-vr" role="presentation"></div>

      <!-- 色彩 -->
      <div class="control-bar__palette d-flex flex-shrink-0 flex-wrap align-items-center gap-2" role="group" aria-label="色彩">
        <div class="color-overlap-wrap">
          <button
            type="button"
            class="color-rear p-0"
            :class="{ active: activeColorSlot === 2 }"
            :style="{ background: color2 }"
            title="背景色：橡皮擦與右鍵繪製使用此色；點擊以編輯"
            @click="activeColorSlot = 2"
            aria-label="背景色"
          ></button>
          <button
            type="button"
            class="color-front p-0"
            :class="{ active: activeColorSlot === 1 }"
            :style="{ background: color1 }"
            title="前景色：一般左鍵繪製與填色使用；點擊以編輯"
            @click="activeColorSlot = 1"
            aria-label="前景色"
          ></button>
        </div>

        <button type="button" class="btn btn-sm btn-outline-light ctrl-icon-btn btn-icon-tiny p-0"
          title="交換前景色與背景色"
          @click="swapColors" aria-label="交換色彩">
          <i class="fa-solid fa-right-left" aria-hidden="true"></i>
        </button>

        <label class="color-picker-wrap mb-0" title="調整目前選取槽位（前景或背景）的顏色">
          <span class="color-picker-ico-wrap" aria-hidden="true">
            <i class="fa-solid fa-palette"></i>
          </span>
          <input
            type="color"
            class="form-control form-control-color p-0 border-0"
            :value="colorPickerValue"
            @input="onColorPickerInput"
            aria-label="調整選取的色彩"
          />
        </label>

        <div class="swatches d-flex flex-wrap align-items-center gap-1 py-1" aria-label="調色盤">
          <button
            v-for="hex in SWATCHES"
            :key="hex"
            type="button"
            class="swatch btn btn-sm p-0 border"
            :style="{ background: hex }"
            :aria-label="'色票 ' + hex"
            @click="pickSwatch(hex)"
          ></button>
        </div>
      </div>
    </header>

    <!-- ── 分頁列 ── -->
    <div class="doc-tab-strip w-100 overflow-hidden flex-shrink-0">
      <div class="doc-tabs-scroll w-100 overflow-visible px-3">
        <div class="doc-tabs-row w-100 d-flex flex-wrap align-items-end align-content-end gap-2 pt-2">
          <div class="doc-tabs-cluster d-flex flex-wrap align-items-end align-content-end gap-2">
            <div
              class="doc-tabs d-flex align-items-end flex-wrap gap-2 flex-grow-0 flex-shrink-1 mw-100 min-w-0"
              role="tablist"
              aria-label="分頁"
            >
              <div
                v-for="(doc, i) in documents"
                :key="doc.id"
                :class="['doc-tab', 'mb-n1', { 'doc-tab--active': i === activeDocIndex }]"
              >
                <button
                  type="button"
                  class="doc-tab__main px-3 py-2"
                  role="tab"
                  :title="doc.title"
                  :aria-selected="i === activeDocIndex"
                  @click="switchToDocument(i)"
                >{{ doc.title }}</button>
                <button
                  type="button"
                  class="btn btn-sm btn-outline-secondary border-0 doc-tab__close p-0 d-flex align-items-center justify-content-center ms-0 me-2 my-2"
                  :aria-label="'關閉「' + doc.title + '」'"
                  @click.stop="closeDocumentAt(i)"
                >
                  <i class="fa-solid fa-xmark" aria-hidden="true"></i>
                </button>
              </div>
            </div>
            <button
              type="button"
              class="btn btn-sm btn-light border doc-tab-new mb-n1 p-0 ms-0 d-inline-flex align-items-center justify-content-center"
              @click="addDocument"
              aria-label="新增分頁"
            >
              <i class="fa-solid fa-plus" aria-hidden="true"></i>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- ── 畫布區 ── -->
    <main
      class="canvas-wrap overflow-hidden p-0 d-flex align-items-center justify-content-center"
      ref="canvasWrapRef"
      aria-label="畫布區"
    >
      <div class="canvas-pan-inner" ref="canvasPanLayerRef">
        <canvas ref="canvasRef" aria-label="畫布"></canvas>
      </div>
    </main>

    <!-- ── 頁尾 ── -->
    <footer class="app-footer kd-footer px-3 py-2" ref="appFooterRef">
      <div class="d-flex flex-wrap align-items-center justify-content-between gap-2">
        <div class="d-flex align-items-center gap-2 flex-wrap">
          <span class="kd-footer-meta text-nowrap">游標（畫布座標）</span>
          <span class="kd-footer-readout font-monospace user-select-all footer-cursor-val">{{ cursorPt }}</span>
        </div>

        <span class="kd-footer-brand">KDrawer</span>
      </div>
    </footer>
  </div>

  <!-- ── 確認 Modal ── -->
  <Teleport to="body">
    <transition name="modal-fade">
      <div v-if="confirmState.visible">
        <div class="modal-backdrop fade show"></div>
        <div class="modal fade show d-block" tabindex="-1" role="dialog" style="z-index: 1055">
          <div class="modal-dialog modal-dialog-centered">
            <div class="modal-content">
              <div class="modal-header">
                <h5 class="modal-title">請確認</h5>
                <button type="button" class="btn-close" @click="confirmCancel" aria-label="關閉"></button>
              </div>
              <div class="modal-body">{{ confirmState.message }}</div>
              <div class="modal-footer">
                <button type="button" class="btn btn-secondary" @click="confirmCancel">取消</button>
                <button type="button" class="btn btn-primary" @click="confirmOk">確定</button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </transition>
  </Teleport>

  <!-- ── Toast ── -->
  <Teleport to="body">
    <div class="toast-container position-fixed bottom-0 end-0 p-3" style="z-index: 1080">
      <transition name="toast-fade">
        <div
          v-if="toastState.visible"
          class="toast align-items-center text-bg-dark border-0 show"
          role="alert"
          aria-live="polite"
          aria-atomic="true"
        >
          <div class="d-flex">
            <div class="toast-body">{{ toastState.message }}</div>
            <button
              type="button"
              class="btn-close btn-close-white me-2 m-auto"
              @click="toastState.visible = false"
              aria-label="關閉"
            ></button>
          </div>
        </div>
      </transition>
    </div>
  </Teleport>
</template>

<script setup>
import { ref, reactive, computed, watch } from 'vue'
import { usePainter } from './composables/usePainter.js'
import { useGoogleDriveSync } from './composables/useGoogleDriveSync.js'

// ── Constants ─────────────────────────────────────────────────────────────
const SWATCHES = [
  '#000000', '#7f7f7f', '#880015', '#ed1c24', '#ff7f27',
  '#fff200', '#22b14c', '#00a2e8', '#3f48cc', '#a349a4',
  '#ffffff', '#c3c3c3', '#b97a57', '#ffaec9', '#ffc90e',
  '#efe4b0', '#b5e61d', '#99d9ea', '#7092be', '#c8bfe7',
]

const TOOLS = [
  { value: 'pencil', label: '鉛筆', icon: 'fa-solid fa-pencil' },
  { value: 'pen', label: '筆刷', icon: 'fa-solid fa-paintbrush' },
  { value: 'line', label: '直線', icon: 'fa-solid fa-slash' },
  { value: 'rect', label: '矩形', icon: 'fa-regular fa-square' },
  { value: 'ellipse', label: '橢圓', icon: 'fa-regular fa-circle' },
  { value: 'roundrect', label: '圓角矩形', icon: 'fa-solid fa-vector-square' },
  { value: 'fill', label: '填滿', icon: 'fa-solid fa-fill-drip' },
  { value: 'pick', label: '滴管', icon: 'fa-solid fa-eye-dropper' },
  { value: 'eraser', label: '橡皮擦', icon: 'fa-solid fa-eraser' },
]

// ── Template refs ──────────────────────────────────────────────────────────
const canvasRef = ref(null)
const canvasWrapRef = ref(null)
const canvasPanLayerRef = ref(null)
const appFooterRef = ref(null)

// ── UI reactive state ──────────────────────────────────────────────────────
const tool = ref('pencil')
const brushSize = ref(4)
const color1 = ref('#000000')
const color2 = ref('#ffffff')
const activeColorSlot = ref(1)
const canvasSizePresetValue = ref('viewport')
const customSizeOption = ref(null)

// ── Color helpers ──────────────────────────────────────────────────────────
const colorPickerValue = computed(() => activeColorSlot.value === 1 ? color1.value : color2.value)

function onColorPickerInput(e) {
  if (activeColorSlot.value === 1) color1.value = e.target.value
  else color2.value = e.target.value
}

function pickSwatch(hex) {
  if (activeColorSlot.value === 1) color1.value = hex
  else color2.value = hex
}

function swapColors() {
  const tmp = color1.value
  color1.value = color2.value
  color2.value = tmp
}

// ── Confirm dialog ─────────────────────────────────────────────────────────
const confirmState = reactive({ visible: false, message: '', resolve: null })

function showConfirm(message) {
  return new Promise(resolve => {
    confirmState.message = message
    confirmState.visible = true
    confirmState.resolve = resolve
  })
}

function confirmOk() {
  confirmState.visible = false
  confirmState.resolve?.(true)
}

function confirmCancel() {
  confirmState.visible = false
  confirmState.resolve?.(false)
}

// ── Toast ──────────────────────────────────────────────────────────────────
const toastState = reactive({ visible: false, message: '' })
let toastTimer = null

function showToast(message) {
  toastState.message = message
  toastState.visible = true
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { toastState.visible = false }, 2800)
}

// ── Painter／雲端刪檔 shim（閉包避免 composable 循環引用） ─────────────────────
const driveDeleteShim = { fn: (_id) => {} }
/** 與 Google 登入狀態同步：登入時不寫 sessionStorage，登出後再寫回本機備份 */
const driveSignedInRef = ref(false)

// ── Painter composable ─────────────────────────────────────────────────────
const {
  zoomLabel, cursorPt, documents, activeDocIndex,
  undo, clearCanvas, savePng, copyCanvasPng, copyCanvasPngDrawnBounds,
  switchToDocument, addDocument, closeDocumentAt,
  handleCanvasSizeChange, zoomIn, zoomOut, zoomReset,
  getPayload, applyPayload, mergeRemoteDocFiles, onLocalChange,
  clearPersistedSession,
  flushLocalSessionNow,
} = usePainter({
  canvasRef, canvasWrapRef, canvasPanLayerRef, appFooterRef,
  tool, brushSize, color1, color2, activeColorSlot,
  canvasSizePresetValue, customSizeOption,
  showConfirm, showToast,
  onCloseDocument: id => driveDeleteShim.fn(id),
  persistLocalSessionStorage: () => !driveSignedInRef.value,
})

// ── Google Drive sync ───────────────────────────────────────────────────────
const {
  state: driveState,
  signIn: driveSignIn,
  signOut: driveSignOut,
  deleteDriveDoc: driveDeleteDriveDoc,
} = useGoogleDriveSync({
  getPayload,
  applyPayload,
  mergeRemoteDocFiles,
  onLocalChange,
  showToast,
  mirrorSignedInRef: driveSignedInRef,
  onCloudSyncSuccess: () => {
    clearPersistedSession()
  },
})
driveDeleteShim.fn = driveDeleteDriveDoc

watch(
  () => driveState.signedIn,
  (signedIn, wasSignedIn) => {
    if (wasSignedIn === true && signedIn === false) {
      flushLocalSessionNow()
    }
  },
)

</script>

<style>
.modal-fade-enter-active,
.modal-fade-leave-active {
  transition: opacity 0.15s;
}
.modal-fade-enter-from,
.modal-fade-leave-to {
  opacity: 0;
}

.toast-fade-enter-active,
.toast-fade-leave-active {
  transition: opacity 0.2s;
}
.toast-fade-enter-from,
.toast-fade-leave-to {
  opacity: 0;
}

/* ── Google Drive（工具列左上角） ── */
.kd-drive-zone {
  font-size: 0.78rem;
}
.control-bar.kd-toolbar .kd-drive-zone--toolbar .kd-drive-status {
  opacity: 0.92;
}
.control-bar.kd-toolbar .kd-drive-zone--toolbar .kd-drive-status--off {
  color: var(--bar-muted);
}
.control-bar.kd-toolbar .kd-drive-zone--toolbar .kd-drive-label {
  max-width: 14ch;
}
.kd-drive-status--ok  { color: #4caf8a; }
.kd-drive-status--off { color: #888; }
.kd-drive-status--busy { color: #ffc107; }
.kd-drive-label {
  max-width: 18ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
</style>

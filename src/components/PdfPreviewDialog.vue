<script setup lang="ts">
import { ref, watch, onMounted, onBeforeUnmount } from 'vue'
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/legacy/build/pdf.worker.min.js?url'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

type FillField = 'content' | 'date' | 'amount'

const props = defineProps<{
  filePaths: string[]
  rowId: string
  rowLabel: string
}>()

const emit = defineEmits<{
  close: []
  fill: [{ rowId: string; field: FillField; value: string }]
}>()

// ============ 弹框位置（可拖拽移动） ============
const pos = ref({ x: 90, y: 30 })

function startDrag(e: MouseEvent): void {
  const offsetX = e.clientX - pos.value.x
  const offsetY = e.clientY - pos.value.y
  const move = (ev: MouseEvent): void => {
    pos.value = {
      x: Math.max(0, ev.clientX - offsetX),
      y: Math.max(0, ev.clientY - offsetY),
    }
  }
  const up = (): void => {
    document.removeEventListener('mousemove', move)
    document.removeEventListener('mouseup', up)
  }
  document.addEventListener('mousemove', move)
  document.addEventListener('mouseup', up)
}

// ============ PDF 加载与渲染 ============
const canvasRef = ref<HTMLCanvasElement | null>(null)
const textLayerRef = ref<HTMLElement | null>(null)

const fileIdx = ref(0)
const pageNum = ref(1)
const pageCount = ref(0)
const scale = ref(1.4)
const loading = ref(false)
const errorMsg = ref('')
const hasText = ref(true)

let doc: PDFDocumentProxy | null = null
let renderTask: RenderTask | null = null

function baseName(p: string): string {
  return p.split(/[\\/]/).pop() ?? p
}

async function destroyDoc(): Promise<void> {
  renderTask?.cancel()
  renderTask = null
  if (doc) {
    try {
      await doc.destroy()
    } catch {
      /* ignore */
    }
    doc = null
  }
}

async function loadFile(): Promise<void> {
  loading.value = true
  errorMsg.value = ''
  await destroyDoc()
  try {
    const data = await window.electronAPI.readPdf(
      props.filePaths[fileIdx.value],
    )
    doc = await pdfjs.getDocument({
      data,
      cMapUrl: 'app-res://cmaps/',
      cMapPacked: true,
      standardFontDataUrl: 'app-res://fonts/',
    }).promise
    pageCount.value = doc.numPages
    pageNum.value = 1
    await renderPage()
  } catch (e) {
    errorMsg.value = `PDF 加载失败：${(e as Error).message}`
  } finally {
    loading.value = false
  }
}

async function renderPage(): Promise<void> {
  if (!doc || !canvasRef.value || !textLayerRef.value) return
  const page = await doc.getPage(pageNum.value)
  const viewport = page.getViewport({ scale: scale.value })

  const canvas = canvasRef.value
  canvas.width = viewport.width
  canvas.height = viewport.height
  const ctx = canvas.getContext('2d')!

  renderTask?.cancel()
  const task = page.render({ canvasContext: ctx, viewport })
  renderTask = task
  try {
    await task.promise
  } catch (e) {
    if ((e as Error).name !== 'RenderingCancelledException') throw e
  }

  // 文本层：透明文字覆盖在 canvas 上，可拖选
  const tl = textLayerRef.value
  tl.innerHTML = ''
  tl.style.width = `${viewport.width}px`
  tl.style.height = `${viewport.height}px`
  tl.style.setProperty('--scale-factor', String(viewport.scale))
  const textContent = await page.getTextContent()
  hasText.value = textContent.items.length > 0
  await pdfjs.renderTextLayer({
    textContentSource: textContent,
    container: tl,
    viewport,
    textDivs: [],
  }).promise
}

watch(() => props.filePaths, loadFile, { immediate: true })
watch(fileIdx, loadFile)
watch([pageNum, scale], () => {
  renderPage().catch((e) => (errorMsg.value = (e as Error).message))
})

onBeforeUnmount(() => {
  destroyDoc()
})

// ============ 右键填充菜单 ============
const menu = ref({ show: false, x: 0, y: 0, text: '' })

function onContextMenu(e: MouseEvent): void {
  const sel = (window.getSelection()?.toString() ?? '').replace(/\s+/g, '')
  if (!sel) return
  e.preventDefault()
  menu.value = {
    show: true,
    x: e.clientX,
    y: e.clientY,
    text: sel.slice(0, 60),
  }
}

function fillField(field: FillField): void {
  emit('fill', { rowId: props.rowId, field, value: menu.value.text })
  menu.value.show = false
}

const hideMenu = (): void => {
  menu.value.show = false
}
onMounted(() => document.addEventListener('click', hideMenu))
onBeforeUnmount(() => document.removeEventListener('click', hideMenu))
</script>

<template>
  <div class="pdf-preview" :style="{ left: `${pos.x}px`, top: `${pos.y}px` }">
    <header class="drag-bar" @mousedown="startDrag">
      <span class="title">📄 PDF 预览</span>
      <div class="file-tabs">
        <button
          v-for="(f, i) in filePaths"
          :key="f"
          :class="{ active: i === fileIdx }"
          :title="f"
          @mousedown.stop
          @click="fileIdx = i"
        >
          {{ baseName(f) }}
        </button>
      </div>
      <button
        class="close-btn"
        title="关闭"
        @mousedown.stop
        @click="emit('close')"
      >
        ✕
      </button>
    </header>

    <div class="toolbar">
      <button :disabled="pageNum <= 1" @click="pageNum--">‹ 上一页</button>
      <span class="page-no">{{ pageNum }} / {{ pageCount }}</span>
      <button :disabled="pageNum >= pageCount" @click="pageNum++">
        下一页 ›
      </button>
      <span class="sep"></span>
      <button @click="scale = Math.max(0.6, +(scale - 0.2).toFixed(1))">
        －
      </button>
      <span class="page-no">{{ Math.round(scale * 100) }}%</span>
      <button @click="scale = Math.min(3, +(scale + 0.2).toFixed(1))">
        ＋
      </button>
      <span v-if="!hasText && !loading" class="no-text"
        >此 PDF 无文本层（扫描件），请对照图片手动填写</span
      >
    </div>

    <div class="body" @contextmenu="onContextMenu">
      <div v-if="loading" class="hint">加载中…</div>
      <div v-else-if="errorMsg" class="hint error">{{ errorMsg }}</div>
      <div v-show="!loading && !errorMsg" class="page-wrap">
        <canvas ref="canvasRef"></canvas>
        <div ref="textLayerRef" class="text-layer"></div>
      </div>
    </div>

    <footer>
      当前行：{{ rowLabel }} ｜ 在文字上拖选 → 右键 → 选择要填充的字段
    </footer>

    <teleport to="body">
      <div
        v-if="menu.show"
        class="fill-menu"
        :style="{ left: `${menu.x}px`, top: `${menu.y}px` }"
      >
        <div class="menu-tip" :title="menu.text">「{{ menu.text }}」填充为</div>
        <button @click="fillField('content')">报销内容</button>
        <button @click="fillField('date')">费用日期</button>
        <button @click="fillField('amount')">金额</button>
      </div>
    </teleport>
  </div>
</template>

<style scoped>
.pdf-preview {
  position: fixed;
  z-index: 1000;
  width: 780px;
  height: 88vh;
  display: flex;
  flex-direction: column;
  background: #fff;
  border: 1px solid #c9d4e5;
  border-radius: 10px;
  box-shadow: 0 12px 40px rgba(30, 50, 90, 0.3);
  overflow: hidden;
}

.drag-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: #3b55d9;
  color: #fff;
  cursor: move;
  user-select: none;
}
.drag-bar .title {
  font-weight: 700;
  white-space: nowrap;
}
.file-tabs {
  flex: 1;
  display: flex;
  gap: 6px;
  overflow-x: auto;
}
.file-tabs button {
  border: 1px solid rgba(255, 255, 255, 0.5);
  background: transparent;
  color: #fff;
  border-radius: 5px;
  padding: 3px 8px;
  font-size: 12px;
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}
.file-tabs button.active {
  background: #fff;
  color: #3b55d9;
}
.close-btn {
  border: none;
  background: transparent;
  color: #fff;
  font-size: 16px;
  cursor: pointer;
  padding: 2px 6px;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid #e3e9f2;
  font-size: 12px;
}
.toolbar button {
  border: 1px solid #c9d4e5;
  background: #fff;
  border-radius: 5px;
  padding: 3px 8px;
  cursor: pointer;
}
.toolbar button:disabled {
  opacity: 0.4;
  cursor: default;
}
.page-no {
  min-width: 52px;
  text-align: center;
}
.sep {
  flex: 0 0 1px;
  height: 16px;
  background: #d8e0ec;
  margin: 0 4px;
}
.no-text {
  margin-left: auto;
  color: #b26a00;
  background: #fff4e0;
  border-radius: 4px;
  padding: 2px 8px;
}

.body {
  flex: 1;
  overflow: auto;
  background: #f0f2f7;
  padding: 12px;
}
.page-wrap {
  position: relative;
  margin: 0 auto;
  width: fit-content;
  background: #fff;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.15);
}
.page-wrap canvas {
  display: block;
}

/* pdfjs 文本层（精简自官方 pdf_viewer.css） */
.text-layer {
  position: absolute;
  inset: 0;
  overflow: hidden;
  line-height: 1;
  text-align: initial;
  text-size-adjust: none;
  forced-color-adjust: none;
  transform-origin: 0 0;
}
.text-layer :deep(span) {
  position: absolute;
  white-space: pre;
  cursor: text;
  transform-origin: 0 0;
  color: transparent;
}
.text-layer ::selection {
  background: rgba(59, 85, 217, 0.3);
  color: transparent;
}

.hint {
  text-align: center;
  color: #8492a6;
  padding: 40px 0;
}
.hint.error {
  color: #c62828;
}

footer {
  padding: 6px 12px;
  font-size: 12px;
  color: #8492a6;
  border-top: 1px solid #e3e9f2;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fill-menu {
  position: fixed;
  z-index: 1100;
  background: #fff;
  border: 1px solid #c9d4e5;
  border-radius: 8px;
  box-shadow: 0 8px 24px rgba(30, 50, 90, 0.25);
  padding: 6px;
  min-width: 180px;
}
.menu-tip {
  font-size: 12px;
  color: #8492a6;
  padding: 4px 8px;
  max-width: 260px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border-bottom: 1px solid #eef2f7;
  margin-bottom: 4px;
}
.fill-menu button {
  display: block;
  width: 100%;
  text-align: left;
  border: none;
  background: transparent;
  padding: 7px 10px;
  border-radius: 5px;
  font-size: 13px;
  cursor: pointer;
}
.fill-menu button:hover {
  background: #eef2ff;
  color: #3b55d9;
}
</style>

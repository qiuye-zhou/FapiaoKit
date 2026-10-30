<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import type { InvoiceRecord, OrganizeResult } from '@/types/electron'
import PdfPreviewDialog from '@/components/PdfPreviewDialog.vue'
import { useTheme, type ThemeMode } from '@/composables/useTheme'

const { mode: themeMode, setMode: setThemeMode } = useTheme()
const THEME_OPTIONS: Array<{ value: ThemeMode; label: string }> = [
  { value: 'light', label: '浅色' },
  { value: 'dark', label: '深色' },
  { value: 'system', label: '跟随系统' },
]

// 主题菜单：默认收起仅显示当前状态图标，点击展开
const themeMenuOpen = ref(false)

function pickTheme(m: ThemeMode): void {
  setThemeMode(m)
  themeMenuOpen.value = false
}

const closeThemeMenu = (): void => {
  themeMenuOpen.value = false
}
onMounted(() => document.addEventListener('click', closeThemeMenu))
onBeforeUnmount(() => document.removeEventListener('click', closeThemeMenu))

interface RowVM extends InvoiceRecord {
  dateStr: string
}

interface CustomItemVM {
  id: string
  content: string
  amount: number | null
  note: string
}

const TYPE_LABEL: Record<string, string> = {
  railway: '高铁',
  flight: '飞机',
  hotel: '住宿',
  taxi: '打车',
  toll: '高速',
  express: '快递',
  other: '其他',
}

// ============ 状态 ============
const folderPath = ref('')
const scanning = ref(false)
const rows = ref<RowVM[]>([])
const warnings = ref<string[]>([])

// 自定义条目（补贴等），不关联 PDF，直接写入报销单
let customItemSeq = 0
const customItems = ref<CustomItemVM[]>([])

const projectCategory = ref('应急警报')
const orgName = ref('')
const tripStart = ref('')
const tripEnd = ref('')
const ticketYear = ref(new Date().getFullYear())
const reportDateStr = ref(new Date().toISOString().slice(0, 10))
const reportNameInput = ref('')
const renameFolderEnabled = ref(true)
const folderNameInput = ref('')

const organizing = ref(false)
const result = ref<OrganizeResult | null>(null)
const errorMsg = ref('')

// ============ 派生 ============
// 行程日期使用原生日期选择器，值为 YYYY-MM-DD
const tripRange = computed(() => {
  const s = parseIsoDate(tripStart.value)
  const e = parseIsoDate(tripEnd.value)
  if (!s || !e) return ''
  return `${s.m}.${s.d}-${e.m}.${e.d}`
})

const defaultReportName = computed(() =>
  orgName.value && tripRange.value
    ? `${orgName.value}${tripRange.value}.xlsx`
    : '',
)
const defaultFolderName = computed(() =>
  orgName.value && tripRange.value ? `${orgName.value}${tripRange.value}` : '',
)

// 发票金额合计（实时随表格编辑更新）
const totalAmount = computed(() =>
  rows.value.reduce((s, r) => {
    const v = Number(r.amount)
    return s + (Number.isFinite(v) ? v : 0)
  }, 0),
)

// 自定义条目小计
const customTotal = computed(() =>
  customItems.value.reduce((s, it) => {
    const v = Number(it.amount)
    return s + (Number.isFinite(v) ? v : 0)
  }, 0),
)

const grandTotal = computed(() => totalAmount.value + customTotal.value)

// 有发票或有自定义条目即可进入后续步骤
const hasEntries = computed(
  () => rows.value.length > 0 || customItems.value.length > 0,
)

const canOrganize = computed(
  () =>
    folderPath.value &&
    hasEntries.value &&
    projectCategory.value.trim() &&
    defaultReportName.value &&
    !organizing.value,
)

// ============ 工具 ============
function parseMD(s: string): { m: number; d: number } | null {
  const m = s.trim().match(/^(\d{1,2})[./-](\d{1,2})$/)
  return m ? { m: +m[1], d: +m[2] } : null
}

// 日期选择器的值：YYYY-MM-DD
function parseIsoDate(s: string): { m: number; d: number } | null {
  const m = s.trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/)
  return m ? { m: +m[2], d: +m[3] } : null
}

function parseRowDate(s: string): { y: number; m: number; d: number } | null {
  const m3 = s.trim().match(/^(\d{4})[./-](\d{1,2})[./-](\d{1,2})$/)
  if (m3) return { y: +m3[1], m: +m3[2], d: +m3[3] }
  const m2 = parseMD(s)
  if (m2) return { y: ticketYear.value, ...m2 }
  return null
}

// ============ 操作 ============
// PDF 预览弹框
const preview = ref<{ rowId: string; files: string[]; label: string } | null>(
  null,
)

function openPreview(row: RowVM): void {
  preview.value = {
    rowId: row.id,
    files: row.files.map((f) => `${folderPath.value}/${f}`),
    label: row.content || row.files[0],
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

// 从选中文字解析日期：支持 2026年09月09日 / 2026-9-9 / 09月18日 / 9.18
function parseFillDate(text: string, row: RowVM): string | null {
  const t = text.replace(/\s+/g, '')
  let m = t.match(/(\d{4})\D{0,3}(\d{1,2})\D{0,3}(\d{1,2})/)
  if (m) return `${m[1]}-${pad2(+m[2])}-${pad2(+m[3])}`
  m = t.match(/(\d{1,2})月(\d{1,2})日?/) ?? t.match(/(\d{1,2})[./-](\d{1,2})/)
  if (m) {
    const y = parseRowDate(row.dateStr)?.y ?? ticketYear.value
    return `${y}-${pad2(+m[1])}-${pad2(+m[2])}`
  }
  return null
}

function onFill(p: {
  rowId: string
  field: 'content' | 'date' | 'amount'
  value: string
}): void {
  const row = rows.value.find((r) => r.id === p.rowId)
  if (!row) return
  const text = p.value.trim()
  if (p.field === 'content') {
    row.content = text
  } else if (p.field === 'amount') {
    const m = text.replace(/[¥￥,]/g, '').match(/(\d+(?:\.\d+)?)/)
    if (m) row.amount = parseFloat(m[1])
  } else {
    const d = parseFillDate(text, row)
    if (d) row.dateStr = d
  }
  // 三项齐全后自动取消「需核对」标记
  if (row.content.trim() && row.amount > 0 && parseRowDate(row.dateStr)) {
    row.needConfirm = false
    if (row.note && /手动|扫描件|核对/.test(row.note)) row.note = undefined
  }
}

async function selectFolder(): Promise<void> {
  errorMsg.value = ''
  result.value = null
  preview.value = null
  const p = await window.electronAPI.selectFolder()
  if (!p) return
  folderPath.value = p
  await scan()
}

async function scan(): Promise<void> {
  scanning.value = true
  warnings.value = []
  rows.value = []
  try {
    const r = await window.electronAPI.scanFolder(folderPath.value)
    warnings.value = r.warnings
    // dateStr 统一为 YYYY-MM-DD，方便原生 date picker
    rows.value = r.records.map((rec) => ({
      ...rec,
      dateStr:
        rec.month && rec.day
          ? `${rec.year}-${pad2(rec.month)}-${pad2(rec.day)}`
          : '',
    }))
  } catch (e) {
    errorMsg.value = `扫描失败：${(e as Error).message}`
  } finally {
    scanning.value = false
  }
}

function moveRow(i: number, dir: -1 | 1): void {
  const j = i + dir
  if (j < 0 || j >= rows.value.length) return
  const arr = [...rows.value]
  ;[arr[i], arr[j]] = [arr[j], arr[i]]
  rows.value = arr
}

function addCustomItem(): void {
  customItems.value.push({
    id: `custom-${++customItemSeq}`,
    content: '',
    amount: null,
    note: '',
  })
}

function removeCustomItem(i: number): void {
  customItems.value.splice(i, 1)
}

async function startOrganize(): Promise<void> {
  errorMsg.value = ''
  // 校验并回写日期
  const records: InvoiceRecord[] = []
  for (let i = 0; i < rows.value.length; i++) {
    const row = rows.value[i]
    const dt = parseRowDate(row.dateStr)
    if (!dt) {
      errorMsg.value = `第 ${i + 1} 行日期格式不正确（应为 9.28 或 2026.9.28）`
      return
    }
    if (!row.content.trim()) {
      errorMsg.value = `第 ${i + 1} 行报销内容不能为空`
      return
    }
    if (!(row.amount > 0)) {
      errorMsg.value = `第 ${i + 1} 行金额不正确`
      return
    }
    // 手动构建纯对象：reactive proxy（含嵌套 files 数组代理）无法通过 IPC 结构化克隆
    records.push({
      id: row.id,
      type: row.type,
      content: row.content.trim(),
      year: dt.y,
      month: dt.m,
      day: dt.d,
      amount: Number(row.amount),
      files: [...row.files],
      needConfirm: row.needConfirm,
      note: row.note,
    })
  }

  const [ry, rm, rd] = reportDateStr.value.split('-').map(Number)

  // 校验自定义条目并转为纯对象
  const customs: Array<{ content: string; amount: number; note?: string }> = []
  for (let i = 0; i < customItems.value.length; i++) {
    const it = customItems.value[i]
    if (!it.content.trim()) {
      errorMsg.value = `自定义条目第 ${i + 1} 条名称不能为空`
      return
    }
    if (!(Number(it.amount) > 0)) {
      errorMsg.value = `自定义条目第 ${i + 1} 条金额不正确`
      return
    }
    customs.push({
      content: it.content.trim(),
      amount: Number(it.amount),
      note: it.note.trim() || undefined,
    })
  }

  organizing.value = true
  try {
    const r = await window.electronAPI.organize({
      folderPath: folderPath.value,
      records,
      customItems: customs,
      projectCategory: projectCategory.value.trim(),
      reportName: reportNameInput.value.trim() || defaultReportName.value,
      reportDate: { y: ry, m: rm, d: rd },
      renameFolder: renameFolderEnabled.value
        ? folderNameInput.value.trim() || defaultFolderName.value
        : '',
    })
    result.value = r
    warnings.value = [...warnings.value, ...r.warnings]
  } catch (e) {
    errorMsg.value = `整理失败：${(e as Error).message}`
  } finally {
    organizing.value = false
  }
}

function openResultFolder(): void {
  if (result.value) window.electronAPI.openFolder(result.value.newFolderPath)
}

function reset(): void {
  folderPath.value = ''
  rows.value = []
  customItems.value = []
  warnings.value = []
  result.value = null
  errorMsg.value = ''
}
</script>

<template>
  <div class="page">
    <header class="page-header">
      <h1>FapiaoKit 差旅报销整理</h1>
      <p>选择出差文件夹 → 核对发票 → 一键重命名并生成报销单</p>
    </header>

    <!-- 主题切换：固定右上角，默认仅显示当前状态图标，点击展开 -->
    <div class="theme-fab" @click.stop>
      <button
        class="theme-toggle-btn"
        :title="`主题：${THEME_OPTIONS.find((o) => o.value === themeMode)?.label}`"
        aria-label="切换主题"
        :aria-expanded="themeMenuOpen"
        @click="themeMenuOpen = !themeMenuOpen"
      >
        <svg
          v-if="themeMode === 'light'"
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
        >
          <circle cx="12" cy="12" r="4" />
          <path
            d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.3 11.3 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
          />
        </svg>
        <svg
          v-else-if="themeMode === 'dark'"
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
        <svg
          v-else
          viewBox="0 0 24 24"
          width="16"
          height="16"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <rect x="2" y="4" width="20" height="13" rx="2" />
          <path d="M8 21h8m-4-4v4" />
        </svg>
      </button>

      <transition name="theme-menu">
        <div v-if="themeMenuOpen" class="theme-menu" role="menu">
          <button
            v-for="opt in THEME_OPTIONS"
            :key="opt.value"
            :class="{ active: themeMode === opt.value }"
            role="menuitemradio"
            :aria-checked="themeMode === opt.value"
            @click="pickTheme(opt.value)"
          >
            <svg
              v-if="opt.value === 'light'"
              viewBox="0 0 24 24"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
            >
              <circle cx="12" cy="12" r="4" />
              <path
                d="M12 2v2m0 16v2M4.9 4.9l1.4 1.4m11.3 11.3 1.4 1.4M2 12h2m16 0h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"
              />
            </svg>
            <svg
              v-else-if="opt.value === 'dark'"
              viewBox="0 0 24 24"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
            </svg>
            <svg
              v-else
              viewBox="0 0 24 24"
              width="13"
              height="13"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <rect x="2" y="4" width="20" height="13" rx="2" />
              <path d="M8 21h8m-4-4v4" />
            </svg>
            {{ opt.label }}
          </button>
        </div>
      </transition>
    </div>

    <!-- 步骤 1：选择文件夹 -->
    <section class="card">
      <div class="step-title"><span class="step-no">1</span>选择出差文件夹</div>
      <div class="folder-row">
        <button
          class="btn btn-primary"
          :disabled="scanning"
          @click="selectFolder"
        >
          {{ scanning ? '扫描中…' : folderPath ? '重新选择' : '选择文件夹' }}
        </button>
        <span v-if="folderPath" class="folder-path">{{ folderPath }}</span>
      </div>
      <div v-if="scanning" class="hint">正在解析发票 PDF…</div>
    </section>

    <!-- 步骤 2：发票表格 -->
    <section v-if="rows.length" class="card">
      <div class="step-title">
        <span class="step-no">2</span>核对发票（{{ rows.length }} 条 / 共
        {{ rows.reduce((s, r) => s + r.files.length, 0) }} 张）
        <span class="total-badge">合计 ¥{{ totalAmount.toFixed(2) }}</span>
        <span class="step-tip">黄色行需人工核对；顺序即报销单行序</span>
      </div>
      <table class="invoice-table">
        <thead>
          <tr>
            <th style="width: 40px">序号</th>
            <th>文件</th>
            <th style="width: 56px">类型</th>
            <th style="width: 180px">报销内容</th>
            <th style="width: 130px">日期</th>
            <th style="width: 90px">金额</th>
            <th style="width: 52px">预览</th>
            <th style="width: 70px">排序</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="(row, i) in rows"
            :key="row.id"
            :class="{ confirm: row.needConfirm }"
          >
            <td class="seq">{{ String(i + 1).padStart(2, '0') }}</td>
            <td class="files">
              <div v-for="f in row.files" :key="f">{{ f }}</div>
              <div v-if="row.note" class="note">⚠ {{ row.note }}</div>
            </td>
            <td>
              <span class="tag" :class="row.type">{{
                TYPE_LABEL[row.type]
              }}</span>
            </td>
            <td><input v-model="row.content" class="cell-input" /></td>
            <td>
              <input
                v-model="row.dateStr"
                type="date"
                class="cell-input center"
              />
            </td>
            <td>
              <input
                v-model.number="row.amount"
                type="number"
                min="0"
                step="0.01"
                class="cell-input center"
              />
            </td>
            <td class="preview-cell">
              <button
                class="preview-btn"
                title="预览 PDF，可选中文字右键填充字段"
                @click="openPreview(row)"
              >
                🔍
              </button>
            </td>
            <td class="move">
              <button :disabled="i === 0" title="上移" @click="moveRow(i, -1)">
                ↑
              </button>
              <button
                :disabled="i === rows.length - 1"
                title="下移"
                @click="moveRow(i, 1)"
              >
                ↓
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="year-row">
        票据统一年份：<input
          v-model.number="ticketYear"
          type="number"
          class="cell-input year-input"
        />
        <span class="hint-inline"
          >（日期列省略年份时使用，如 9.28；也可输入 2026.9.28 指定年份）</span
        >
      </div>
    </section>

    <!-- 自定义条目：补贴等，不关联 PDF -->
    <section v-if="folderPath" class="card">
      <div class="step-title">
        <span class="step-no">＋</span>自定义条目
        <span v-if="customItems.length" class="total-badge"
          >小计 ¥{{ customTotal.toFixed(2) }}</span
        >
      </div>
      <table v-if="customItems.length" class="invoice-table">
        <thead>
          <tr>
            <th>名称</th>
            <th style="width: 120px">金额</th>
            <th>备注</th>
            <th style="width: 52px"></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(item, i) in customItems" :key="item.id">
            <td>
              <input
                v-model="item.content"
                class="cell-input"
                placeholder="如：差旅补贴"
              />
            </td>
            <td>
              <input
                v-model.number="item.amount"
                type="number"
                min="0"
                step="0.01"
                class="cell-input center"
              />
            </td>
            <td>
              <input
                v-model="item.note"
                class="cell-input"
                placeholder="可选"
              />
            </td>
            <td class="preview-cell">
              <button
                class="preview-btn"
                title="删除该条目"
                @click="removeCustomItem(i)"
              >
                ✕
              </button>
            </td>
          </tr>
        </tbody>
      </table>
      <div class="custom-actions">
        <button class="btn" @click="addCustomItem">添加一条</button>
        <span class="hint-inline"
          >名称、金额会写入报销单，备注写入「备注」列；不参与 PDF
          重命名，无发生日期</span
        >
      </div>
    </section>

    <!-- 步骤 3：报销信息 -->
    <section v-if="hasEntries" class="card">
      <div class="step-title"><span class="step-no">3</span>报销信息</div>
      <div class="form-grid">
        <label>项目类别</label>
        <div class="inline">
          <input
            v-model="projectCategory"
            class="cell-input"
            placeholder="应急警报 / 叉车"
          />
          <button class="chip" @click="projectCategory = '应急警报'">
            应急警报
          </button>
          <button class="chip" @click="projectCategory = '叉车'">叉车</button>
        </div>

        <label>船厂简写</label>
        <input
          v-model="orgName"
          class="cell-input"
          placeholder="如：武汉青山船厂"
        />

        <label>行程起止</label>
        <div class="inline">
          <input v-model="tripStart" type="date" class="cell-input date" />
          <span>至</span>
          <input v-model="tripEnd" type="date" class="cell-input date" />
        </div>

        <label>报销日期</label>
        <input v-model="reportDateStr" type="date" class="cell-input" />

        <label>报销单文件名</label>
        <input
          v-model="reportNameInput"
          class="cell-input"
          :placeholder="defaultReportName"
        />

        <label>文件夹重命名</label>
        <div class="inline">
          <input v-model="renameFolderEnabled" type="checkbox" id="ck-rename" />
          <input
            v-model="folderNameInput"
            class="cell-input"
            :placeholder="defaultFolderName"
            :disabled="!renameFolderEnabled"
          />
        </div>
      </div>
    </section>

    <!-- 步骤 4：执行 -->
    <section v-if="hasEntries" class="card action-card">
      <button
        class="btn btn-primary btn-lg"
        :disabled="!canOrganize"
        @click="startOrganize"
      >
        {{ organizing ? '整理中…' : '开始整理' }}
      </button>
      <div v-if="errorMsg" class="error">✕ {{ errorMsg }}</div>
    </section>

    <!-- 警告 -->
    <section v-if="warnings.length" class="card warn-card">
      <div v-for="(w, i) in warnings" :key="i" class="warn">⚠ {{ w }}</div>
    </section>

    <!-- 结果 -->
    <section v-if="result" class="card result-card">
      <div class="step-title">✅ 整理完成</div>
      <p class="result-line">报销单：{{ result.reportPath }}</p>
      <p class="result-line">
        发票 {{ rows.length }} 条 /
        {{ rows.reduce((s, r) => s + r.files.length, 0) }} 张<template
          v-if="customItems.length"
          >，自定义条目 {{ customItems.length }} 条</template
        >，合计
        <strong class="result-total">¥{{ grandTotal.toFixed(2) }}</strong>
      </p>
      <details>
        <summary>重命名清单（{{ result.renamed.length }} 个文件）</summary>
        <div v-for="(r, i) in result.renamed" :key="i" class="rename-line">
          <span class="from">{{ r.from }}</span> →
          <span class="to">{{ r.to }}</span>
        </div>
      </details>
      <div class="inline" style="margin-top: 12px">
        <button class="btn btn-primary" @click="openResultFolder">
          打开文件夹
        </button>
        <button class="btn" @click="reset">整理下一个</button>
      </div>
    </section>

    <!-- PDF 预览弹框（可移动、非模态，选中文字右键填充当前行） -->
    <PdfPreviewDialog
      v-if="preview"
      :file-paths="preview.files"
      :row-id="preview.rowId"
      :row-label="preview.label"
      @close="preview = null"
      @fill="onFill"
    />
  </div>
</template>

<style scoped>
.page {
  position: relative;
  max-width: 1000px;
  margin: 0 auto;
  padding: 28px 16px 60px;
  color: var(--text-1);
}

/* ============ 页头与主题切换 ============ */
.page-header {
  position: relative;
  text-align: center;
  margin-bottom: 24px;
}
.page-header h1 {
  margin: 0 0 6px;
  font-size: 26px;
  font-weight: 700;
  letter-spacing: 0.5px;
  background: linear-gradient(135deg, var(--primary), var(--primary-grad-end));
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
}
.page-header p {
  margin: 0;
  color: var(--text-3);
  font-size: 14px;
}
/* 主题切换：固定右上角悬浮按钮，点击展开菜单 */
.theme-fab {
  position: fixed;
  top: 14px;
  right: 14px;
  z-index: 900;
}
.theme-toggle-btn {
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: var(--bg-card);
  color: var(--text-2);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: var(--shadow-card);
  transition:
    color 0.2s ease,
    border-color 0.2s ease,
    box-shadow 0.2s ease;
}
.theme-toggle-btn:hover {
  color: var(--primary);
  border-color: var(--primary);
  box-shadow: var(--shadow-card-hover);
}
.theme-menu {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  min-width: 128px;
  padding: 4px;
  border-radius: 10px;
  border: 1px solid var(--border);
  background: var(--bg-card);
  box-shadow: var(--shadow-pop);
}
.theme-menu button {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  border: none;
  background: transparent;
  color: var(--text-1);
  padding: 7px 10px;
  border-radius: 6px;
  font-size: 12px;
  white-space: nowrap;
  cursor: pointer;
}
.theme-menu button:hover {
  background: var(--bg-hover);
}
.theme-menu button.active {
  color: var(--primary);
  background: var(--primary-soft);
}
/* 展开/收起动画 */
.theme-menu-enter-active,
.theme-menu-leave-active {
  transition:
    opacity 0.15s ease,
    transform 0.15s ease;
  transform-origin: top right;
}
.theme-menu-enter-from,
.theme-menu-leave-to {
  opacity: 0;
  transform: scale(0.92) translateY(-4px);
}

/* ============ 卡片 ============ */
.card {
  background: var(--bg-card);
  border: 1px solid var(--border-softer);
  border-radius: 12px;
  padding: 18px 20px;
  margin-bottom: 16px;
  box-shadow: var(--shadow-card);
  transition:
    background-color 0.25s ease,
    border-color 0.25s ease,
    box-shadow 0.2s ease;
}
.card:hover {
  box-shadow: var(--shadow-card-hover);
}
.step-title {
  font-size: 16px;
  font-weight: 600;
  margin-bottom: 14px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.step-no {
  display: inline-flex;
  width: 22px;
  height: 22px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--primary), var(--primary-hover));
  color: #fff;
  font-size: 13px;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.step-tip {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-3);
}
.total-badge {
  margin-left: auto;
  padding: 4px 12px;
  border-radius: 14px;
  background: var(--primary-soft);
  color: var(--primary-soft-text);
  font-size: 14px;
  font-weight: 700;
}

/* ============ 按钮 ============ */
.btn {
  border: 1px solid var(--border);
  background: var(--bg-card);
  border-radius: 6px;
  padding: 8px 18px;
  font-size: 14px;
  cursor: pointer;
  color: var(--text-1);
}
.btn:hover:not(:disabled) {
  border-color: var(--primary);
  color: var(--primary);
}
.btn-primary {
  background: linear-gradient(135deg, var(--primary), var(--primary-hover));
  border-color: transparent;
  color: #fff;
}
.btn-primary:hover:not(:disabled) {
  color: #fff;
  filter: brightness(1.08);
  box-shadow: 0 4px 14px color-mix(in srgb, var(--primary) 35%, transparent);
}
.btn-lg {
  padding: 12px 48px;
  font-size: 16px;
}
.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* ============ 文件夹选择 ============ */
.folder-row {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.folder-path {
  color: var(--text-2);
  font-size: 13px;
  word-break: break-all;
}
.hint {
  margin-top: 10px;
  color: var(--text-3);
  font-size: 13px;
}
.hint-inline {
  color: var(--text-3);
  font-size: 12px;
}

/* ============ 发票表格 ============ */
.invoice-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.invoice-table th {
  text-align: left;
  padding: 8px 6px;
  border-bottom: 2px solid var(--border-soft);
  color: var(--text-3);
  font-weight: 500;
  white-space: nowrap;
}
.invoice-table td {
  padding: 6px;
  border-bottom: 1px solid var(--border-softer);
  vertical-align: middle;
}
.invoice-table tbody tr {
  transition: background-color 0.15s ease;
}
.invoice-table tbody tr:hover {
  background: var(--bg-hover);
}
.invoice-table tr.confirm,
.invoice-table tr.confirm:hover {
  background: var(--warn-bg);
}
.seq {
  font-weight: 600;
  color: var(--primary);
}
.files {
  font-size: 12px;
  color: var(--text-2);
  word-break: break-all;
}
.note {
  color: var(--warn-text);
  font-size: 11px;
  margin-top: 2px;
}

/* 类型标签（颜色变量见 style.css，暗色自动切换） */
.tag {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 12px;
  background: var(--tag-bg);
  color: var(--tag-text);
}
.tag.railway {
  background: var(--tag-railway-bg);
  color: var(--tag-railway-text);
}
.tag.flight {
  background: var(--tag-flight-bg);
  color: var(--tag-flight-text);
}
.tag.hotel {
  background: var(--tag-hotel-bg);
  color: var(--tag-hotel-text);
}
.tag.taxi {
  background: var(--tag-taxi-bg);
  color: var(--tag-taxi-text);
}
.tag.toll {
  background: var(--tag-toll-bg);
  color: var(--tag-toll-text);
}
.tag.express {
  background: var(--tag-express-bg);
  color: var(--tag-express-text);
}
.tag.other {
  background: var(--tag-bg);
  color: var(--tag-text);
}

/* ============ 表格内输入框 ============ */
.cell-input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid var(--border);
  border-radius: 5px;
  padding: 6px 8px;
  font-size: 13px;
  background: var(--bg-card);
  color: var(--text-1);
}
.cell-input:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 18%, transparent);
}
.cell-input.center {
  text-align: center;
}
.year-row {
  margin-top: 12px;
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.custom-actions {
  margin-top: 12px;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}
.year-input {
  width: 90px;
  text-align: center;
}

/* 排序与预览小按钮 */
.move button,
.preview-btn {
  border: 1px solid var(--border);
  background: var(--bg-card);
  color: var(--text-1);
  border-radius: 4px;
  cursor: pointer;
}
.move button {
  width: 26px;
  height: 24px;
  margin-right: 4px;
}
.move button:hover:not(:disabled),
.preview-btn:hover {
  background: var(--primary-soft);
  border-color: var(--primary);
  color: var(--primary);
}
.move button:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
.preview-cell {
  text-align: center;
}
.preview-btn {
  padding: 2px 7px;
}

/* ============ 报销信息表单 ============ */
.form-grid {
  display: grid;
  grid-template-columns: 110px 1fr;
  gap: 12px 14px;
  align-items: center;
  font-size: 14px;
}
.form-grid label {
  color: var(--text-2);
  text-align: right;
}
.inline {
  display: flex;
  align-items: center;
  gap: 8px;
}
.inline .date {
  width: 150px;
}
.chip {
  border: 1px solid var(--border);
  background: var(--bg-subtle);
  color: var(--text-2);
  border-radius: 12px;
  padding: 4px 12px;
  font-size: 12px;
  cursor: pointer;
  white-space: nowrap;
}
.chip:hover {
  border-color: var(--primary);
  color: var(--primary);
}

/* ============ 执行 / 警告 / 结果 ============ */
.action-card {
  text-align: center;
}
.error {
  margin-top: 12px;
  color: var(--error);
  font-size: 13px;
}
.warn-card {
  background: var(--warn-bg);
  border-color: color-mix(in srgb, var(--warn-text) 25%, transparent);
}
.warn {
  color: var(--warn-text);
  font-size: 13px;
  padding: 2px 0;
}
.result-card {
  border: 1px solid var(--success-border);
  background: var(--success-bg);
}
.result-card summary {
  cursor: pointer;
  color: var(--text-2);
  font-size: 13px;
}
.result-line {
  font-size: 14px;
  word-break: break-all;
}
.rename-line {
  font-size: 12px;
  color: var(--text-2);
  padding: 2px 0;
}
.rename-line .to {
  color: var(--success-text);
}
.result-total {
  color: var(--primary-soft-text);
  font-size: 16px;
}

/* 窄屏适配 */
@media (max-width: 720px) {
  .form-grid {
    grid-template-columns: 1fr;
    gap: 6px;
  }
  .form-grid label {
    text-align: left;
  }
}
</style>

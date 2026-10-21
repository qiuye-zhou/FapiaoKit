// 发票 PDF 文本解析器
// 核心思路：先做 compact 归一化（去掉所有 | 和空格），横排版与竖排版（逐字切开）统一处理
import { simplifyStation, findCityInText } from './cityDict'
import { InvoiceType } from './types'

export interface ParseResult {
  matched: boolean
  /** invoice=报销单数据行；attachment=附件（如网约车行程单，配对用） */
  role?: 'invoice' | 'attachment'
  type?: InvoiceType
  content?: string
  year?: number
  month?: number
  day?: number
  amount?: number
  needConfirm?: boolean
  note?: string
}

const NO_MATCH: ParseResult = { matched: false }

/** compact 归一化：去掉所有 |、空格、换行，横排/竖排统一 */
function compactText(raw: string): string {
  return raw.replace(/[|\s]/g, '')
}

/**
 * 中文大写金额解析：壹佰贰拾柒圆陆角肆分 → 127.64
 * 从「价税合计（大写）」后提取，是最可靠的金额来源（不受竖排数字粘连影响）
 */
const CN_DIGITS: Record<string, number> = {
  零: 0,
  壹: 1,
  贰: 2,
  叁: 3,
  肆: 4,
  伍: 5,
  陆: 6,
  柒: 7,
  捌: 8,
  玖: 9,
}
const CN_UNITS: Record<string, number> = { 拾: 10, 佰: 100, 仟: 1000 }
const CN_BIG: Record<string, number> = { 万: 10000, 亿: 100000000 }

function cnUpperToNumber(s: string): number | null {
  let num = 0 // 当前待挂到单位的数字
  let section = 0 // 当前万/亿段内累计
  let result = 0 // 已完成的大段
  let jiao = 0
  let fen = 0
  let afterYuan = false
  for (const ch of s) {
    if (CN_DIGITS[ch] !== undefined) {
      num = CN_DIGITS[ch]
    } else if (CN_UNITS[ch] !== undefined) {
      section += (num || 1) * CN_UNITS[ch] // 拾圆=10：数字缺省按 1
      num = 0
    } else if (CN_BIG[ch] !== undefined) {
      section = (section + num) * CN_BIG[ch]
      result += section
      section = 0
      num = 0
    } else if (ch === '圆' || ch === '元') {
      result += section + num
      section = 0
      num = 0
      afterYuan = true
    } else if (ch === '角') {
      jiao = num
      num = 0
    } else if (ch === '分') {
      fen = num
      num = 0
    } else if (ch === '整') {
      break
    }
  }
  const value = result + section + num + jiao * 0.1 + fen * 0.01
  if (value <= 0 || value > 10000000) return null
  return Math.round(value * 100) / 100
}

/** 提取价税合计：优先大写金额，其次 compact 文本中 ¥N / N¥ 的最大值 */
function extractTotalAmount(c: string): number | null {
  const upperM = c.match(
    /价税合计（大写）([零壹贰叁肆伍陆柒捌玖拾佰仟万亿圆元角分整]+)/,
  )
  if (upperM) {
    const v = cnUpperToNumber(upperM[1])
    if (v != null) return v
  }
  // 兜底：正文任意位置的大写金额串（首个字符必须是数字字，避免误匹配）
  const looseM = c.match(
    /([壹贰叁肆伍陆柒捌玖][零壹贰叁肆伍陆柒捌玖拾佰仟万亿圆元角分整]{2,})/,
  )
  if (looseM) {
    const v = cnUpperToNumber(looseM[1])
    if (v != null) return v
  }
  return extractMaxAmount(c)
}

/**
 * 兜底：compact 文本中所有 ¥N 或 N¥ 形式的金额取最大值（价税合计 ≥ 任一明细）
 * 注意：竖排版数字可能与发票号粘连成巨数，仅作为大写金额缺失时的兜底
 */
function extractMaxAmount(c: string): number | null {
  const re = /[¥￥](\d{1,6}(?:\.\d{1,2})?)|(\d{1,6}(?:\.\d{1,2})?)[¥￥]/g
  let m: RegExpExecArray | null
  let max = 0
  let found = false
  while ((m = re.exec(c)) !== null) {
    const v = parseFloat(m[1] ?? m[2])
    if (!isNaN(v) && v > max && v <= 10000000) {
      max = v
      found = true
    }
  }
  return found ? max : null
}

/** 标准中文日期：2026年09月09日 */
function parseCnDate(c: string): { y: number; m: number; d: number } | null {
  const m = c.match(/(\d{4})年(\d{2})月(\d{2})日/)
  return m ? { y: +m[1], m: +m[2], d: +m[3] } : null
}

/** 提取出发-到达站（compact 文本：上海虹桥站南京南站） */
function parseStations(c: string): { from: string; to: string } | null {
  const m = c.match(/([一-龥]{2,8})站([一-龥]{2,8})站/)
  if (!m) return null
  return { from: simplifyStation(m[1]), to: simplifyStation(m[2]) }
}

// ================= 高铁（铁路电子客票）：票价 / 退票费 =================
function parseRailway(c: string): ParseResult {
  if (!c.includes('铁路电子客票')) return NO_MATCH

  const stations = parseStations(c)
  const date = parseCnDate(c)
  const amount = extractTotalAmount(c)
  const isRefund = c.includes('退票费:')

  if (!stations || amount == null) {
    return {
      matched: true,
      role: 'invoice',
      type: 'railway',
      needConfirm: true,
      note: '高铁票字段提取不完整，请核对',
    }
  }
  return {
    matched: true,
    role: 'invoice',
    type: 'railway',
    content: `${stations.from}-${stations.to}${isRefund ? '退票费' : '高铁'}`,
    year: date?.y,
    month: date?.m,
    day: date?.d,
    amount: amount ?? undefined,
    needConfirm: isRefund,
    note: isRefund ? '退票费，请核对日期' : undefined,
  }
}

// ================= 高速通行费 =================
function parseToll(c: string): ParseResult {
  const isToll =
    c.includes('*通行费') ||
    c.includes('车辆通行费') ||
    c.includes('通行费通用')
  if (!isToll || !c.includes('发票')) return NO_MATCH

  const date =
    parseCnDate(c) ||
    // 江苏版日期被拆开：2026开票日期:年月日0924
    (() => {
      const m = c.match(/(\d{4})开票日期:年月日(\d{2})(\d{2})/)
      return m ? { y: +m[1], m: +m[2], d: +m[3] } : null
    })()
  // 江苏版金额无 ¥ 符号：（小写）28.00
  const amount =
    extractTotalAmount(c) ??
    (() => {
      const m = c.match(/（小写）(\d+(?:\.\d+)?)/)
      return m ? parseFloat(m[1]) : null
    })()

  return {
    matched: true,
    role: 'invoice',
    type: 'toll',
    content: '高速费',
    year: date?.y,
    month: date?.m,
    day: date?.d,
    amount: amount ?? undefined,
    needConfirm: !date || amount == null,
    note: !date || amount == null ? '通行费字段提取不完整，请核对' : undefined,
  }
}

// ================= 快递费（收派服务/速运公司） =================
function parseExpress(c: string): ParseResult {
  if (!c.includes('收派服务') && !c.includes('快递费')) return NO_MATCH

  const date = parseCnDate(c)
  const amount = extractTotalAmount(c)
  return {
    matched: true,
    role: 'invoice',
    type: 'express',
    content: '快递费',
    year: date?.y,
    month: date?.m,
    day: date?.d,
    amount: amount ?? undefined,
  }
}

// ================= 网约车行程单（附件：滴滴/高德/曹操/花小猪等） =================
function parseTrip(c: string): ParseResult {
  if (!c.includes('行程单')) return NO_MATCH

  // 共计1单行程，合计127.64元（高德）/ 共1笔行程，合计138.80元（滴滴/花小猪/曹操）
  const am = c.match(/共[计]?\d*[笔单]行程[，,]?\s*合计(\d+(?:\.\d+)?)元/)
  // 行程起止日期：2026-09-10 至 2026-09-10
  const dm = c.match(/行程起止日期：(\d{4})-(\d{2})-(\d{2})/)

  return {
    matched: true,
    role: 'attachment',
    type: 'taxi',
    amount: am ? parseFloat(am[1]) : undefined,
    year: dm ? +dm[1] : undefined,
    month: dm ? +dm[2] : undefined,
    day: dm ? +dm[3] : undefined,
  }
}

// ================= 网约车打车发票（客运服务费） =================
function parseTaxi(c: string): ParseResult {
  const isTaxi = c.includes('客运服务') || c.includes('客运服') // 竖排里"客运服|务费"compact 后完整
  if (!isTaxi || !c.includes('发票')) return NO_MATCH
  // 排除铁路与快递（它们也可能含"服务"字样）
  if (c.includes('铁路') || c.includes('收派服务')) return NO_MATCH

  const date = parseCnDate(c)
  const amount = extractTotalAmount(c)
  return {
    matched: true,
    role: 'invoice',
    type: 'taxi',
    content: '打车',
    year: date?.y,
    month: date?.m,
    day: date?.d,
    amount: amount ?? undefined,
    needConfirm: amount == null,
    note: amount == null ? '未识别到金额，请手动填写' : undefined,
  }
}

// ================= 飞机（行程单 / 代订机票） =================
function parseFlight(c: string): ParseResult {
  const isAgent = c.includes('代订机票')
  const isItinerary =
    c.includes('电子客票行程单') || c.includes('航空运输电子客票')
  if (!isAgent && !isItinerary) return NO_MATCH

  const date = parseCnDate(c)
  const amount = extractTotalAmount(c)
  // 行程单上可能有航段城市对
  const seg = c.match(/([一-龥]{2,4})(?:机场)?[-—]([一-龥]{2,4})(?:机场)?/)
  let content = '机票'
  if (isItinerary && seg) {
    content = `${simplifyStation(seg[1])}-${simplifyStation(seg[2])}飞机`
  }
  return {
    matched: true,
    role: 'invoice',
    type: 'flight',
    content,
    year: date?.y,
    month: date?.m,
    day: date?.d,
    amount: amount ?? undefined,
    needConfirm: true,
    note: isAgent ? '代订机票服务费发票，请核对实际机票信息' : '机票字段请核对',
  }
}

// ================= 住宿费发票 =================
function parseHotel(c: string, fileName: string): ParseResult {
  const isHotel =
    c.includes('住宿服务') ||
    c.includes('住宿费') ||
    /酒店|宾馆|旅馆/.test(c) ||
    /酒店|宾馆|旅馆|住宿/.test(fileName)
  if (!isHotel || !c.includes('发票')) return NO_MATCH

  const date = parseCnDate(c)
  const amount = extractTotalAmount(c)
  let city: string | null = null
  const hotelNameM = c.match(/([一-龥]{2,20}(?:酒店|宾馆|旅馆)[一-龥]{0,15})/)
  if (hotelNameM) city = findCityInText(hotelNameM[1])
  if (!city) city = findCityInText(fileName)

  return {
    matched: true,
    role: 'invoice',
    type: 'hotel',
    content: city ? `${city}住宿费` : '住宿费',
    year: date?.y,
    month: date?.m,
    day: date?.d,
    amount: amount ?? undefined,
    needConfirm: true,
    note: '日期为开票日期，请核对实际住宿日期',
  }
}

// ================= 扫描件 / 兜底 =================
/**
 * 从已整理的规范文件名回读：01-上海-南京高铁-9.18-162.pdf /
 * 08-打车-9.10-138.8-行程单.pdf
 * 用于扫描件（无文本层）再次扫描时保留人工填写过的内容与金额
 */
function parseOrganizedName(fileName: string): ParseResult | null {
  const m = fileName
    .replace(/\.pdf$/i, '')
    .match(/^\d{2}-(.+?)-(\d{1,2})\.(\d{1,2})-(\d+(?:\.\d+)?)(-行程单)?$/)
  if (!m) return null

  const content = m[1]
  let type: InvoiceType = 'other'
  if (/高铁|退票费/.test(content)) type = 'railway'
  else if (/飞机|机票/.test(content)) type = 'flight'
  else if (/住宿/.test(content)) type = 'hotel'
  else if (content === '打车') type = 'taxi'
  else if (/高速/.test(content)) type = 'toll'
  else if (/快递/.test(content)) type = 'express'

  return {
    matched: true,
    role: m[5] ? 'attachment' : 'invoice',
    type,
    content,
    month: +m[2],
    day: +m[3],
    amount: parseFloat(m[4]),
  }
}

function parseFallback(
  c: string,
  fileName: string,
  rawLen: number,
): ParseResult {
  const isScan = c.includes('扫描全能王') || rawLen < 15
  const date = parseCnDate(c)
  const amount = extractTotalAmount(c)
  return {
    matched: true,
    role: 'invoice',
    type: 'other',
    content: fileName.replace(/\.pdf$/i, ''),
    year: date?.y,
    month: date?.m,
    day: date?.d,
    amount: amount ?? undefined,
    needConfirm: true,
    note: isScan
      ? '扫描件无文本层，无法自动识别，请手动填写类型、日期与金额'
      : '未能识别发票类型，请手动核对',
  }
}

/** 按优先级尝试各 parser，返回第一个匹配结果 */
export function parseInvoiceText(raw: string, fileName: string): ParseResult {
  const c = compactText(raw)
  const chain: Array<(t: string) => ParseResult> = [
    parseRailway,
    parseToll,
    parseExpress,
    parseTrip,
    parseTaxi,
    parseFlight,
  ]
  for (const p of chain) {
    const r = p(c)
    if (r.matched) return r
  }
  const hotel = parseHotel(c, fileName)
  if (hotel.matched) return hotel
  return parseOrganizedName(fileName) ?? parseFallback(c, fileName, raw.length)
}

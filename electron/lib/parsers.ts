// 发票 PDF 文本解析器：按文本特征识别类型并提取字段
import { simplifyStation, findCityInText } from './cityDict'
import { InvoiceType } from './types'

export interface ParseResult {
  matched: boolean
  /** invoice=报销单数据行；attachment=附件（如滴滴行程单，配对用） */
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

/** 提取所有 ¥|数字 或 ￥|数字 中的最大值（价税合计≥任一明细行） */
function extractMaxAmount(text: string): number | null {
  const re = /[¥￥]\|(\d+(?:\.\d+)?)/g
  let m: RegExpExecArray | null
  let max = 0
  let found = false
  while ((m = re.exec(text)) !== null) {
    const v = parseFloat(m[1])
    if (!isNaN(v) && v > max) {
      max = v
      found = true
    }
  }
  return found ? max : null
}

// ================= 高铁（铁路电子客票） =================
function parseRailway(text: string): ParseResult {
  if (!text.includes('铁路电子客票')) return NO_MATCH

  // 出发/到达站：上海虹桥|站| |武汉|站
  const stationRe = /([^\s|]{1,10})\|站\|\s*\|([^\s|]{1,10})\|站/
  const sm = text.match(stationRe)

  // 乘车日期：2026年09月28日| |16:53开
  const dateRe = /(\d{4})年(\d{2})月(\d{2})日\|\s*\|\d{1,2}:\d{2}开/
  const dm = text.match(dateRe)

  // 金额：最后一个 ￥|数字
  const amounts: number[] = []
  const re = /[¥￥]\|(\d+(?:\.\d+)?)/g
  let am: RegExpExecArray | null
  while ((am = re.exec(text)) !== null) amounts.push(parseFloat(am[1]))
  const amount = amounts.length ? amounts[amounts.length - 1] : null

  if (!sm || !dm || amount == null) {
    return {
      matched: true,
      role: 'invoice',
      type: 'railway',
      needConfirm: true,
      note: '高铁票字段提取不完整，请核对',
    }
  }
  const from = simplifyStation(sm[1])
  const to = simplifyStation(sm[2])
  return {
    matched: true,
    role: 'invoice',
    type: 'railway',
    content: `${from}-${to}高铁`,
    year: parseInt(dm[1], 10),
    month: parseInt(dm[2], 10),
    day: parseInt(dm[3], 10),
    amount,
  }
}

// ================= 飞机（航空电子客票行程单） =================
function parseFlight(text: string): ParseResult {
  if (!text.includes('电子客票行程单') && !text.includes('航空运输电子客票'))
    return NO_MATCH

  const dm =
    text.match(/(\d{4})年(\d{2})月(\d{2})日/) ||
    text.match(/(\d{4})-(\d{2})-(\d{2})/)
  const amount = extractMaxAmount(text)
  // 尝试提取航段：城市名对（如 上海|大连 / 上海-大连）
  const seg = text.match(/([一-龥]{2,4})\s*[-—|]\s*([一-龥]{2,4})/)
  let content = '飞机票'
  if (seg) {
    const from = simplifyStation(seg[1])
    const to = simplifyStation(seg[2])
    content = `${from}-${to}飞机`
  }
  return {
    matched: true,
    role: 'invoice',
    type: 'flight',
    content,
    year: dm ? parseInt(dm[1], 10) : undefined,
    month: dm ? parseInt(dm[2], 10) : undefined,
    day: dm ? parseInt(dm[3], 10) : undefined,
    amount: amount ?? undefined,
    needConfirm: true,
    note: '机票字段请核对',
  }
}

// ================= 滴滴·电子发票 =================
function parseDidiInvoice(text: string): ParseResult {
  if (!text.includes('滴滴') || !text.includes('发票号码')) return NO_MATCH

  // 价税合计（小写）：价 税 合 计 （ 大 写 ）| |（ 小 写 ）| |18.90|¥
  let amount: number | null = null
  const am = text.match(/小\s*写\s*）\| \|(\d+(?:\.\d+)?)\|¥/)
  if (am) amount = parseFloat(am[1])
  if (amount == null) amount = extractMaxAmount(text)

  return {
    matched: true,
    role: 'invoice',
    type: 'taxi',
    content: '打车',
    amount: amount ?? undefined,
    needConfirm: true,
    note: '滴滴发票日期需与行程单配对',
  }
}

// ================= 滴滴·行程报销单（附件，配对用） =================
function parseDidiTrip(text: string): ParseResult {
  if (!text.includes('滴滴出行-行程单') && !text.includes('DIDI TRAVEL'))
    return NO_MATCH

  // 合计金额：共1笔行程， 合计18.90元
  const am = text.match(/共\d+笔行程，\s*合计(\d+(?:\.\d+)?)元/)
  // 行程起止日期：2026-09-28 至 2026-09-29 → 取首日
  const dm = text.match(/行程起止日期：(\d{4})-(\d{2})-(\d{2})/)

  return {
    matched: true,
    role: 'attachment',
    type: 'taxi',
    amount: am ? parseFloat(am[1]) : undefined,
    year: dm ? parseInt(dm[1], 10) : undefined,
    month: dm ? parseInt(dm[2], 10) : undefined,
    day: dm ? parseInt(dm[3], 10) : undefined,
  }
}

// ================= 住宿费发票 =================
function parseHotel(text: string, fileName: string): ParseResult {
  const isHotel =
    text.includes('住宿服务') ||
    text.includes('住宿费') ||
    /酒店|宾馆|旅馆/.test(text) ||
    /酒店|宾馆|旅馆|住宿/.test(fileName)
  if (!isHotel) return NO_MATCH
  // 必须同时是发票
  if (!text.includes('发票')) return NO_MATCH

  const dm = text.match(/(\d{4})年(\d{2})月(\d{2})日/)
  const amount = extractMaxAmount(text)

  // 城市：从酒店销售方名称提取（如 武汉合富呈祥酒店管理有限公司）
  let city: string | null = null
  const hotelNameM = text.match(
    /([一-龥]{2,20}(?:酒店|宾馆|旅馆)[一-龥]{0,15})/,
  )
  if (hotelNameM) city = findCityInText(hotelNameM[1])
  if (!city) city = findCityInText(fileName)

  return {
    matched: true,
    role: 'invoice',
    type: 'hotel',
    content: city ? `${city}住宿费` : '住宿费',
    year: dm ? parseInt(dm[1], 10) : undefined,
    month: dm ? parseInt(dm[2], 10) : undefined,
    day: dm ? parseInt(dm[3], 10) : undefined,
    amount: amount ?? undefined,
    needConfirm: true,
    note: '日期为开票日期，请核对实际住宿日期',
  }
}

// ================= 兜底 =================
function parseFallback(text: string, fileName: string): ParseResult {
  const dm =
    text.match(/(\d{4})年(\d{2})月(\d{2})日/) ||
    text.match(/(\d{4})-(\d{2})-(\d{2})/)
  const amount = extractMaxAmount(text)
  return {
    matched: true,
    role: 'invoice',
    type: 'other',
    content: fileName.replace(/\.pdf$/i, ''),
    year: dm ? parseInt(dm[1], 10) : undefined,
    month: dm ? parseInt(dm[2], 10) : undefined,
    day: dm ? parseInt(dm[3], 10) : undefined,
    amount: amount ?? undefined,
    needConfirm: true,
    note: '未能识别发票类型，请手动核对',
  }
}

/** 按优先级尝试各 parser，返回第一个匹配结果 */
export function parseInvoiceText(text: string, fileName: string): ParseResult {
  const chain: Array<(t: string, f: string) => ParseResult> = [
    parseRailway,
    parseDidiTrip,
    parseDidiInvoice,
    parseFlight,
    parseHotel,
  ]
  for (const p of chain) {
    const r = p(text, fileName)
    if (r.matched) return r
  }
  return parseFallback(text, fileName)
}

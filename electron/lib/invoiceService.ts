// 扫描文件夹 → 解析所有 PDF → 滴滴发票与行程单配对 → 排序
import * as fs from 'fs'
import * as path from 'path'
import { randomUUID } from 'crypto'
import { extractPdfText } from './pdfExtract'
import { parseInvoiceText, ParseResult } from './parsers'
import { InvoiceRecord, InvoiceType } from './types'

export interface ScanResult {
  records: InvoiceRecord[]
  warnings: string[]
}

// 报销单默认行序：高铁 → 飞机 → 住宿 → 打车 → 高速 → 快递 → 其他（组内按文件名字典序）
const TYPE_ORDER: Record<InvoiceType, number> = {
  railway: 0,
  flight: 1,
  hotel: 2,
  taxi: 3,
  toll: 4,
  express: 5,
  other: 6,
}

export async function scanAndParse(folderPath: string): Promise<ScanResult> {
  const warnings: string[] = []
  const files = fs
    .readdirSync(folderPath)
    .filter((f) => f.toLowerCase().endsWith('.pdf'))

  interface Parsed {
    file: string
    result: ParseResult
  }
  const parsed: Parsed[] = []
  for (const f of files) {
    let lastErr: Error | null = null
    let text = ''
    // 连续处理大量 PDF 时 pdfjs 偶发栈溢出，重试一次通常可恢复
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        text = await extractPdfText(path.join(folderPath, f))
        lastErr = null
        break
      } catch (e) {
        lastErr = e as Error
      }
    }
    if (lastErr) {
      warnings.push(`PDF 解析失败 ${f}: ${lastErr.message}`)
      parsed.push({
        file: f,
        result: {
          matched: true,
          role: 'invoice',
          type: 'other',
          content: f.replace(/\.pdf$/i, ''),
          needConfirm: true,
          note: 'PDF 解析失败，请手动填写',
        },
      })
      continue
    }
    parsed.push({ file: f, result: parseInvoiceText(text, f) })
  }

  const invoices = parsed.filter((p) => p.result.role === 'invoice')
  const trips = parsed.filter(
    (p) => p.result.role === 'attachment' && p.result.type === 'taxi',
  )
  const usedTrips = new Set<string>()

  // 扫描件等无年份记录：采用本批发票中出现最多的年份
  const yearFreq = new Map<number, number>()
  for (const p of parsed) {
    if (p.result.year)
      yearFreq.set(p.result.year, (yearFreq.get(p.result.year) ?? 0) + 1)
  }
  let defaultYear = new Date().getFullYear()
  let maxFreq = 0
  for (const [y, n] of yearFreq) {
    if (n > maxFreq) {
      maxFreq = n
      defaultYear = y
    }
  }

  const records: InvoiceRecord[] = []
  for (const inv of invoices) {
    const r = inv.result
    const rec: InvoiceRecord = {
      id: randomUUID(),
      type: r.type ?? 'other',
      content: r.content ?? inv.file.replace(/\.pdf$/i, ''),
      year: r.year ?? defaultYear,
      month: r.month ?? 0,
      day: r.day ?? 0,
      amount: r.amount ?? 0,
      files: [inv.file],
      needConfirm: r.needConfirm ?? false,
      note: r.note,
    }

    // 滴滴发票：按金额配对行程单，取行程日期
    if (r.type === 'taxi') {
      const trip = trips.find(
        (t) =>
          !usedTrips.has(t.file) &&
          t.result.amount != null &&
          r.amount != null &&
          Math.abs(t.result.amount - r.amount) < 0.01,
      )
      if (trip) {
        usedTrips.add(trip.file)
        rec.files.push(trip.file)
        if (trip.result.year) {
          rec.year = trip.result.year
          rec.month = trip.result.month ?? 0
          rec.day = trip.result.day ?? 0
          rec.needConfirm = false
          rec.note = '日期取自行程单'
        }
      } else {
        rec.note = '未找到配对行程单，请手动核对日期'
      }
    }
    records.push(rec)
  }

  for (const t of trips) {
    if (!usedTrips.has(t.file))
      warnings.push(`行程单「${t.file}」未找到对应发票`)
  }

  records.sort((a, b) => {
    const t = TYPE_ORDER[a.type] - TYPE_ORDER[b.type]
    if (t !== 0) return t
    return a.files[0].localeCompare(b.files[0], 'zh-CN')
  })

  return { records, warnings }
}

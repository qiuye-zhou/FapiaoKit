// PDF 文本提取（pdfjs-dist v3 legacy，Node 下用 fs 加载 cMap，支持高铁票嵌入字体）
import * as path from 'path'
import * as fs from 'fs'

let pdfjs: any = null
let cMapUrl = ''
let standardFontDataUrl = ''

function ensureInit(): void {
  if (pdfjs) return
  // pdfjs-dist v3 legacy 为 CJS，必须 require
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  pdfjs = require('pdfjs-dist/legacy/build/pdf.js')
  const pkgDir = path.dirname(require.resolve('pdfjs-dist/package.json'))
  cMapUrl = path.join(pkgDir, 'cmaps') + path.sep
  standardFontDataUrl = path.join(pkgDir, 'standard_fonts') + path.sep
}

/** 提取 PDF 全文，文本片段用 | 连接（保留原始顺序） */
export async function extractPdfText(filePath: string): Promise<string> {
  ensureInit()
  const data = new Uint8Array(fs.readFileSync(filePath))
  const doc = await pdfjs.getDocument({
    data,
    cMapUrl,
    cMapPacked: true,
    standardFontDataUrl,
  }).promise
  try {
    const parts: string[] = []
    for (let i = 1; i <= doc.numPages; i++) {
      const page = await doc.getPage(i)
      const tc = await page.getTextContent()
      parts.push(tc.items.map((it: { str: string }) => it.str).join('|'))
    }
    return parts.join('\n')
  } finally {
    // 立即释放文档资源，避免批量处理时的内存/句柄累积
    try {
      doc.destroy()
    } catch {
      /* ignore */
    }
  }
}

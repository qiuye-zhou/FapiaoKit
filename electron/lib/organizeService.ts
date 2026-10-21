// 整理服务：批量重命名 PDF + 基于模板生成报销单 + 可选重命名文件夹
import * as path from 'path'
import * as fs from 'fs'
import ExcelJS from 'exceljs'
import { InvoiceRecord, OrganizeRequest, OrganizeResult } from './types'

const MAX_ROWS = 50 // 模板数据区为第 8-57 行

function formatAmount(amount: number): string {
  return String(Number(amount.toFixed(2)))
}

/** 目标文件名：{序号:02d}-{报销内容}-{月.日}-{金额}.pdf；行程单加后缀 */
export function buildTargetName(
  rec: InvoiceRecord,
  seq: number,
  fileIndex: number,
): string {
  const pad = String(seq).padStart(2, '0')
  const base = `${pad}-${rec.content}-${rec.month}.${rec.day}-${formatAmount(rec.amount)}`
  if (rec.files.length > 1 && fileIndex > 0) return `${base}-行程单.pdf`
  return `${base}.pdf`
}

function resolveTemplatePath(): string {
  // 编译后本文件位于 out/electron/lib/
  // 开发：项目根/static；生产：out/static（vite 构建时复制）
  const devPath = path.join(__dirname, '../../../static/expense-template.xlsx')
  if (fs.existsSync(devPath)) return devPath
  return path.join(__dirname, '../../static/expense-template.xlsx')
}

export async function organize(req: OrganizeRequest): Promise<OrganizeResult> {
  const warnings: string[] = []
  const { folderPath, records } = req
  if (records.length === 0) throw new Error('没有可整理的发票')
  if (records.length > MAX_ROWS) {
    throw new Error(
      `发票共 ${records.length} 条，超过模板容量（${MAX_ROWS} 行），请分批整理`,
    )
  }

  // 1. 重命名 PDF（两阶段：先全部改临时名，再改目标名，避免文件名循环冲突）
  const renamed: Array<{ from: string; to: string }> = []
  const tempMoves: Array<{ temp: string; target: string }> = []
  records.forEach((rec, i) => {
    rec.files.forEach((f, fi) => {
      const target = buildTargetName(rec, i + 1, fi)
      if (target === f) return
      const temp = `.__fpk_tmp_${i}_${fi}.pdf`
      fs.renameSync(path.join(folderPath, f), path.join(folderPath, temp))
      tempMoves.push({ temp, target })
      renamed.push({ from: f, to: target })
    })
  })
  for (const { temp, target } of tempMoves) {
    fs.renameSync(path.join(folderPath, temp), path.join(folderPath, target))
  }

  // 2. 基于模板生成报销单
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.readFile(resolveTemplatePath())
  const ws = wb.getWorksheet(1)
  if (!ws) throw new Error('报销单模板缺少工作表')

  ws.getCell('F4').value = req.projectCategory
  ws.getCell('G4').value =
    `报销日期：  ${req.reportDate.y}  年 ${req.reportDate.m} 月 ${req.reportDate.d} 日`

  records.forEach((rec, i) => {
    const r = 8 + i
    ws.getCell(`C${r}`).value = rec.year
    ws.getCell(`D${r}`).value = rec.month
    ws.getCell(`E${r}`).value = rec.day
    ws.getCell(`F${r}`).value = rec.content
    ws.getCell(`H${r}`).value = rec.amount
  })

  const totalFiles = records.reduce((s, r) => s + r.files.length, 0)
  ws.getCell('R6').value = `附单据  ${totalFiles}  张`

  const reportPath = path.join(folderPath, req.reportName)
  await wb.xlsx.writeFile(reportPath)

  // 3. 可选：重命名文件夹
  let newFolderPath = folderPath
  if (req.renameFolder && req.renameFolder !== path.basename(folderPath)) {
    const target = path.join(path.dirname(folderPath), req.renameFolder)
    try {
      fs.renameSync(folderPath, target)
      newFolderPath = target
    } catch (e) {
      warnings.push(`文件夹重命名失败：${(e as Error).message}`)
    }
  }

  return {
    reportPath: path.join(newFolderPath, req.reportName),
    renamed,
    newFolderPath,
    warnings,
  }
}

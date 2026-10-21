// 主进程共享类型

export type InvoiceType =
  | 'railway'
  | 'flight'
  | 'hotel'
  | 'taxi'
  | 'toll'
  | 'express'
  | 'other'

export interface InvoiceRecord {
  id: string
  type: InvoiceType
  /** 报销内容，如 上海-武汉高铁 / 武汉住宿费 / 打车 */
  content: string
  year: number
  month: number
  day: number
  /** 价税合计 */
  amount: number
  /** 关联 PDF 文件名（仅文件名，不含路径）。滴滴为 [发票, 行程单] */
  files: string[]
  /** 低置信度，需用户在表格里核对 */
  needConfirm: boolean
  /** 解析备注，如 "日期取自开票日期" */
  note?: string
}

export interface OrganizeRequest {
  folderPath: string
  records: InvoiceRecord[]
  projectCategory: string
  reportName: string
  reportDate: { y: number; m: number; d: number }
  /** 新文件夹名；为空则不重命名文件夹 */
  renameFolder?: string
}

export interface OrganizeResult {
  reportPath: string
  renamed: Array<{ from: string; to: string }>
  newFolderPath: string
  warnings: string[]
}

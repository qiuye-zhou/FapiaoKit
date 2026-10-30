// 渲染进程共享类型

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
  content: string
  year: number
  month: number
  day: number
  amount: number
  files: string[]
  needConfirm: boolean
  note?: string
}

export interface ScanResult {
  records: InvoiceRecord[]
  warnings: string[]
}

export interface CustomItem {
  /** 名称，如 差旅补贴 */
  content: string
  amount: number
  /** 备注 */
  note?: string
}

export interface OrganizeRequest {
  folderPath: string
  records: InvoiceRecord[]
  /** 自定义条目（补贴等），不关联 PDF，直接写入报销单 */
  customItems?: CustomItem[]
  projectCategory: string
  reportName: string
  reportDate: { y: number; m: number; d: number }
  renameFolder?: string
}

export interface OrganizeResult {
  reportPath: string
  renamed: Array<{ from: string; to: string }>
  newFolderPath: string
  warnings: string[]
}

// Electron API 类型定义
export interface ElectronAPI {
  platform: string
  versions: {
    node: string
    chrome: string
    electron: string
  }
  selectFolder: () => Promise<string | null>
  scanFolder: (folderPath: string) => Promise<ScanResult>
  organize: (req: OrganizeRequest) => Promise<OrganizeResult>
  openFolder: (p: string) => Promise<void>
  readPdf: (filePath: string) => Promise<Uint8Array>
  setThemeMode: (mode: 'light' | 'dark' | 'system') => Promise<void>
  minimize: () => Promise<void>
  maximize: () => Promise<void>
  close: () => Promise<void>
}

// 扩展 Window 接口
declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}

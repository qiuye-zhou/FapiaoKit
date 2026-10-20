import { contextBridge, ipcRenderer } from 'electron'

// 暴露安全的 API 给渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
  // 平台信息
  platform: process.platform,

  // 版本信息
  versions: {
    node: process.versions.node,
    chrome: process.versions.chrome,
    electron: process.versions.electron,
  },

  // ============ FapiaoKit 发票整理 ============
  // 选择出差文件夹
  selectFolder: (): Promise<string | null> =>
    ipcRenderer.invoke('invoice:selectFolder'),
  // 扫描并解析文件夹内所有发票 PDF
  scanFolder: (folderPath: string) =>
    ipcRenderer.invoke('invoice:scan', folderPath),
  // 执行整理：重命名 + 生成报销单
  organize: (req: unknown) => ipcRenderer.invoke('invoice:organize', req),
  // 在资源管理器中打开文件夹
  openFolder: (p: string) => ipcRenderer.invoke('shell:openFolder', p),

  // 窗口控制
  minimize: (): Promise<void> => ipcRenderer.invoke('window:minimize'),
  maximize: (): Promise<void> => ipcRenderer.invoke('window:maximize'),
  close: (): Promise<void> => ipcRenderer.invoke('window:close'),
})

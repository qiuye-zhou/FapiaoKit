import {
  app,
  BrowserWindow,
  Menu,
  shell,
  ipcMain,
  dialog,
  protocol,
  MenuItemConstructorOptions,
} from 'electron'
import * as path from 'path'
import * as fs from 'fs'
import { scanAndParse } from './lib/invoiceService'
import { organize } from './lib/organizeService'
import { OrganizeRequest } from './lib/types'
import { BUILD_TIME } from './lib/buildInfo'

// 自定义资源协议（渲染进程加载 pdfjs cMap/字体用），必须在 app ready 前注册
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app-res',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
    },
  },
])

// 开发环境判断
const isDev = process.env.NODE_ENV === 'development'

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  // 创建浏览器窗口
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
    icon: path.join(__dirname, '../static/logo.png'), // 应用图标
    show: false, // 先不显示，等加载完成后再显示
    titleBarStyle: 'default',
  })

  // 加载应用
  if (isDev) {
    // 开发环境：加载 Vite 开发服务器
    // 等待 Vite 服务器启动，然后加载页面
    const loadDevServer = (): void => {
      const devServerUrl = 'http://localhost:5173'
      mainWindow!.loadURL(devServerUrl).catch((err) => {
        console.error('无法连接到开发服务器:', err)
        // 如果开发服务器不可用，显示错误页面
        mainWindow!.loadURL(
          'data:text/html,<meta charset="utf-8"><h1>开发服务器未启动</h1><p>请先运行 npm run dev</p>',
        )
      })
    }

    // 延迟加载，确保 Vite 服务器已启动
    setTimeout(loadDevServer, 1000)

    // 开发环境下打开开发者工具
    mainWindow.webContents.openDevTools()
  } else {
    // 生产环境：加载构建后的文件
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'))
  }

  // 窗口准备好后显示
  mainWindow.once('ready-to-show', () => {
    mainWindow!.show()
  })

  // 当窗口被关闭时
  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 处理外部链接
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
}

// 当 Electron 完成初始化并准备创建浏览器窗口时调用此方法
app.whenReady().then(() => {
  // app-res://cmaps/* → node_modules/pdfjs-dist/cmaps/*
  // app-res://fonts/* → node_modules/pdfjs-dist/standard_fonts/*
  const pdfjsDir = path.dirname(require.resolve('pdfjs-dist/package.json'))
  protocol.handle('app-res', (req) => {
    try {
      const url = new URL(req.url)
      const rest = decodeURIComponent(url.pathname).replace(/^\/+/, '')
      const base =
        url.host === 'cmaps'
          ? path.join(pdfjsDir, 'cmaps')
          : url.host === 'fonts'
            ? path.join(pdfjsDir, 'standard_fonts')
            : null
      if (!base) return new Response('not found', { status: 404 })
      const file = path.join(base, rest)
      if (!file.startsWith(base) || !fs.existsSync(file)) {
        return new Response('not found', { status: 404 })
      }
      return new Response(fs.readFileSync(file), {
        headers: { 'Access-Control-Allow-Origin': '*' },
      })
    } catch {
      return new Response('error', { status: 500 })
    }
  })

  createWindow()

  // 在 macOS 上，当单击 dock 图标并且没有其他窗口打开时，
  // 通常在应用程序中重新创建窗口
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })

  // 创建应用菜单
  createMenu()
})

// 当所有窗口都被关闭时退出应用
app.on('window-all-closed', () => {
  // 在 macOS 上，除非用户用 Cmd + Q 确定地退出，
  // 否则绝大部分应用及其菜单栏会保持激活
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// 关于对话框
function showAbout(): void {
  const options = {
    type: 'info' as const,
    title: `关于 ${app.name}`,
    message: `${app.name} v${app.getVersion()}`,
    detail:
      '差旅发票整理工具\n自动解析 PDF 发票、批量重命名并生成 Excel 报销单\n\n' +
      `构建时间：${BUILD_TIME}`,
    buttons: ['确定'],
  }
  if (mainWindow) {
    dialog.showMessageBox(mainWindow, options)
  } else {
    dialog.showMessageBox(options)
  }
}

// 创建应用菜单
function createMenu(): void {
  const isMac = process.platform === 'darwin'

  // 视图菜单：开发环境才需要刷新与开发者工具
  const viewSubmenu: MenuItemConstructorOptions[] = []
  if (isDev) {
    viewSubmenu.push(
      { label: '重新加载', accelerator: 'CmdOrCtrl+R', role: 'reload' },
      {
        label: '强制重新加载',
        accelerator: 'CmdOrCtrl+Shift+R',
        role: 'forceReload',
      },
      {
        label: '切换开发者工具',
        accelerator: isMac ? 'Alt+Cmd+I' : 'Ctrl+Shift+I',
        role: 'toggleDevTools',
      },
      { type: 'separator' },
    )
  }
  viewSubmenu.push(
    { label: '实际大小', accelerator: 'CmdOrCtrl+0', role: 'resetZoom' },
    { label: '放大', accelerator: 'CmdOrCtrl+Plus', role: 'zoomIn' },
    { label: '缩小', accelerator: 'CmdOrCtrl+-', role: 'zoomOut' },
    { type: 'separator' },
    {
      label: '切换全屏',
      accelerator: isMac ? 'Ctrl+Cmd+F' : 'F11',
      role: 'togglefullscreen',
    },
  )

  const template: MenuItemConstructorOptions[] = [
    // macOS 应用菜单
    ...(isMac
      ? [
          {
            label: app.name,
            submenu: [
              { label: `关于 ${app.name}`, click: showAbout },
              { type: 'separator' },
              { label: '隐藏', role: 'hide' },
              { label: '隐藏其他', role: 'hideOthers' },
              { label: '显示全部', role: 'unhide' },
              { type: 'separator' },
              { label: '退出', role: 'quit' },
            ],
          } as MenuItemConstructorOptions,
        ]
      : []),
    // 非 macOS 保留文件菜单用于退出
    ...(isMac
      ? []
      : [
          {
            label: '文件',
            submenu: [
              {
                label: '退出',
                accelerator: 'Ctrl+Q',
                click: () => app.quit(),
              },
            ],
          } as MenuItemConstructorOptions,
        ]),
    {
      label: '编辑',
      submenu: [
        { label: '撤销', accelerator: 'CmdOrCtrl+Z', role: 'undo' },
        {
          label: '重做',
          accelerator: isMac ? 'Shift+Cmd+Z' : 'Ctrl+Y',
          role: 'redo',
        },
        { type: 'separator' },
        { label: '剪切', accelerator: 'CmdOrCtrl+X', role: 'cut' },
        { label: '复制', accelerator: 'CmdOrCtrl+C', role: 'copy' },
        { label: '粘贴', accelerator: 'CmdOrCtrl+V', role: 'paste' },
        { label: '全选', accelerator: 'CmdOrCtrl+A', role: 'selectAll' },
      ],
    },
    { label: '视图', submenu: viewSubmenu },
    {
      label: '窗口',
      submenu: [
        { label: '最小化', accelerator: 'CmdOrCtrl+M', role: 'minimize' },
        { label: '关闭', accelerator: 'CmdOrCtrl+W', role: 'close' },
      ],
    },
    {
      label: '帮助',
      submenu: [
        {
          label: `关于 ${app.name}`,
          click: showAbout,
        },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// IPC 处理器
ipcMain.handle('window:minimize', (): void => {
  if (mainWindow) {
    mainWindow.minimize()
  }
})

ipcMain.handle('window:maximize', (): void => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize()
    } else {
      mainWindow.maximize()
    }
  }
})

ipcMain.handle('window:close', (): void => {
  if (mainWindow) {
    mainWindow.close()
  }
})

ipcMain.handle('dialog:openFile', async (): Promise<string | null> => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    properties: ['openFile'],
    filters: [
      { name: '所有文件', extensions: ['*'] },
      { name: '文本文件', extensions: ['txt', 'md'] },
      { name: '图片文件', extensions: ['jpg', 'png', 'gif'] },
    ],
  })

  if (!result.canceled && result.filePaths.length > 0) {
    return result.filePaths[0]
  }
  return null
})

ipcMain.handle(
  'dialog:saveFile',
  async (event, content: string): Promise<string | null> => {
    const result = await dialog.showSaveDialog(mainWindow!, {
      filters: [
        { name: '文本文件', extensions: ['txt'] },
        { name: 'Markdown 文件', extensions: ['md'] },
        { name: '所有文件', extensions: ['*'] },
      ],
    })

    if (!result.canceled && result.filePath) {
      try {
        fs.writeFileSync(result.filePath, content, 'utf8')
        return result.filePath
      } catch (error) {
        const err = new Error(`保存文件失败: ${(error as Error).message}`)
        ;(err as Error & { cause?: unknown }).cause = error
        throw err
      }
    }
    return null
  },
)

ipcMain.handle('send-message', (event, message: string): string => {
  console.log('收到渲染进程消息:', message)
  // 可以在这里处理消息并发送回渲染进程
  mainWindow!.webContents.send('main-message', `主进程收到: ${message}`)
  return `已收到消息: ${message}`
})

// 安全设置：防止新窗口创建
app.on('web-contents-created', (event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })
})

// ================= FapiaoKit 发票整理 IPC =================

ipcMain.handle('invoice:selectFolder', async (): Promise<string | null> => {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: '选择出差发票文件夹',
    properties: ['openDirectory'],
  })
  return result.canceled ? null : result.filePaths[0]
})

ipcMain.handle('invoice:scan', async (_event, folderPath: string) => {
  return scanAndParse(folderPath)
})

ipcMain.handle('invoice:organize', async (_event, req: OrganizeRequest) => {
  return organize(req)
})

ipcMain.handle('shell:openFolder', async (_event, p: string) => {
  await shell.openPath(p)
})

// 读取 PDF 字节流，供渲染进程 pdfjs 预览
ipcMain.handle('invoice:readPdf', async (_event, filePath: string) => {
  const data = fs.readFileSync(filePath)
  return new Uint8Array(data)
})

// 构建前生成 electron/lib/buildInfo.ts，把本次编译时间写入「关于」对话框
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const pad = (n) => String(n).padStart(2, '0')

const now = new Date()
const buildTime =
  `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
  `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`

const target = path.join(__dirname, '..', 'electron', 'lib', 'buildInfo.ts')
const content = `// 此文件由 scripts/gen-build-info.mjs 自动生成，请勿手动修改
export const BUILD_TIME = '${buildTime}'
`

fs.writeFileSync(target, content, 'utf8')
console.log(`buildInfo.ts 已生成：${buildTime}`)

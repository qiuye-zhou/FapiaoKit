// 主题管理：light / dark / system，localStorage 持久化
// 模块级单例，任意组件 useTheme() 共享同一状态
import { ref, watch } from 'vue'

export type ThemeMode = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'fapiaokit-theme'

function readMode(): ThemeMode {
  const v = localStorage.getItem(STORAGE_KEY)
  return v === 'light' || v === 'dark' ? v : 'system'
}

const mode = ref<ThemeMode>(readMode())
const media = window.matchMedia('(prefers-color-scheme: dark)')

function apply(): void {
  const dark =
    mode.value === 'dark' || (mode.value === 'system' && media.matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  // 同步原生窗口（标题栏、菜单栏）配色；纯浏览器开发时无 electronAPI
  window.electronAPI?.setThemeMode?.(mode.value)
}

media.addEventListener('change', apply)
watch(mode, (m) => {
  localStorage.setItem(STORAGE_KEY, m)
  apply()
})
apply()

export function useTheme(): {
  mode: typeof mode
  setMode: (m: ThemeMode) => void
} {
  return {
    mode,
    setMode: (m) => {
      mode.value = m
    },
  }
}

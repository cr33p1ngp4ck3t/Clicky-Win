import { resolve } from 'path'
import { defineConfig } from 'electron-vite'
import react from '@vitejs/plugin-react'

// Two renderer entries: the menu-bar dropdown ("panel") and the full-screen
// click-through overlay ("overlay"). They share React + the design system but
// live in separate BrowserWindows so their lifecycles are independent.
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [react()],
    build: {
      rollupOptions: {
        input: {
          panel: resolve('src/renderer/panel.html'),
          overlay: resolve('src/renderer/overlay.html'),
          'status-bar': resolve('src/renderer/status-bar.html')
        }
      }
    }
  }
})

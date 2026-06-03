/// <reference types="vite/client" />

import { ElectronAPI } from '@electron-toolkit/preload'
import type { ClickyAPI } from '../../preload/index'

declare global {
  interface Window {
    electron: ElectronAPI
    clicky: ClickyAPI
  }
}

import { ElectronAPI } from '@electron-toolkit/preload'
import type { ClickyAPI } from './index'

declare global {
  interface Window {
    electron: ElectronAPI
    clicky: ClickyAPI
  }
}

import { BrowserWindow } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

/**
 * The dropdown panel shown when the user clicks the tray icon.
 * Borderless, non-activating-friendly, transparent (so we can render a
 * rounded-corner card via CSS). Lives in the bottom-right near the tray.
 */
export function createPanelWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 360,
    height: 480,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Keep the panel on top of "normal" windows but below the screen-saver
  // tier — we don't want it visible during full-screen apps.
  win.setAlwaysOnTop(true, 'floating')

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/panel.html`)
  } else {
    win.loadFile(join(__dirname, '../renderer/panel.html'))
  }

  return win
}

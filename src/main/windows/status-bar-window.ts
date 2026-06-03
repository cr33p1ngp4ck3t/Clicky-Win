import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

/**
 * A tiny always-on-top status bar that sits at the top-center of the primary
 * display — the Windows equivalent of the macOS menu bar status text.
 *
 * Shows "Speaking", "Always on", "Listening", etc. as a small floating pill.
 * Click-through, non-focusable, and transparent so it blends over any app.
 */
export function createStatusBarWindow(): BrowserWindow {
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width: screenWidth } = primaryDisplay.workArea

  // The window is a fixed transparent container. The pill inside renders at
  // its own dynamic size via CSS. We make the container large enough for the
  // widest pill state (responding = 260px) plus padding.
  const barWidth = 300
  const barHeight = 64
  const barX = Math.round(screenWidth / 2 - barWidth / 2)
  const barY = 0

  const win = new BrowserWindow({
    x: barX,
    y: barY,
    width: barWidth,
    height: barHeight,
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    minimizable: false,
    maximizable: false,
    hasShadow: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  // Click-through so it doesn't interfere with the user's work
  win.setIgnoreMouseEvents(true, { forward: false })

  // Above everything, including full-screen apps
  win.setAlwaysOnTop(true)
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/status-bar.html`)
  } else {
    win.loadFile(join(__dirname, '../renderer/status-bar.html'))
  }

  // Show once ready — starts hidden until state changes make it visible
  win.once('ready-to-show', () => {
    win.showInactive()
  })

  // Re-center if display configuration changes
  screen.on('display-metrics-changed', () => {
    repositionStatusBar(win)
  })

  return win
}

function repositionStatusBar(win: BrowserWindow): void {
  const primaryDisplay = screen.getPrimaryDisplay()
  const { width: screenWidth } = primaryDisplay.workArea
  const barWidth = 300
  const barX = Math.round(screenWidth / 2 - barWidth / 2)
  win.setPosition(barX, 0, false)
}

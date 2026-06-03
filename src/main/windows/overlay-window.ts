import { BrowserWindow, screen } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'

/**
 * The full-screen click-through overlay. This is where the blue cursor lives
 * and where pointing animations play out. Spans the entire virtual screen
 * (union of all monitors) so we don't have to coordinate per-monitor windows.
 *
 * Electron flags map to Win32 like this:
 *   transparent: true        → WS_EX_LAYERED (per-pixel alpha)
 *   frame: false             → no chrome
 *   focusable: false         → WS_EX_NOACTIVATE (doesn't steal focus)
 *   alwaysOnTop: true        → WS_EX_TOPMOST
 *   skipTaskbar: true        → WS_EX_TOOLWINDOW (no taskbar button)
 *   setIgnoreMouseEvents(true, { forward: true })
 *                            → WS_EX_TRANSPARENT (clicks pass through to apps below)
 */
export function createOverlayWindow(): BrowserWindow {
  const virtualScreen = computeVirtualScreenBounds()

  const win = new BrowserWindow({
    x: virtualScreen.x,
    y: virtualScreen.y,
    width: virtualScreen.width,
    height: virtualScreen.height,
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
    // Performance: don't run the renderer's compositor at full FPS when the
    // overlay is idle. We bump back to 60fps during animations.
    backgroundColor: '#00000000',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      // Required for the renderer to use offscreen canvases for screen frames.
      offscreen: false
    }
  })

  // Click-through: events pass to whatever's underneath. `forward: true`
  // means the renderer can still receive `mousemove` events for hover-only
  // effects (used by the cursor's idle animation in the original Mac app).
  win.setIgnoreMouseEvents(true, { forward: true })

  // Above floating panels (which use 'floating'), above full-screen apps.
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}/overlay.html`)
  } else {
    win.loadFile(join(__dirname, '../renderer/overlay.html'))
  }

  // Show the overlay once the renderer has loaded. The overlay is always-on —
  // it stays visible while the user works and waits for pointing instructions.
  // showInactive() avoids stealing focus from the user's current app.
  win.once('ready-to-show', () => {
    win.showInactive()
  })

  // Re-position to match the virtual screen if the display configuration
  // changes (monitor added/removed/resolution change). Without this, plugging
  // in a new monitor leaves blue cursor inaccessible on that screen.
  screen.on('display-added', () => resizeToVirtualScreen(win))
  screen.on('display-removed', () => resizeToVirtualScreen(win))
  screen.on('display-metrics-changed', () => resizeToVirtualScreen(win))

  return win
}

function computeVirtualScreenBounds(): { x: number; y: number; width: number; height: number } {
  const displays = screen.getAllDisplays()
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity
  for (const d of displays) {
    minX = Math.min(minX, d.bounds.x)
    minY = Math.min(minY, d.bounds.y)
    maxX = Math.max(maxX, d.bounds.x + d.bounds.width)
    maxY = Math.max(maxY, d.bounds.y + d.bounds.height)
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

function resizeToVirtualScreen(win: BrowserWindow): void {
  const v = computeVirtualScreenBounds()
  win.setBounds(v)
}

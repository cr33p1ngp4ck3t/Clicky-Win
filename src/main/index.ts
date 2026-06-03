/**
 * Main process entry. Clicky lives in the system tray — no main window, no
 * taskbar icon. Three BrowserWindows exist on demand:
 *   1. `panel`     — the dropdown shown when the user clicks the tray icon.
 *   2. `overlay`   — the full-screen transparent click-through overlay.
 *   3. `statusBar` — the floating status pill at the top of the screen.
 */

import { app, BrowserWindow } from 'electron'
import { electronApp } from '@electron-toolkit/utils'
import { createTray } from './tray'
import { createPanelWindow } from './windows/panel-window'
import { createOverlayWindow } from './windows/overlay-window'
import { createStatusBarWindow } from './windows/status-bar-window'
import { registerIpcHandlers } from './ipc-handlers'

// Single-instance lock — Clicky is a tray app, you only ever want one.
// If a second copy launches, it just exits.
const gotTheLock = app.requestSingleInstanceLock()
if (!gotTheLock) {
  app.quit()
}

// Tray apps don't have any taskbar button — when the user opens / closes the
// dropdown, Electron's default "quit when no windows" behavior would kill us.
// On Windows the default is to quit; we override that by registering a
// no-op handler so the process keeps running until the user explicitly quits.
app.on('window-all-closed', () => {
  // Intentionally empty — tray-only app stays alive.
})

app.on('will-quit', () => {
  import('./shortcut-monitor').then(({ stopGlobalShortcutMonitor }) => {
    stopGlobalShortcutMonitor()
  })
})

app.whenReady().then(async () => {
  // Required on Windows so the OS associates notifications and pinning with
  // our app. Use a reverse-DNS-like identifier.
  electronApp.setAppUserModelId('com.clicky.windows')

  // Disable the default app menu — we don't have one, this is a tray app.
  // (Otherwise on Alt-press Electron flashes the system menu bar in some
  // window configurations.)
  const { Menu } = await import('electron')
  Menu.setApplicationMenu(null)

  // Build the three windows up-front (hidden until shown). Creating them on
  // demand causes a visible delay on first hotkey press.
  const panelWindow = createPanelWindow()
  const overlayWindow = createOverlayWindow()
  const statusBarWindow = createStatusBarWindow()

  // Register all IPC handlers (ping, debug-ask, …) up-front so the renderer
  // can call any of them as soon as it mounts.
  const companion = registerIpcHandlers({ panelWindow, overlayWindow, statusBarWindow })

  // Tray owns the panel — clicking the tray icon toggles its visibility.
  // The companion is passed so the tooltip shows live status (Speaking, Always on, etc.)
  createTray({ panelWindow, overlayWindow, companion })

  // Re-create windows if they were closed for any reason. Tray apps stay
  // alive until the user explicitly quits.
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createPanelWindow()
      createOverlayWindow()
      createStatusBarWindow()
    }
  })
})

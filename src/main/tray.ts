import { Tray, Menu, BrowserWindow, app, nativeImage, screen } from 'electron'
import icon from '../../resources/icon.png?asset'
import type { Companion } from '../services/companion'
import type { VoiceState, ListeningMode } from '../shared/types'

interface TrayOptions {
  panelWindow: BrowserWindow
  overlayWindow: BrowserWindow
  companion: Companion
}

/**
 * Creates the system-tray icon. Left-click toggles the dropdown panel;
 * right-click shows a context menu with "Quit". The tray icon is the only
 * persistent visible UI Clicky has — everything else (panel, overlay) is
 * shown on demand.
 *
 * The tray tooltip dynamically updates to show the current voice state
 * (Windows equivalent of the macOS menu bar status text).
 */
export function createTray({ panelWindow, overlayWindow, companion }: TrayOptions): Tray {
  // electron-vite's ?asset suffix produces a path string usable in the main
  // process at runtime, both in dev and in the packaged build.
  const trayIcon = nativeImage.createFromPath(icon)
  // On Windows, 16x16 is the conventional tray size at 100% scale.
  const tray = new Tray(trayIcon.resize({ width: 16, height: 16 }))

  tray.setToolTip('Clicky — Ready')

  tray.on('click', () => {
    if (panelWindow.isVisible()) {
      panelWindow.hide()
    } else {
      positionPanelNearTray(panelWindow, tray)
      panelWindow.show()
      panelWindow.focus()
    }
  })

  // Auto-hide the panel when it loses focus (clicking outside).
  panelWindow.on('blur', () => {
    panelWindow.hide()
  })

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'Show panel',
      click: (): void => {
        positionPanelNearTray(panelWindow, tray)
        panelWindow.show()
        panelWindow.focus()
      }
    },
    { type: 'separator' },
    {
      label: 'Toggle overlay (debug)',
      click: (): void => {
        if (overlayWindow.isVisible()) overlayWindow.hide()
        else overlayWindow.show()
      }
    },
    { type: 'separator' },
    {
      label: 'Quit Clicky',
      click: (): void => {
        app.exit(0)
      }
    }
  ])
  tray.setContextMenu(contextMenu)

  // ── Dynamic tray tooltip (Windows equivalent of macOS menu bar status) ──
  // Poll the companion state every 500ms and update the tray tooltip to show
  // the current voice state — this is what the user sees when hovering over
  // the tray icon, matching the macOS "Speaking" / "Always on" behavior.
  setInterval(() => {
    const voiceState = companion.getState()
    const listeningMode = companion.getListeningMode()
    const tooltipText = buildTrayTooltip(voiceState, listeningMode)
    tray.setToolTip(tooltipText)
  }, 500)

  return tray
}

/**
 * Build the tooltip string based on current state.
 * Mirrors the macOS menu bar status labels.
 */
function buildTrayTooltip(voiceState: VoiceState, listeningMode: ListeningMode): string {
  if (listeningMode === 'automatic' && voiceState === 'listening') {
    return 'Clicky — Always on'
  }

  switch (voiceState) {
    case 'idle':
      return 'Clicky — Ready'
    case 'listening':
      return 'Clicky — Listening'
    case 'processing':
      return 'Clicky — Processing'
    case 'command':
      return 'Clicky — Running Command'
    case 'responding':
      return 'Clicky — Speaking'
  }
}

/**
 * Position the panel just above the tray icon so it feels attached.
 * `tray.getBounds()` returns the icon's screen rect; we anchor the
 * panel's bottom-center to the icon's top-center (Windows convention,
 * since the tray sits in the bottom-right of the primary display).
 */
function positionPanelNearTray(panelWindow: BrowserWindow, tray: Tray): void {
  const trayBounds = tray.getBounds()
  const panelBounds = panelWindow.getBounds()

  // Center horizontally on the tray icon, then nudge so we don't go
  // off the edge of the work area.
  let x = Math.round(trayBounds.x + trayBounds.width / 2 - panelBounds.width / 2)
  let y = Math.round(trayBounds.y - panelBounds.height - 4)

  // Clamp to the display containing the tray icon.
  const display = screen.getDisplayNearestPoint({ x: trayBounds.x, y: trayBounds.y })
  const workArea = display.workArea
  x = Math.max(workArea.x + 4, Math.min(x, workArea.x + workArea.width - panelBounds.width - 4))
  y = Math.max(workArea.y + 4, y)

  panelWindow.setPosition(x, y, false)
}

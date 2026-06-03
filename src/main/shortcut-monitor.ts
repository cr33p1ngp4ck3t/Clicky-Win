import { uIOhook, UiohookKey } from 'uiohook-napi'
import type { Companion } from '../services/companion'

/**
 * Global Push-to-Talk Shortcut Monitor.
 *
 * Uses `uiohook-napi` to intercept raw OS keyboard events globally. This allows us
 * to detect modifier-only shortcuts (Ctrl + Alt) even when the app is in the
 * background, and critically, we can detect both key-down AND key-up events
 * (which Electron's native `globalShortcut` module does not support).
 */

import { ListeningMode } from '../shared/types'

export function registerGlobalShortcutMonitor(
  companion: Companion,
  onModeToggle: (newMode: ListeningMode) => void
): void {
  let isCtrlDown = false
  let isAltDown = false
  let isListening = false

  // Tracking for triple-Ctrl press
  let ctrlPressTimes: number[] = []
  const TRIPLE_PRESS_THRESHOLD_MS = 600

  uIOhook.on('keydown', (e) => {
    const isCtrl = e.keycode === UiohookKey.Ctrl || e.keycode === UiohookKey.CtrlRight
    const isAlt = e.keycode === UiohookKey.Alt || e.keycode === UiohookKey.AltRight

    if (isCtrl) {
      if (!isCtrlDown) {
        // This is a fresh keydown for Ctrl
        const now = Date.now()
        ctrlPressTimes.push(now)

        // Keep only presses within the threshold
        ctrlPressTimes = ctrlPressTimes.filter((t) => now - t <= TRIPLE_PRESS_THRESHOLD_MS)

        if (ctrlPressTimes.length === 3) {
          // Triple press detected!
          ctrlPressTimes = [] // reset
          const currentMode = companion.getListeningMode()
          const newMode = currentMode === 'manual' ? 'automatic' : 'manual'
          console.log(`[shortcut] Triple Ctrl detected — switching mode to ${newMode}`)
          companion.setListeningMode(newMode)
          onModeToggle(newMode)
        }
      }
      isCtrlDown = true
    } else if (isAlt) {
      isAltDown = true
    } else {
      // If any other key is pressed, interrupt the triple-Ctrl sequence
      ctrlPressTimes = []
    }

    if (isCtrlDown && isAltDown && !isListening) {
      // Only start if we are in manual mode
      if (companion.getState() === 'idle') {
        isListening = true
        console.log('[shortcut] Ctrl+Alt pressed — starting push-to-talk')
        void companion.startListening()
      }
    }
  })

  uIOhook.on('keyup', (e) => {
    if (e.keycode === UiohookKey.Ctrl || e.keycode === UiohookKey.CtrlRight) {
      isCtrlDown = false
    }
    if (e.keycode === UiohookKey.Alt || e.keycode === UiohookKey.AltRight) {
      isAltDown = false
    }

    // If either key is released and we were listening via shortcut, stop
    if ((!isCtrlDown || !isAltDown) && isListening) {
      isListening = false
      console.log('[shortcut] Ctrl+Alt released — stopping push-to-talk')
      void companion.stopListening()
    }
  })

  // Start the native OS hook
  uIOhook.start()
  console.log('[shortcut] Global Ctrl+Alt monitor started')
}

/** Stop the hook when the app quits */
export function stopGlobalShortcutMonitor(): void {
  uIOhook.stop()
}

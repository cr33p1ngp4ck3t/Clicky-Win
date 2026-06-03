/**
 * Translate a Claude PointingResult into an overlay-space target the
 * BlueCursor renderer can fly to, and dispatch it via IPC.
 *
 * Coordinate spaces we deal with:
 *
 *   1. Capture pixels — Claude's coordinates are in the screenshot's pixel
 *      space (e.g. 1568×882). One value per `DisplayCapture`.
 *   2. Display DIP — Electron's per-monitor `Display.bounds` in
 *      device-independent pixels. The OS's "screen space".
 *   3. Virtual-screen DIP — the bounding box of all monitors. Our overlay
 *      `BrowserWindow` spans this. Position the SVG cursor here.
 *
 * Map:
 *   captureX / widthPixels  →  fraction of display width
 *   fraction × display.bounds.width  →  display-relative DIP
 *   + display.bounds.x  →  absolute DIP
 *   − virtualBounds.x  →  overlay-relative DIP
 */

import { screen, BrowserWindow } from 'electron'
import type { DisplayCapture, PointingResult } from '../shared/types'

export interface OverlayPointTarget {
  /** Virtual-screen-relative x in DIPs (= overlay window coordinate). */
  x: number
  /** Virtual-screen-relative y in DIPs. */
  y: number
  /** Short element description, used as bubble text. */
  label: string
}

/**
 * Resolve a Claude pointing decision to an overlay-space target. Returns
 * null when Claude chose `dont_point`, when the screen number didn't match
 * any captured display, or when the coordinate is missing.
 */
export function resolvePointTarget(
  pointing: PointingResult,
  screens: DisplayCapture[]
): OverlayPointTarget | null {
  if (!pointing.coordinate || pointing.screenNumber == null) return null

  // Map screen number back to the actual Display via the captured screen.
  // The screen number we send is the same one DisplayCapture.screenNumber holds.
  const targetCapture = screens.find((s) => s.screenNumber === pointing.screenNumber)
  if (!targetCapture) return null

  // Find the OS Display that matches by index — we use the same sort
  // (top-to-bottom, left-to-right) as captureAllScreens.
  const allDisplays = screen.getAllDisplays()
  const sortedDisplays = [...allDisplays].sort((a, b) => {
    if (a.bounds.y !== b.bounds.y) return a.bounds.y - b.bounds.y
    return a.bounds.x - b.bounds.x
  })
  // screenNumber is 1-based; arrays are 0-based.
  const display = sortedDisplays[targetCapture.screenNumber - 1]
  if (!display) return null

  // Pixel-space → display-DIP. Use the actual capture dimensions, not the
  // raw display × scaleFactor, because the JPEG could have been downscaled
  // (the long-edge ≤ 1568 rule in screen-capture.ts).
  const fractionX = pointing.coordinate.x / targetCapture.widthPixels
  const fractionY = pointing.coordinate.y / targetCapture.heightPixels
  const dipX = display.bounds.x + fractionX * display.bounds.width
  const dipY = display.bounds.y + fractionY * display.bounds.height

  // Display DIP → virtual-screen DIP. Same math as
  // computeVirtualScreenBounds in overlay-window.ts.
  const displays = screen.getAllDisplays()
  const minX = Math.min(...displays.map((d) => d.bounds.x))
  const minY = Math.min(...displays.map((d) => d.bounds.y))

  return {
    x: dipX - minX,
    y: dipY - minY,
    label: pointing.elementLabel ?? ''
  }
}

/**
 * Push a pointing target to the overlay renderer. The overlay listens on
 * `clicky:point-at`, animates its cursor along a bezier arc, then resets.
 *
 * Makes sure the overlay is visible — the user might have hidden it via
 * the tray menu, but a Claude pointing decision should always show it.
 */
export function sendPointTarget(
  overlayWindow: BrowserWindow,
  target: OverlayPointTarget
): void {
  if (overlayWindow.isDestroyed()) return
  if (!overlayWindow.isVisible()) overlayWindow.showInactive()
  overlayWindow.webContents.send('point-at', target)
}

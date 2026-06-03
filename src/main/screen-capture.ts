/**
 * Multi-monitor screen capture for Clicky's voice turn.
 *
 * Windows port of CompanionScreenCaptureUtility.swift. The Swift original
 * uses ScreenCaptureKit + SCContentFilter to exclude Clicky's own windows
 * from the screenshot. Electron's desktopCapturer can't filter per-window
 * the same way, so we instead hide Clicky's overlay + panel *before*
 * capturing and restore them after — same end-result, simpler code.
 *
 * The capture pipeline:
 *   1. Hide our own windows (panel + overlay).
 *   2. Enumerate displays via `screen.getAllDisplays()`.
 *   3. Pick a target capture size with the long edge ≤ MAX_LONG_EDGE_PX,
 *      preserving aspect ratio, so each image stays a tight ~50-150KB JPEG.
 *   4. Ask `desktopCapturer` for all screen sources at thumbnailSize=target.
 *      Match each source to its Display via `source.display_id`.
 *   5. Encode each NativeImage as JPEG, build the DisplayCapture record,
 *      label the cursor's screen as "primary focus".
 *   6. Sort so the cursor's screen is first.
 *   7. Restore our own windows.
 */

import { desktopCapturer, screen, BrowserWindow } from 'electron'
import type { DisplayCapture } from '../shared/types'

/**
 * Long-edge target in pixels. Bigger = Claude can find smaller UI elements
 * but each image costs more tokens. 1568 is Anthropic's recommended max for
 * vision: anything larger gets resized server-side anyway, so there's no
 * upside to going bigger.
 */
const MAX_LONG_EDGE_PX = 1568

/** JPEG quality. 0.85 is the visual no-difference threshold for screenshots. */
const JPEG_QUALITY = 85

interface CaptureOptions {
  /** Windows to hide before capture and re-show after. */
  hideDuringCapture: BrowserWindow[]
}

/**
 * Capture every connected display. Resolves to a `DisplayCapture[]` ordered
 * cursor-screen-first, ready to drop straight into ClaudeService.respond().
 */
export async function captureAllScreens(
  options: CaptureOptions = { hideDuringCapture: [] }
): Promise<DisplayCapture[]> {
  const wasVisible = new Map<BrowserWindow, boolean>()
  for (const win of options.hideDuringCapture) {
    wasVisible.set(win, win.isVisible())
    if (win.isVisible()) win.hide()
  }

  try {
    // Let the compositor actually paint without our windows. ~1 frame is
    // enough on Windows 11; without this the capture sometimes still
    // includes a translucent ghost of the panel.
    await new Promise<void>((resolve) => setTimeout(resolve, 32))

    const displays = screen.getAllDisplays()
    const cursorPoint = screen.getCursorScreenPoint()
    const cursorDisplay = screen.getDisplayNearestPoint(cursorPoint)

    // Ask desktopCapturer for the largest source so we can downscale
    // ourselves with a consistent algorithm across displays. Passing a
    // per-display size doesn't work — desktopCapturer applies one size to
    // all sources — so we pass the bounding-box max and let each display's
    // resize() shrink to its own target.
    const maxWidth = Math.max(...displays.map((d) => d.size.width * d.scaleFactor))
    const maxHeight = Math.max(...displays.map((d) => d.size.height * d.scaleFactor))

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: maxWidth, height: maxHeight },
      // We don't need icons or audio; skip them to keep capture fast.
      fetchWindowIcons: false
    })

    const captures: DisplayCapture[] = []

    for (const display of displays) {
      // `display_id` is a string of the numeric display id. `screen` returns
      // Display.id as a number, so coerce on the way through.
      const source = sources.find((s) => s.display_id === String(display.id))
      if (!source) {
        // Headless / disconnected display races — skip rather than fail.
        continue
      }

      const isPrimary = display.id === cursorDisplay.id
      const screenNumber = displayIndex(displays, display) + 1

      // Compute the actual capture dimensions (longest edge ≤ MAX_LONG_EDGE_PX).
      const targetSize = fitWithin(
        display.size.width * display.scaleFactor,
        display.size.height * display.scaleFactor,
        MAX_LONG_EDGE_PX
      )

      const resized = source.thumbnail.resize({
        width: targetSize.width,
        height: targetSize.height,
        quality: 'good'
      })

      const jpegBuffer = resized.toJPEG(JPEG_QUALITY)

      captures.push({
        imageData: new Uint8Array(jpegBuffer.buffer, jpegBuffer.byteOffset, jpegBuffer.byteLength),
        mediaType: 'image/jpeg',
        label: buildLabel({
          screenNumber,
          totalScreens: displays.length,
          isPrimary,
          widthPixels: targetSize.width,
          heightPixels: targetSize.height
        }),
        widthPixels: targetSize.width,
        heightPixels: targetSize.height,
        isPrimary,
        screenNumber
      })
    }

    // Cursor screen first, then by screen number. Matches what
    // claude.ts#buildUserContent does internally, but doing it here too
    // makes the order stable for callers that don't go through Claude.
    captures.sort((a, b) => {
      if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1
      return a.screenNumber - b.screenNumber
    })

    if (captures.length === 0) {
      throw new Error('No displays were captured')
    }

    return captures
  } finally {
    // Restore visibility regardless of success — never leave the user with
    // a hidden panel because we threw mid-capture.
    for (const [win, wasShown] of wasVisible) {
      if (wasShown && !win.isDestroyed()) win.showInactive()
    }
  }
}

/**
 * Stable "which screen is this" index. We can't use Display.id directly —
 * those are opaque OS-assigned numbers, not 1..N — so we sort by position
 * (top-to-bottom, left-to-right) and use the resulting index. Stable across
 * captures as long as no display is hot-plugged mid-turn.
 */
function displayIndex(allDisplays: Electron.Display[], target: Electron.Display): number {
  const sorted = [...allDisplays].sort((a, b) => {
    if (a.bounds.y !== b.bounds.y) return a.bounds.y - b.bounds.y
    return a.bounds.x - b.bounds.x
  })
  return sorted.findIndex((d) => d.id === target.id)
}

/**
 * Constrain `(w,h)` so the long edge is at most `maxLongEdge`, preserving
 * aspect ratio. Result dimensions are integers (some image backends choke
 * on fractional sizes).
 */
function fitWithin(
  width: number,
  height: number,
  maxLongEdge: number
): { width: number; height: number } {
  if (width <= maxLongEdge && height <= maxLongEdge) {
    return { width: Math.round(width), height: Math.round(height) }
  }
  if (width >= height) {
    const scale = maxLongEdge / width
    return { width: maxLongEdge, height: Math.round(height * scale) }
  }
  const scale = maxLongEdge / height
  return { width: Math.round(width * scale), height: maxLongEdge }
}

interface LabelParams {
  screenNumber: number
  totalScreens: number
  isPrimary: boolean
  widthPixels: number
  heightPixels: number
}

/**
 * Format the label the model sees right after each screenshot. Same
 * structure as CompanionScreenCaptureUtility but with the pixel dimensions
 * appended so Claude knows the coordinate space it should produce points in.
 *
 *   single display    → "user's screen (cursor is here, 1568×882 pixels)"
 *   cursor screen     → "screen 1 of 2 — cursor is on this screen (primary focus, 1568×882 pixels)"
 *   secondary screen  → "screen 2 of 2 — secondary screen (1568×882 pixels)"
 */
function buildLabel(p: LabelParams): string {
  const dims = `${p.widthPixels}×${p.heightPixels} pixels`
  if (p.totalScreens === 1) {
    return `user's screen (cursor is here, ${dims})`
  }
  if (p.isPrimary) {
    return `screen ${p.screenNumber} of ${p.totalScreens} — cursor is on this screen (primary focus, ${dims})`
  }
  return `screen ${p.screenNumber} of ${p.totalScreens} — secondary screen (${dims})`
}

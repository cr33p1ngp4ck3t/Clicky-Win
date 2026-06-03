import { useEffect, useRef, useState } from 'react'
import type { PointAtTarget } from '../../../preload/index'
import type { VoiceState, CompanionEvent } from '../../../shared/types'

/**
 * The full-screen click-through overlay.
 *
 * Features:
 *   1. **Cursor following** (idle): Blue triangle lazily tracks the mouse.
 *   2. **Waveform bars** (listening): 5 animated bars replace the triangle.
 *   3. **Spinner** (processing): Spinning arc replaces the triangle.
 *   4. **Triangle** (responding/idle): Standard blue cursor.
 *   5. **Pointing flight**: Triangle flies along a bezier arc to targets.
 *
 * Ported from BlueCursorView / BlueCursorWaveformView / BlueCursorSpinnerView
 * in OverlayWindow.swift.
 */

interface CursorState {
  x: number
  y: number
  rotation: number
  scale: number
  opacity: number
}

const IDLE_ROTATION_DEGREES = -35
const TRIANGLE_SIZE_PX = 16
const POINT_HOLD_MS = 3000
const POINT_FADEOUT_MS = 500

/**
 * Offset from the actual system cursor to the blue companion.
 * Matches macOS: +35 right, +25 down from real cursor.
 */
const CURSOR_OFFSET_X = 35
const CURSOR_OFFSET_Y = 25

/** How quickly the cursor catches up to the mouse. */
const FOLLOW_LERP = 0.12

export function Overlay(): React.JSX.Element {
  const [cursor, setCursor] = useState<CursorState>({
    x: 0,
    y: 0,
    rotation: IDLE_ROTATION_DEGREES,
    scale: 1,
    opacity: 0
  })
  const [voiceState, setVoiceState] = useState<VoiceState>('idle')
  const [bubble, setBubble] = useState<{
    text: string
    x: number
    y: number
    opacity: number
    scale: number
  } | null>(null)

  const cursorRef = useRef(cursor)
  cursorRef.current = cursor

  const mouseTargetRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const isFollowingRef = useRef(true)
  const hasReceivedMouseRef = useRef(false)
  const flightTokenRef = useRef(0)

  // ── Subscribe to voice state for visual switching ─────────────────

  useEffect(() => {
    const unsub = window.clicky.onCompanionEvent((event: CompanionEvent) => {
      if (event.type === 'voice-state') {
        setVoiceState(event.state)
      }
    })
    return unsub
  }, [])

  // ── Mouse following ──────────────────────────────────────────────

  useEffect(() => {
    const unsub = window.clicky.onMousePosition((pos) => {
      mouseTargetRef.current = {
        x: pos.x + CURSOR_OFFSET_X,
        y: pos.y + CURSOR_OFFSET_Y
      }
      if (!hasReceivedMouseRef.current) {
        hasReceivedMouseRef.current = true
        setCursor((c) => ({
          ...c,
          x: pos.x + CURSOR_OFFSET_X,
          y: pos.y + CURSOR_OFFSET_Y,
          opacity: 1
        }))
      }
    })
    return unsub
  }, [])

  // Lazy follow animation loop
  useEffect(() => {
    let raf: number

    function followFrame(): void {
      if (isFollowingRef.current && hasReceivedMouseRef.current) {
        const current = cursorRef.current
        const target = mouseTargetRef.current

        const dx = target.x - current.x
        const dy = target.y - current.y
        const dist = Math.hypot(dx, dy)

        if (dist > 1) {
          const newX = current.x + dx * FOLLOW_LERP
          const newY = current.y + dy * FOLLOW_LERP

          const angle = Math.atan2(dy, dx) * (180 / Math.PI) + 90
          const targetRotation =
            dist > 20 ? angle : IDLE_ROTATION_DEGREES
          const newRotation =
            current.rotation + (targetRotation - current.rotation) * 0.05

          setCursor({
            x: newX,
            y: newY,
            rotation: newRotation,
            scale: 1,
            opacity: 1
          })
        }
      }
      raf = requestAnimationFrame(followFrame)
    }

    raf = requestAnimationFrame(followFrame)
    return () => cancelAnimationFrame(raf)
  }, [])

  // ── Pointing flights ──────────────────────────────────────────────

  useEffect(() => {
    return window.clicky.onPointAt((target) => {
      isFollowingRef.current = false
      flightTokenRef.current += 1
      const token = flightTokenRef.current
      runPointFlight({
        target,
        token,
        getActiveToken: () => flightTokenRef.current,
        startState: cursorRef.current,
        setCursor,
        setBubble,
        onFlightComplete: () => {
          setTimeout(() => {
            isFollowingRef.current = true
          }, POINT_HOLD_MS + POINT_FADEOUT_MS + 200)
        }
      })
    })
  }, [])

  return (
    <div className="overlay-root">
      {/* State-dependent cursor visual */}
      <div
        className="overlay-cursor-container"
        style={{
          transform: `translate(${cursor.x - 10}px, ${cursor.y - 10}px)`,
          opacity: cursor.opacity
        }}
      >
        {/* Triangle — visible during idle and responding */}
        <div
          className="overlay-visual-layer"
          style={{ opacity: voiceState === 'idle' || voiceState === 'responding' ? 1 : 0 }}
        >
          <BlueTriangle state={cursor} />
        </div>

        {/* Waveform — visible during listening */}
        <div
          className="overlay-visual-layer"
          style={{ opacity: voiceState === 'listening' ? 1 : 0 }}
        >
          <OverlayWaveform />
        </div>

        {/* Spinner — visible during processing and command */}
        <div
          className="overlay-visual-layer"
          style={{ opacity: voiceState === 'processing' || voiceState === 'command' ? 1 : 0 }}
        >
          <OverlaySpinner />
        </div>
      </div>

      {bubble && (
        <div
          className="overlay-bubble"
          style={{
            transform: `translate(${bubble.x + 10}px, ${bubble.y + 18}px) scale(${bubble.scale})`,
            opacity: bubble.opacity
          }}
        >
          {bubble.text}
        </div>
      )}
    </div>
  )
}

/**
 * The blue triangle cursor — SVG with glow filter.
 * Visible during idle and responding states.
 */
function BlueTriangle({ state }: { state: CursorState }): React.JSX.Element {
  const size = TRIANGLE_SIZE_PX
  const half = size / 2
  const h = (size * Math.sqrt(3)) / 2
  const cx = half
  const cy = half
  const path = `M ${cx} ${cy - h / 1.5} L ${cx - half} ${cy + h / 3} L ${cx + half} ${cy + h / 3} Z`

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      style={{
        transform: `rotate(${state.rotation}deg) scale(${state.scale})`,
        filter: `drop-shadow(0 0 ${8 + (state.scale - 1) * 20}px #3380ff)`
      }}
    >
      <path d={path} fill="#3380ff" />
    </svg>
  )
}

/**
 * 5-bar audio-reactive waveform for the listening state.
 * Matches macOS BlueCursorWaveformView: 2px wide, 2px spacing,
 * bar profiles [0.4, 0.7, 1.0, 0.7, 0.4].
 */
const OVERLAY_BAR_PROFILES = [0.4, 0.7, 1.0, 0.7, 0.4]

function OverlayWaveform(): React.JSX.Element {
  const [barHeights, setBarHeights] = useState([3, 3, 3, 3, 3])
  const audioLevelRef = useRef(0)
  const startTimeRef = useRef(performance.now())

  useEffect(() => {
    const unsub = window.clicky.onAudioLevel?.((level: number) => {
      audioLevelRef.current = level
    })
    return unsub
  }, [])

  useEffect(() => {
    let raf: number

    function frame(): void {
      const raw = audioLevelRef.current
      const eased = Math.pow(Math.min(raw * 15, 1), 0.6)
      const elapsed = (performance.now() - startTimeRef.current) / 1000

      const heights = OVERLAY_BAR_PROFILES.map((profile, i) => {
        const reactive = eased * 12 * profile
        const phase = elapsed * 3.6 + i * 0.35
        const idlePulse = ((Math.sin(phase) + 1) / 2) * 1.5
        return Math.max(3, 3 + reactive + idlePulse)
      })

      setBarHeights(heights)
      raf = requestAnimationFrame(frame)
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="overlay-waveform">
      {barHeights.map((h, i) => (
        <div
          key={i}
          className="overlay-waveform-bar"
          style={{ height: `${h}px` }}
        />
      ))}
    </div>
  )
}

/**
 * Spinning arc for the processing state.
 * Matches macOS: 14x14, 70% arc, angular gradient, 0.8s rotation.
 */
function OverlaySpinner(): React.JSX.Element {
  const r = 5
  const circumference = 2 * Math.PI * r
  return (
    <svg className="overlay-spinner" width="14" height="14" viewBox="0 0 14 14">
      <defs>
        <linearGradient id="overlay-spinner-grad" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#3380ff" stopOpacity="0" />
          <stop offset="100%" stopColor="#3380ff" stopOpacity="1" />
        </linearGradient>
      </defs>
      <circle
        cx="7"
        cy="7"
        r={r}
        fill="none"
        stroke="url(#overlay-spinner-grad)"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeDasharray={`${circumference * 0.7} ${circumference * 0.3}`}
        strokeDashoffset={circumference * 0.15}
      />
    </svg>
  )
}

/* ───────────────────────────────────────────────────────────────────── */
/*  Flight animation (unchanged from original)                         */
/* ───────────────────────────────────────────────────────────────────── */

interface FlightDeps {
  target: PointAtTarget
  token: number
  getActiveToken: () => number
  startState: CursorState
  setCursor: (s: CursorState | ((prev: CursorState) => CursorState)) => void
  setBubble: (
    b:
      | { text: string; x: number; y: number; opacity: number; scale: number }
      | null
      | ((
          prev: { text: string; x: number; y: number; opacity: number; scale: number } | null
        ) => { text: string; x: number; y: number; opacity: number; scale: number } | null)
  ) => void
  onFlightComplete: () => void
}

function runPointFlight(deps: FlightDeps): void {
  const { target, token, getActiveToken, startState, setCursor } = deps

  const initialX = startState.opacity > 0 ? startState.x : Math.max(60, target.x - 240)
  const initialY = startState.opacity > 0 ? startState.y : Math.max(60, target.y - 160)

  setCursor({
    x: initialX,
    y: initialY,
    rotation: startState.rotation,
    scale: 1,
    opacity: 1
  })

  const deltaX = target.x - initialX
  const deltaY = target.y - initialY
  const distance = Math.hypot(deltaX, deltaY)
  const flightMs = Math.min(Math.max((distance / 800) * 1000, 600), 1400)
  const startedAt = performance.now()

  const midX = (initialX + target.x) / 2
  const midY = (initialY + target.y) / 2
  const arcHeight = Math.min(distance * 0.2, 80)
  const ctrlX = midX
  const ctrlY = midY - arcHeight

  function frame(now: number): void {
    if (getActiveToken() !== token) return

    const elapsed = now - startedAt
    const linear = Math.min(elapsed / flightMs, 1)
    const t = linear * linear * (3 - 2 * linear)
    const oneMinusT = 1 - t

    const x = oneMinusT * oneMinusT * initialX + 2 * oneMinusT * t * ctrlX + t * t * target.x
    const y = oneMinusT * oneMinusT * initialY + 2 * oneMinusT * t * ctrlY + t * t * target.y

    const tanX = 2 * oneMinusT * (ctrlX - initialX) + 2 * t * (target.x - ctrlX)
    const tanY = 2 * oneMinusT * (ctrlY - initialY) + 2 * t * (target.y - ctrlY)
    const rotation = (Math.atan2(tanY, tanX) * 180) / Math.PI + 90
    const scale = 1 + Math.sin(linear * Math.PI) * 0.3

    setCursor({ x, y, rotation, scale, opacity: 1 })

    if (linear < 1) {
      requestAnimationFrame(frame)
    } else {
      setCursor({
        x: target.x,
        y: target.y,
        rotation: IDLE_ROTATION_DEGREES,
        scale: 1,
        opacity: 1
      })
      if (target.label) {
        showBubbleAndFade(deps, target)
      } else {
        scheduleFadeOnly(deps)
      }
    }
  }

  requestAnimationFrame(frame)
}

function showBubbleAndFade(deps: FlightDeps, target: PointAtTarget): void {
  const { token, getActiveToken, setCursor, setBubble, onFlightComplete } = deps

  setBubble({
    text: target.label,
    x: target.x,
    y: target.y,
    opacity: 1,
    scale: 0.5
  })
  requestAnimationFrame(() => {
    if (getActiveToken() !== token) return
    setBubble((b) => (b ? { ...b, scale: 1 } : b))
  })

  window.setTimeout(() => {
    if (getActiveToken() !== token) return
    setBubble((b) => (b ? { ...b, opacity: 0 } : b))
    setCursor((c) => ({ ...c, opacity: 0 }))
    window.setTimeout(() => {
      if (getActiveToken() !== token) return
      setBubble(null)
      onFlightComplete()
    }, POINT_FADEOUT_MS)
  }, POINT_HOLD_MS)
}

function scheduleFadeOnly(deps: FlightDeps): void {
  const { token, getActiveToken, setCursor, onFlightComplete } = deps
  window.setTimeout(() => {
    if (getActiveToken() !== token) return
    setCursor((c) => ({ ...c, opacity: 0 }))
    window.setTimeout(() => {
      onFlightComplete()
    }, POINT_FADEOUT_MS)
  }, POINT_HOLD_MS)
}

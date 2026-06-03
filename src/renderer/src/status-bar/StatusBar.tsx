import { useState, useEffect, useRef } from 'react'
import type { VoiceState, CompanionEvent } from '../../../shared/types'

/**
 * Dynamic-Island-style status bar at the top of the screen.
 *
 * Changes size, gradient glow, and internal content based on voice state:
 *   - idle:       small pill, green dot, "Ready" text
 *   - listening:  wider pill, blue glow border, waveform bars + "Listening" text
 *   - processing: medium pill, purple/orange gradient, spinner + "Processing" text
 *   - responding: widest pill, blue/purple gradient, speaking wave + "Speaking" text
 *
 * Ported from macOS OverlayWindow.swift's BlueCursorWaveformView / BlueCursorSpinnerView.
 */
export function StatusBar(): React.JSX.Element {
  const [voiceState, setVoiceState] = useState<VoiceState>('idle')
  const [listeningMode, setListeningMode] = useState<'manual' | 'automatic'>('manual')

  useEffect(() => {
    const unsub = window.clicky.onCompanionEvent((event: CompanionEvent) => {
      if (event.type === 'voice-state') {
        setVoiceState(event.state)
      }
    })
    return unsub
  }, [])

  useEffect(() => {
    const unsub = window.clicky.onListeningModeChange?.((mode: 'manual' | 'automatic') => {
      setListeningMode(mode)
    })
    return unsub
  }, [])

  const display = getStatusDisplay(voiceState, listeningMode)

  return (
    <div className="status-bar-root">
      <div className={`status-bar-pill state-${display.stateClass}`}>
        {/* Inner glow blobs that show through the dark background */}
        <div className="status-bar-glow glow-left" />
        <div className="status-bar-glow glow-right" />

        {/* Left side: label text */}
        <span className="status-bar-label">{display.label}</span>

        {/* Right side: state-specific visual */}
        {display.stateClass === 'idle' && (
          <span className="status-bar-dot idle" />
        )}

        {display.stateClass === 'listening' && <WaveformBars />}

        {display.stateClass === 'processing' && <Spinner />}

        {display.stateClass === 'responding' && <SpeakingWave />}
      </div>
    </div>
  )
}

/**
 * 5 audio-reactive waveform bars for the listening state.
 *
 * Bar heights respond to real-time mic power level, matching the macOS
 * formula from BlueCursorWaveformView:
 *   height = 3 (base) + easedPower * 10 * profile[i] + idlePulse
 *
 * Bar profiles: [0.4, 0.7, 1.0, 0.7, 0.4] — symmetric arch.
 */
const BAR_PROFILES = [0.4, 0.7, 1.0, 0.7, 0.4]

function WaveformBars(): React.JSX.Element {
  const [barHeights, setBarHeights] = useState([4, 4, 4, 4, 4])
  const audioLevelRef = useRef(0)
  const startTimeRef = useRef(performance.now())

  // Subscribe to real-time audio power level from main process
  useEffect(() => {
    const unsub = window.clicky.onAudioLevel?.((level: number) => {
      audioLevelRef.current = level
    })
    return unsub
  }, [])

  // Animation loop: blend audio reactivity + idle sine pulse
  useEffect(() => {
    let raf: number

    function frame(): void {
      const raw = audioLevelRef.current
      // Boost the raw linear RMS level (normal speech is ~0.03 - 0.05).
      // Multiplying by 15 makes it much more sensitive, and the power of 0.6
      // ensures quiet sounds still cause a visible jump in the bars.
      const eased = Math.pow(Math.min(raw * 15, 1), 0.6)
      const elapsed = (performance.now() - startTimeRef.current) / 1000

      const heights = BAR_PROFILES.map((profile, i) => {
        // Audio-reactive component: max 16px extra height
        const reactive = eased * 16 * profile
        // Idle sine pulse (subtle movement even during silence)
        const phase = elapsed * 3.6 + i * 0.35
        const idlePulse = ((Math.sin(phase) + 1) / 2) * 2
        // Total: base + reactive + pulse
        return Math.max(3, 3 + reactive + idlePulse)
      })

      setBarHeights(heights)
      raf = requestAnimationFrame(frame)
    }

    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  return (
    <div className="status-bar-waveform">
      {barHeights.map((h, i) => (
        <div
          key={i}
          className="status-bar-waveform-bar"
          style={{ height: `${h}px` }}
        />
      ))}
    </div>
  )
}

/**
 * Spinning arc for the processing state.
 * Matches macOS: 70% arc, angular gradient, 0.8s rotation.
 */
function Spinner(): React.JSX.Element {
  return (
    <svg className="status-bar-spinner" viewBox="0 0 16 16">
      <defs>
        <linearGradient id="spinner-gradient" x1="0%" y1="0%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#3380ff" stopOpacity="0" />
          <stop offset="100%" stopColor="#3380ff" stopOpacity="1" />
        </linearGradient>
      </defs>
      {/* Arc from 15% to 85% of the circle (70% visible) */}
      <circle
        cx="8"
        cy="8"
        r="6"
        strokeDasharray={`${2 * Math.PI * 6 * 0.7} ${2 * Math.PI * 6 * 0.3}`}
        strokeDashoffset={2 * Math.PI * 6 * 0.15}
      />
    </svg>
  )
}

/**
 * 7-bar speaking waveform with blue → purple → orange gradient colors.
 * More dramatic animation than the listening waveform.
 */
function SpeakingWave(): React.JSX.Element {
  return (
    <div className="status-bar-speaking-wave ">
      <div className="status-bar-speaking-bar" />
      <div className="status-bar-speaking-bar" />
      <div className="status-bar-speaking-bar" />
      <div className="status-bar-speaking-bar" />
      <div className="status-bar-speaking-bar" />
    </div>
  )
}

interface StatusDisplay {
  label: string
  stateClass: string
}

function getStatusDisplay(
  voiceState: VoiceState,
  listeningMode: 'manual' | 'automatic'
): StatusDisplay {
  
  if (listeningMode === 'automatic' && (voiceState === 'listening' || voiceState === 'idle')) {
    return { label: 'Always on', stateClass: 'listening' }
  }
  else{

    switch (voiceState) {
      case 'idle':
      return { label: 'Manual', stateClass: 'idle' }
    case 'listening':
      return { label: 'Listening', stateClass: 'listening' }
    case 'processing':
      return { label: 'Processing', stateClass: 'processing' }
      case 'command':
        return { label: 'Running Command', stateClass: 'processing' }
        case 'responding':
          return { label: 'Speaking', stateClass: 'responding' }
        }
      }
}

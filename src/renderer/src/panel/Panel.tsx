import { useState, useEffect, useRef, useCallback } from 'react'
import type { ClickyModel, VoiceState, ListeningMode, CompanionEvent } from '../../../shared/types'

const DEBUG_PROMPT = 'What is currently on my screen? Point at the most prominent UI element.'

/**
 * The dropdown panel — Clicky's primary UI surface.
 *
 * Shows voice state, partial/final transcripts, Claude's response,
 * model picker, mic button (manual mode), and listening mode toggle.
 *
 * Audio capture happens here via getUserMedia — the panel renderer is
 * always loaded, so the mic stays available.
 */
export function Panel(): React.JSX.Element {
  const [voiceState, setVoiceState] = useState<VoiceState>('idle')
  const [model, setModel] = useState<ClickyModel>('claude-sonnet-4-6')
  const [listeningMode, setListeningMode] = useState<ListeningMode>('manual')
  const [transcript, setTranscript] = useState<string>('')
  const [response, setResponse] = useState<string>('')
  const [error, setError] = useState<string | null>(null)

  // Debug
  const [debugStatus, setDebugStatus] = useState<string | null>(null)
  const [debugBusy, setDebugBusy] = useState(false)

  // Audio capture refs
  const audioContextRef = useRef<AudioContext | null>(null)
  const mediaStreamRef = useRef<MediaStream | null>(null)
  const workletNodeRef = useRef<AudioWorkletNode | ScriptProcessorNode | null>(null)

  // TTS audio element
  const audioRef = useRef<HTMLAudioElement | null>(null)

  // ── Subscribe to companion events ───────────────────────────────────

  useEffect(() => {
    const unsub = window.clicky.onCompanionEvent((event: CompanionEvent) => {
      switch (event.type) {
        case 'voice-state':
          setVoiceState(event.state)
          if (event.state === 'idle') {
            setTranscript('')
          }
          break
        case 'transcript-partial':
          setTranscript(event.text)
          break
        case 'transcript-final':
          setTranscript(event.text)
          break
        case 'response-text':
          setResponse(event.text)
          break
        case 'response-delta':
          setResponse((prev) => prev + event.delta)
          break
        case 'error':
          setError(event.message)
          setTimeout(() => setError(null), 8000)
          break
        case 'tts-start':
          setResponse('')
          break
        case 'tts-end':
          break
      }
    })

    return unsub
  }, [])

  // ── Subscribe to TTS audio pushes ──────────────────────────────────

  useEffect(() => {
    const unsub = window.clicky.onTTSAudio((data) => {
      const blob = base64ToBlob(data.audioBase64, data.mimeType)
      const url = URL.createObjectURL(blob)

      if (audioRef.current) {
        audioRef.current.src = url
        audioRef.current.play().catch((err) => {
          console.error('[panel] TTS playback failed:', err)
          window.clicky.ttsPlaybackEnded()
        })
      }
    })

    return unsub
  }, [])

  // ── Audio capture for mic input ────────────────────────────────────

  const startMicCapture = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true
        }
      })
      mediaStreamRef.current = stream

      const ctx = new AudioContext({ sampleRate: 16000 })
      audioContextRef.current = ctx

      const source = ctx.createMediaStreamSource(stream)

      // Use ScriptProcessorNode (deprecated but universally supported).
      // A buffer size of 1024 at 16000Hz gives us ~64ms per chunk (15 updates/sec),
      // which makes the waveform animation much more responsive and less laggy.
      const processor = ctx.createScriptProcessor(1024, 1, 1)
      processor.onaudioprocess = (e): void => {
        const float32 = e.inputBuffer.getChannelData(0)
        // Convert Float32 [-1, 1] to Int16
        const int16 = new Int16Array(float32.length)
        for (let i = 0; i < float32.length; i++) {
          const s = Math.max(-1, Math.min(1, float32[i]))
          int16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
        }
        window.clicky.sendAudioChunk(int16.buffer)
      }

      source.connect(processor)
      processor.connect(ctx.destination)
      workletNodeRef.current = processor
    } catch (err) {
      console.error('[panel] Mic access failed:', err)
    }
  }, [])

  const stopMicCapture = useCallback(() => {
    if (workletNodeRef.current) {
      workletNodeRef.current.disconnect()
      workletNodeRef.current = null
    }
    if (audioContextRef.current) {
      audioContextRef.current.close()
      audioContextRef.current = null
    }
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach((t) => t.stop())
      mediaStreamRef.current = null
    }
  }, [])

  // Auto-start mic capture when entering listening state
  useEffect(() => {
    if (voiceState === 'listening') {
      void startMicCapture()
    } else {
      stopMicCapture()
    }
  }, [voiceState, startMicCapture, stopMicCapture])

  // ── Handlers ───────────────────────────────────────────────────────

  function handleMicToggle(): void {
    if (voiceState === 'idle') {
      setResponse('')
      window.clicky.startListening()
    } else if (voiceState === 'listening') {
      window.clicky.stopListening()
    }
  }

  function handleModelChange(newModel: ClickyModel): void {
    setModel(newModel)
    window.clicky.setModel(newModel)
  }

  function handleModeChange(mode: ListeningMode): void {
    setListeningMode(mode)
    window.clicky.setListeningMode(mode)
  }

  async function runDebugAsk(): Promise<void> {
    setDebugBusy(true)
    setDebugStatus('asking…')
    try {
      const result = await window.clicky.debugAsk({ transcript: DEBUG_PROMPT, model })
      if (result.ok) {
        setDebugStatus(
          `${result.elapsedMs}ms · ${result.screenCount} screen(s)\n` +
            `text: ${result.text || '(empty)'}\n` +
            (result.pointing.coordinate
              ? `point: (${result.pointing.coordinate.x}, ${result.pointing.coordinate.y}) ` +
                `"${result.pointing.elementLabel}" on screen ${result.pointing.screenNumber}`
              : 'point: none')
        )
      } else {
        setDebugStatus(`error: ${result.error}`)
      }
    } catch (err) {
      setDebugStatus(`error: ${err instanceof Error ? err.message : String(err)}`)
    } finally {
      setDebugBusy(false)
    }
  }

  function handleTTSEnded(): void {
    window.clicky.ttsPlaybackEnded()
  }

  // ── Render ─────────────────────────────────────────────────────────

  return (
    <div className="panel-root">
      <header className="panel-header">
        <div className="panel-title">Clicky</div>
        <div className="panel-subtitle">your AI buddy</div>
      </header>

      {/* Status card */}
      <section className="panel-status-card">
        <div className="panel-status-row">
          <span className={`panel-status-dot ${voiceState}`} />
          <span>{voiceStateLabel(voiceState)}</span>
        </div>

        {/* Transcript or response preview */}
        {transcript && voiceState === 'listening' && (
          <div className="panel-transcript">"{transcript}"</div>
        )}
        {response && (voiceState === 'processing' || voiceState === 'responding') && (
          <div className="panel-response">{response}</div>
        )}
      </section>

      {/* Error banner */}
      {error && <div className="panel-error">{error}</div>}

      {/* Mic button (manual mode) or mode indicator */}
      <section className="panel-mic-section">
        <button
          type="button"
          className={`panel-mic-button ${voiceState === 'listening' ? 'active' : ''}`}
          disabled={listeningMode === 'automatic' || voiceState === 'processing' || voiceState === 'responding'}
          onClick={handleMicToggle}
          id="mic-toggle"
        >
          <MicIcon active={voiceState === 'listening'} />
          <span>
            {voiceState === 'idle'
              ? (listeningMode === 'automatic' ? 'starting...' : 'tap to talk')
              : voiceState === 'listening'
                ? (listeningMode === 'automatic' ? 'always listening…' : 'listening…')
                : voiceState === 'processing'
                  ? 'thinking…'
                  : 'speaking…'}
          </span>
        </button>
      </section>

      {/* Listening mode toggle */}
      <div>
        <div className="panel-section-label">listening mode</div>
        <div className="panel-model-picker" role="radiogroup">
          <button
            type="button"
            role="radio"
            aria-checked={listeningMode === 'manual'}
            className={`panel-model-option ${listeningMode === 'manual' ? 'active' : ''}`}
            onClick={(): void => handleModeChange('manual')}
          >
            Manual
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={listeningMode === 'automatic'}
            className={`panel-model-option ${listeningMode === 'automatic' ? 'active' : ''}`}
            onClick={(): void => handleModeChange('automatic')}
          >
            Always On
          </button>
        </div>
      </div>

      {/* Model picker */}
      <div>
        <div className="panel-section-label">model</div>
        <div className="panel-model-picker" role="radiogroup">
          <button
            type="button"
            role="radio"
            aria-checked={model === 'claude-sonnet-4-6'}
            className={`panel-model-option ${model === 'claude-sonnet-4-6' ? 'active' : ''}`}
            onClick={(): void => handleModelChange('claude-sonnet-4-6')}
          >
            Sonnet 4.6
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={model === 'claude-opus-4-8'}
            className={`panel-model-option ${model === 'claude-opus-4-8' ? 'active' : ''}`}
            onClick={(): void => handleModelChange('claude-opus-4-8')}
          >
            Opus 4.8
          </button>
        </div>
      </div>

      {/* Debug section */}
      <section className="panel-debug">
        <button
          type="button"
          className="panel-debug-button"
          disabled={debugBusy}
          onClick={(): void => {
            void runDebugAsk()
          }}
        >
          {debugBusy ? 'asking…' : 'debug: ask Claude'}
        </button>
        {debugStatus && <pre className="panel-debug-output">{debugStatus}</pre>}
      </section>

      {/* Hidden audio element for TTS playback */}
      <audio ref={audioRef} onEnded={handleTTSEnded} style={{ display: 'none' }} />

      <footer className="panel-footer">
        <span>v0.0.1</span>
        <button
          type="button"
          className="panel-link-button"
          onClick={(): void => {
            window.clicky.clearHistory()
          }}
        >
          clear history
        </button>
      </footer>
    </div>
  )
}

/** Mic icon SVG — pulses when active. */
function MicIcon({ active }: { active: boolean }): React.JSX.Element {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke={active ? 'var(--clicky-accent)' : 'var(--clicky-text-secondary)'}
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={active ? 'mic-pulse' : ''}
    >
      <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
      <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
      <line x1="12" y1="19" x2="12" y2="23" />
      <line x1="8" y1="23" x2="16" y2="23" />
    </svg>
  )
}

function voiceStateLabel(state: VoiceState): string {
  switch (state) {
    case 'idle':
      return 'ready'
    case 'listening':
      return 'listening…'
    case 'processing':
      return 'thinking…'
    case 'command':
      return 'running command…'
    case 'responding':
      return 'speaking…'
  }
}

function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return new Blob([bytes], { type: mimeType })
}

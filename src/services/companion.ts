/**
 * Companion — the central state machine that coordinates Clicky's voice flow.
 *
 * State machine:
 *   idle → listening → processing → responding → idle
 *
 * The companion owns:
 *   - ClaudeService (the brain)
 *   - Conversation history
 *   - TranscriptionProvider (STT)
 *   - TTSService (text-to-speech)
 *   - Voice state transitions
 *
 * It does NOT directly import Electron APIs. All OS-level operations
 * (screen capture, window management, pointing resolution) are injected
 * as dependencies so the companion stays testable and process-agnostic.
 *
 * Two listening modes:
 *   - **automatic**: Mic stays open, AssemblyAI detects speech endpoints
 *   - **manual**: User clicks mic button to start/stop recording
 *
 * See vault/subsystems/06-claude-integration.md for the original Swift
 * CompanionManager this replaces.
 */

import type {
  ClickyModel,
  VoiceState,
  ListeningMode,
  DisplayCapture,
  ConversationTurn,
  PointingResult,
  CompanionEvent
} from '../shared/types'
import { createClaudeService } from './claude'
import type { ClaudeService, ClaudeServiceConfig } from './claude'
import { createTTSService } from './tts'
import type { TTSService, TTSConfig } from './tts'
import type { TranscriptionProvider } from './transcription/provider'

/** Maximum conversation turns to keep in history (saves tokens). */
const MAX_HISTORY_TURNS = 10

/**
 * Dependencies injected by the main process at construction time.
 * This keeps the companion decoupled from Electron internals.
 */
export interface CompanionDeps {
  /** Capture all screens (hides Clicky windows first). */
  captureScreens: () => Promise<DisplayCapture[]>

  /** Resolve a pointing result to overlay coordinates and send to overlay. */
  resolveAndSendPoint: (pointing: PointingResult, screens: DisplayCapture[]) => void

  /** Push a companion event to all renderer windows. */
  onEvent: (event: CompanionEvent) => void

  /** Send TTS audio data to the renderer for playback. */
  sendTTSAudio: (data: { audioBase64: string; mimeType: string }) => void
}

export interface CompanionConfig {
  claude: ClaudeServiceConfig
  tts: TTSConfig
}

export class Companion {
  private state: VoiceState = 'idle'
  private model: ClickyModel = 'claude-sonnet-4-6'
  private listeningMode: ListeningMode = 'manual'
  private history: ConversationTurn[] = []
  private claude: ClaudeService
  private tts: TTSService
  private stt: TranscriptionProvider | null = null
  private deps: CompanionDeps

  /**
   * Accumulated final transcript segments during a single listening session.
   * In automatic mode, multiple finals may arrive before processing triggers.
   */
  private accumulatedTranscript = ''

  /** Timeout for automatic mode — after silence, process what we have. */
  private autoProcessTimeout: ReturnType<typeof setTimeout> | null = null
  private static readonly AUTO_SILENCE_MS = 2000

  constructor(config: CompanionConfig, deps: CompanionDeps) {
    this.deps = deps
    this.claude = createClaudeService(config.claude)
    this.tts = createTTSService(config.tts)
  }

  // ── Public API ──────────────────────────────────────────────────────

  /** Attach a transcription provider (called after construction). */
  setTranscriptionProvider(provider: TranscriptionProvider): void {
    this.stt = provider

    provider.onPartialTranscript = (text) => {
      this.emit({ type: 'transcript-partial', text })
    }

    provider.onFinalTranscript = (text) => {
      this.accumulatedTranscript += (this.accumulatedTranscript ? ' ' : '') + text
      this.emit({ type: 'transcript-final', text: this.accumulatedTranscript })

      if (this.listeningMode === 'automatic') {
        // In automatic mode, wait for a silence gap then process.
        this.resetAutoProcessTimer()
      }
    }

    provider.onError = (error) => {
      console.error('[companion] STT error:', error.message)
      this.emit({ type: 'error', message: `Speech recognition error: ${error.message}` })
    }
  }

  /** Start listening for voice input. */
  async startListening(): Promise<void> {
    if (this.state !== 'idle') {
      console.warn(`[companion] Cannot start listening from state: ${this.state}`)
      return
    }

    if (!this.stt) {
      this.emit({ type: 'error', message: 'No speech recognition provider configured' })
      return
    }

    this.accumulatedTranscript = ''
    this.setState('listening')

    try {
      if (!this.stt.isConnected) {
        await this.stt.connect()
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.emit({ type: 'error', message: `Failed to connect to speech service: ${msg}` })
      this.setState('idle')
    }
  }

  /**
   * Stop listening and process the accumulated transcript.
   * In manual mode, this is triggered by the user releasing the mic button.
   */
  async stopListening(): Promise<void> {
    if (this.state !== 'listening') return

    this.clearAutoProcessTimer()

    const transcript = this.accumulatedTranscript.trim()
    if (!transcript) {
      console.log('[companion] Empty transcript — returning to idle')
      this.setState('idle')
      return
    }

    await this.processTranscript(transcript)
  }

  /** Feed a PCM16 audio chunk from the renderer's mic capture. */
  feedAudio(pcm16: Int16Array): void {
    if (this.state !== 'listening' || !this.stt) return
    this.stt.sendAudio(pcm16)
  }

  /** Change the active Claude model. */
  setModel(model: ClickyModel): void {
    this.model = model
    console.log(`[companion] Model set to: ${model}`)
  }

  /** Switch between automatic and manual listening modes. */
  setListeningMode(mode: ListeningMode): void {
    const previousMode = this.listeningMode
    this.listeningMode = mode
    console.log(`[companion] Listening mode: ${mode}`)

    if (mode === 'automatic' && this.state === 'idle') {
      void this.startListening()
    } else if (mode === 'manual' && previousMode === 'automatic' && this.state === 'listening') {
      void this.stopListening()
    }
  }

  /** Clear conversation history. */
  clearHistory(): void {
    this.history = []
    console.log('[companion] History cleared')
  }

  /** Notify the companion that TTS playback finished in the renderer. */
  onTTSPlaybackEnded(): void {
    if (this.state === 'responding') {
      this.emit({ type: 'tts-end' })

      if (this.listeningMode === 'automatic') {
        // In automatic mode, go right back to listening
        this.setState('idle')
        void this.startListening()
      } else {
        this.setState('idle')
      }
    }
  }

  /** Get the current voice state. */
  getState(): VoiceState {
    return this.state
  }

  /** Get the current listening mode. */
  getListeningMode(): ListeningMode {
    return this.listeningMode
  }

  // ── Internal ────────────────────────────────────────────────────────

  /**
   * The core pipeline: transcript → screen capture → Claude → pointing → TTS.
   */
  private async processTranscript(transcript: string): Promise<void> {
    this.setState('processing')

    try {
      // 1. Capture all screens
      const screens = await this.deps.captureScreens()

      // 2. Call Claude with the transcript + screenshots + history
      let responseText = ''
      const result = await this.claude.respond({
        model: this.model,
        userTranscript: transcript,
        history: this.history,
        screens,
        onTextDelta: (delta) => {
          responseText += delta
          this.emit({ type: 'response-delta', delta })
        }
      })

      // 3. Emit the full response
      this.emit({ type: 'response-text', text: result.text })

      // 4. Add to conversation history
      this.history.push({
        userTranscript: transcript,
        assistantResponse: result.text
      })

      // Trim history to prevent unbounded growth
      if (this.history.length > MAX_HISTORY_TURNS) {
        this.history = this.history.slice(-MAX_HISTORY_TURNS)
      }

      // 5. Dispatch pointing if Claude chose to point
      if (result.pointing.coordinate) {
        this.emit({ type: 'pointing', pointing: result.pointing })
        this.deps.resolveAndSendPoint(result.pointing, screens)
      }

      // 6. Play TTS
      this.setState('responding')
      await this.playTTS(result.pointing.spokenText || result.text)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[companion] Pipeline error:', msg)
      this.emit({ type: 'error', message: msg })
      this.setState('idle')
    }
  }

  /** Request TTS and send audio to the renderer for playback. */
  private async playTTS(text: string): Promise<void> {
    if (!this.tts.isAvailable) {
      // No TTS configured — skip straight to idle after a brief pause
      this.emit({ type: 'tts-start' })
      this.emit({ type: 'tts-end' })

      if (this.listeningMode === 'automatic') {
        this.setState('idle')
        void this.startListening()
      } else {
        this.setState('idle')
      }
      return
    }

    try {
      this.emit({ type: 'tts-start' })
      const audioResult = await this.tts.speak(text)

      if (audioResult) {
        // Send audio to the renderer — it will play and call ttsPlaybackEnded
        this.deps.sendTTSAudio(audioResult)
      } else {
        // TTS returned nothing — transition immediately
        this.onTTSPlaybackEnded()
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error('[companion] TTS error:', msg)
      this.emit({ type: 'error', message: `TTS failed: ${msg}` })
      // Don't stay stuck in responding — go back to idle
      this.onTTSPlaybackEnded()
    }
  }

  private setState(state: VoiceState): void {
    this.state = state
    this.emit({ type: 'voice-state', state })
    console.log(`[companion] State → ${state}`)
  }

  private emit(event: CompanionEvent): void {
    this.deps.onEvent(event)
  }

  /**
   * In automatic mode, set a timer to process after silence.
   * Resets on each new final transcript segment.
   */
  private resetAutoProcessTimer(): void {
    this.clearAutoProcessTimer()
    this.autoProcessTimeout = setTimeout(() => {
      if (this.state === 'listening' && this.accumulatedTranscript.trim()) {
        void this.stopListening()
      }
    }, Companion.AUTO_SILENCE_MS)
  }

  private clearAutoProcessTimer(): void {
    if (this.autoProcessTimeout) {
      clearTimeout(this.autoProcessTimeout)
      this.autoProcessTimeout = null
    }
  }
}

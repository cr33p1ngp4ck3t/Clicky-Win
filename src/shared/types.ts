/**
 * Types shared between main, preload, and renderer processes.
 * Keep this file zero-dependency — it's imported from every layer.
 */

/** The Claude models Clicky exposes to the user in the panel UI. */
export type ClickyModel = 'claude-sonnet-4-6' | 'claude-opus-4-8'

/**
 * The four-phase voice state machine. Mirrors the original
 * CompanionManager.swift state enum: idle → listening → processing → responding.
 */
export type VoiceState = 'idle' | 'listening' | 'processing' | 'responding' | 'command'

/** How Clicky listens for voice: always-on mic or manual mic button toggle. */
export type ListeningMode = 'automatic' | 'manual'

/**
 * One captured display in a multi-monitor screenshot bundle. The `label` is
 * what we send to Claude as the text block following the image — e.g.
 * "primary focus (image dimensions: 2560x1440 pixels)".
 */
export interface DisplayCapture {
  imageData: Uint8Array
  mediaType: 'image/jpeg' | 'image/png'
  label: string
  widthPixels: number
  heightPixels: number
  isPrimary: boolean
  screenNumber: number
}

/**
 * Result of Claude's pointing tool call. Kept as a dedicated shape so we
 * can swap implementations without rippling type changes.
 */
export interface PointingResult {
  /** Response text with the tag stripped — what gets spoken via TTS. */
  spokenText: string
  /** Pixel coordinate in the screenshot's coordinate space, or null. */
  coordinate: { x: number; y: number } | null
  /** Short 1-3 word element description. */
  elementLabel: string | null
  /** 1-based screen number; null means the cursor's current screen. */
  screenNumber: number | null
}

/** One turn of the conversation history sent back to Claude on each request. */
export interface ConversationTurn {
  userTranscript: string
  assistantResponse: string
}

/**
 * Events emitted by the companion state machine and forwarded to the
 * renderer via IPC. The panel and overlay subscribe to these to update
 * their UI in real time.
 */
export type CompanionEvent =
  | { type: 'voice-state'; state: VoiceState }
  | { type: 'transcript-partial'; text: string }
  | { type: 'transcript-final'; text: string }
  | { type: 'response-text'; text: string }
  | { type: 'response-delta'; delta: string }
  | { type: 'pointing'; pointing: PointingResult }
  | { type: 'error'; message: string }
  | { type: 'tts-start' }
  | { type: 'tts-end' }

/**
 * TranscriptionProvider — interface for speech-to-text backends.
 *
 * Clicky currently supports AssemblyAI v2 real-time streaming. The interface
 * is designed so we can add OpenAI Whisper or local whisper.cpp later without
 * touching the companion state machine.
 */

export interface TranscriptionProvider {
  /** Open the WebSocket / connection to the STT service. */
  connect(): Promise<void>

  /** Gracefully close the connection. */
  disconnect(): void

  /**
   * Feed a PCM16 audio chunk to the provider. Called on every audio
   * worklet frame (~128 samples at 16kHz = ~8ms). The chunk is a raw
   * Int16Array — the provider converts to whatever wire format the
   * service expects.
   */
  sendAudio(pcm16: Int16Array): void

  /** Callback fired with partial (in-progress) transcript text. */
  onPartialTranscript: ((text: string) => void) | null

  /** Callback fired when the service finalizes a segment of speech. */
  onFinalTranscript: ((text: string) => void) | null

  /** Callback fired on connection or protocol errors. */
  onError: ((error: Error) => void) | null

  /** Whether the provider's connection is currently open. */
  readonly isConnected: boolean
}

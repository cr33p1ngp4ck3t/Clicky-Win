import type { RespondParams, RespondResult } from './claude'
import type { TTSService, TTSResult } from './tts'
import type { TranscriptionProvider } from './transcription/provider'

/**
 * Mock Claude Service
 * Returns a fake response and pointing decision after a 1.5s delay.
 */
export class MockClaudeService {
  async respond(params: RespondParams): Promise<RespondResult> {
    console.log('[mock] Claude received request:', {
      transcript: params.userTranscript,
      screens: params.screens.length
    })

    // Simulate network delay
    await new Promise((resolve) => setTimeout(resolve, 1500))

    const fakeText = "I see what you're looking at. Let me point to it for you."
    
    // Simulate streaming the text back
    const words = fakeText.split(' ')
    for (const word of words) {
      params.onTextDelta?.(word + ' ')
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    // Grab the first screen to point at something near the top-left
    const primaryScreen = params.screens.find(s => s.isPrimary) || params.screens[0]
    
    return {
      text: fakeText,
      pointing: {
        spokenText: fakeText,
        // Point at a fake coordinate (e.g., 200px from top left)
        coordinate: { x: 200, y: 200 },
        elementLabel: 'Test Element',
        screenNumber: primaryScreen?.screenNumber || 1
      }
    }
  }
}

/**
 * Mock TTS Service
 * Returns a silent 1-second MP3 file as base64 so the <audio> element plays
 * something valid and fires its `onEnded` event properly.
 */
export class MockTTSService implements TTSService {
  get isAvailable(): boolean {
    return true
  }

  async speak(text: string): Promise<TTSResult | null> {
    console.log(`[mock] TTS speaking: "${text}"`)
    
    // Base64 for a tiny, valid silent MP3 file (MPEG ADTS, layer III, v1, 32 kbps, 44.1 kHz, Monaural)
    // This allows the renderer's <audio> tag to successfully load and "play" it.
    const silentMp3Base64 = '//NExAAAAANIAAAAAExBTUUzLjEwMKqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq'
    
    return {
      audioBase64: silentMp3Base64,
      mimeType: 'audio/mpeg'
    }
  }
}

/**
 * Mock Transcription Provider
 * Automatically generates a transcript after receiving a few chunks of audio.
 */
export class MockTranscriptionProvider implements TranscriptionProvider {
  private _isConnected = false
  private audioChunkCount = 0
  private typingTimer: NodeJS.Timeout | null = null

  onPartialTranscript: ((text: string) => void) | null = null
  onFinalTranscript: ((text: string) => void) | null = null
  onError: ((error: Error) => void) | null = null

  get isConnected(): boolean {
    return this._isConnected
  }

  async connect(): Promise<void> {
    console.log('[mock] STT connected')
    this._isConnected = true
    this.audioChunkCount = 0
  }

  disconnect(): void {
    console.log('[mock] STT disconnected')
    this._isConnected = false
    if (this.typingTimer) clearTimeout(this.typingTimer)
  }

  sendAudio(_pcm16: Int16Array): void {
    if (!this._isConnected) return
    this.audioChunkCount++

    // Simulate "hearing" speech after we get enough audio frames
    if (this.audioChunkCount === 20) {
      this.onPartialTranscript?.('Testing...')
    }
    
    if (this.audioChunkCount === 50) {
      this.onPartialTranscript?.('Testing the mock pipeline...')
    }

    // Automatically finalize after 80 chunks (approx 1-2 seconds of speaking)
    if (this.audioChunkCount === 80) {
      this.onFinalTranscript?.('Testing the mock pipeline.')
      this.audioChunkCount = 0 // reset for next utterance
    }
  }
}

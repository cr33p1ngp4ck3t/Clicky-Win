/**
 * ElevenLabs TTS service — converts Claude's response text to speech.
 *
 * Uses the direct ElevenLabs API with an API key (no Cloudflare Worker proxy).
 * Returns audio as base64 so the renderer can create a blob URL and play via
 * an <audio> element.
 *
 * Model: eleven_flash_v2_5 (~300ms to first audio chunk, fast + cheap).
 *
 * See vault/subsystems/07-tts-playback.md for the original Swift implementation.
 */

export interface TTSConfig {
  apiKey?: string
  voiceId?: string
}

export interface TTSResult {
  /** Base64-encoded audio data. */
  audioBase64: string
  /** MIME type of the audio. */
  mimeType: string
}

export interface TTSService {
  /**
   * Convert text to speech. Returns base64 audio data.
   * Returns null if TTS is not configured (no API key).
   */
  speak(text: string): Promise<TTSResult | null>

  /** Whether TTS is available (API key is configured). */
  readonly isAvailable: boolean
}

const ELEVENLABS_BASE = 'https://api.elevenlabs.io/v1/text-to-speech'
const DEFAULT_MODEL = 'eleven_flash_v2_5'
const DEFAULT_VOICE_ID = 'pNInz6obpgDQGcFmaJgB' // Adam

export function createTTSService(config: TTSConfig): TTSService {
  return new ElevenLabsTTS(config)
}

class ElevenLabsTTS implements TTSService {
  private apiKey: string | undefined
  private voiceId: string

  constructor(config: TTSConfig) {
    this.apiKey = config.apiKey
    this.voiceId = config.voiceId || DEFAULT_VOICE_ID
  }

  get isAvailable(): boolean {
    return !!this.apiKey
  }

  async speak(text: string): Promise<TTSResult | null> {
    if (!this.apiKey) {
      console.log('[tts] No API key configured — skipping TTS')
      return null
    }

    if (!text.trim()) {
      return null
    }

    const url = `${ELEVENLABS_BASE}/${this.voiceId}`

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'xi-api-key': this.apiKey,
        'Content-Type': 'application/json',
        Accept: 'audio/mpeg'
      },
      body: JSON.stringify({
        text,
        model_id: DEFAULT_MODEL,
        voice_settings: {
          stability: 0.5,
          similarity_boost: 0.75,
          style: 0.0,
          use_speaker_boost: true
        }
      })
    })

    if (!response.ok) {
      const errorText = await response.text()
      throw new Error(`ElevenLabs TTS failed (${response.status}): ${errorText}`)
    }

    const arrayBuffer = await response.arrayBuffer()
    const base64 = Buffer.from(arrayBuffer).toString('base64')

    return {
      audioBase64: base64,
      mimeType: 'audio/mpeg'
    }
  }
}

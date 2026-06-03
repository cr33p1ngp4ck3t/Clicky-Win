/**
 * AssemblyAI real-time streaming transcription provider.
 *
 * Flow:
 *   1. Mint a temporary token via REST (POST /v2/realtime/token)
 *   2. Open a WebSocket to wss://api.assemblyai.com/v2/realtime/ws
 *   3. Stream PCM16 audio frames as base64-encoded JSON messages
 *   4. Receive JSON messages with partial_transcript / final_transcript
 *
 * Uses the direct API key approach — no Cloudflare Worker needed.
 *
 * Runs in the main process (Node.js). Uses the `ws` package that ships
 * as a transitive dependency of Electron / electron-vite.
 */

import WebSocket from 'ws'
import type { TranscriptionProvider } from './provider'

const TOKEN_ENDPOINT = 'https://streaming.assemblyai.com/v3/token'
const WSS_BASE = 'wss://streaming.assemblyai.com/v3/ws'
const SAMPLE_RATE = 16000
const TOKEN_LIFETIME_SECONDS = 480

export interface AssemblyAIConfig {
  apiKey: string
}

export function createAssemblyAIProvider(config: AssemblyAIConfig): TranscriptionProvider {
  return new AssemblyAIStreamingProvider(config)
}

/**
 * Internal WebSocket wrapper using the 'ws' package.
 */
class AssemblyAIStreamingProvider implements TranscriptionProvider {
  private ws: WebSocket | null = null
  private _isConnected = false
  private apiKey: string

  onPartialTranscript: ((text: string) => void) | null = null
  onFinalTranscript: ((text: string) => void) | null = null
  onError: ((error: Error) => void) | null = null

  constructor(config: AssemblyAIConfig) {
    this.apiKey = config.apiKey
  }

  get isConnected(): boolean {
    return this._isConnected
  }

  async connect(): Promise<void> {
    if (this._isConnected) return

    // Step 1: Mint a temporary token
    const token = await this.mintToken()

    // Step 2: Open WebSocket
    const url = `${WSS_BASE}?sample_rate=${SAMPLE_RATE}&speech_model=u3-rt-pro&token=${token}`

    return new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(url)

      ws.on('open', () => {
        this._isConnected = true
        this.ws = ws
        console.log('[assemblyai] WebSocket connected')
        resolve()
      })

      ws.on('message', (data: Buffer | string) => {
        try {
          const msg = JSON.parse(data.toString())
          this.handleMessage(msg)
        } catch (err) {
          console.error('[assemblyai] Failed to parse message:', err)
        }
      })

      ws.on('error', (err: Error) => {
        console.error('[assemblyai] WebSocket error:', err.message)
        this.onError?.(err)
        if (!this._isConnected) {
          reject(err)
        }
      })

      ws.on('close', () => {
        console.log('[assemblyai] WebSocket closed')
        this._isConnected = false
        this.ws = null
      })
    })
  }

  disconnect(): void {
    if (this.ws) {
      try {
        if (this.ws.readyState === 1 /* OPEN */) {
          this.ws.send(JSON.stringify({ terminate_session: true }))
        }
        this.ws.close()
      } catch {
        // Ignore close errors
      }
      this.ws = null
      this._isConnected = false
    }
  }

  sendAudio(pcm16: Int16Array): void {
    if (!this._isConnected || !this.ws) return
    if (this.ws.readyState !== 1 /* OPEN */) return

    // AssemblyAI expects base64-encoded audio in a JSON message
    const bytes = new Uint8Array(pcm16.buffer, pcm16.byteOffset, pcm16.byteLength)
    const base64 = Buffer.from(bytes).toString('base64')
    this.ws.send(JSON.stringify({ audio_data: base64 }))
  }

  /**
   * Mint a temporary token for the WebSocket connection.
   */
  private async mintToken(): Promise<string> {
    const response = await fetch(`${TOKEN_ENDPOINT}?expires_in_seconds=${TOKEN_LIFETIME_SECONDS}`, {
      method: 'GET',
      headers: {
        Authorization: this.apiKey,
        'Content-Type': 'application/json'
      }
    })

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`AssemblyAI token request failed (${response.status}): ${text}`)
    }

    const data = (await response.json()) as { token: string }
    return data.token
  }

  /**
   * Handle incoming WebSocket messages from AssemblyAI.
   */
  private handleMessage(msg: Record<string, unknown>): void {
    const messageType = msg.message_type as string | undefined

    switch (messageType) {
      case 'PartialTranscript': {
        const text = ((msg.text as string) || '').trim()
        if (text) {
          this.onPartialTranscript?.(text)
        }
        break
      }
      case 'FinalTranscript': {
        const text = ((msg.text as string) || '').trim()
        if (text) {
          this.onFinalTranscript?.(text)
        }
        break
      }
      case 'SessionBegins':
        console.log('[assemblyai] Session started:', msg.session_id)
        break
      case 'SessionTerminated':
        console.log('[assemblyai] Session terminated')
        this.disconnect()
        break
      default:
        break
    }
  }
}

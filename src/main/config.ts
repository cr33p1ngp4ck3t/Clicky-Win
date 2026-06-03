import { config as loadDotenv } from 'dotenv'
import type { ClaudeServiceConfig } from '../services/claude'

/** Extended config for all API services Clicky uses. */
export interface TTSConfig {
  apiKey?: string
  voiceId?: string
}

export interface TranscriptionConfig {
  assemblyaiApiKey?: string
}

export interface ClickyConfig {
  claude: ClaudeServiceConfig
  tts: TTSConfig
  transcription: TranscriptionConfig
  /** If true, runs the app using local mock services instead of hitting real APIs. */
  mockMode: boolean
}

// Load .env from CWD. Idempotent — safe to call from multiple modules.
// In packaged builds there's no .env on disk so this no-ops silently.
let envLoaded = false
function ensureEnvLoaded(): void {
  if (envLoaded) return
  loadDotenv({ override: false })
  envLoaded = true
}

export function loadConfig(): ClickyConfig {
  ensureEnvLoaded()
  const workerURL = process.env.CLICKY_WORKER_URL?.trim()
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim()
  const elevenLabsKey = process.env.ELEVENLABS_API_KEY?.trim()
  const elevenLabsVoice = process.env.ELEVENLABS_VOICE_ID?.trim()
  const assemblyaiKey = process.env.ASSEMBLYAI_API_KEY?.trim()
  
  // Enable mock mode if explicitly requested OR if no keys are provided at all.
  const isMockMode = 
    process.env.MOCK_MODE === 'true' || 
    (!apiKey && !workerURL && !assemblyaiKey)

  if (isMockMode) {
    console.log('[clicky] Running in MOCK MODE (No real API calls will be made)')
  } else if (!workerURL && !apiKey) {
    console.warn(
      '[clicky] Neither CLICKY_WORKER_URL nor ANTHROPIC_API_KEY is set. ' +
        'Claude calls will fail until one is configured.'
    )
  }

  return {
    claude: {
      workerBaseURL: workerURL,
      apiKey
    },
    tts: {
      apiKey: elevenLabsKey,
      voiceId: elevenLabsVoice || 'pNInz6obpgDQGcFmaJgB' // Default: Adam
    },
    transcription: {
      assemblyaiApiKey: assemblyaiKey
    },
    mockMode: isMockMode
  }
}

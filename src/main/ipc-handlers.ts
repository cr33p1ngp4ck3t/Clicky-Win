/**
 * IPC handlers. Registered once at main startup. Renderer talks to these
 * via the typed `window.clicky.*` surface in src/preload/index.ts.
 *
 * Handles:
 *   - ping: smoke-test IPC
 *   - debug-ask: full pipeline test (dev only)
 *   - companion:*: voice state machine controls
 *   - audio-chunk: PCM16 audio from renderer mic capture
 *   - tts-playback-ended: renderer signals TTS audio finished
 */

import { ipcMain, BrowserWindow, screen as electronScreen } from 'electron'
import { createClaudeService } from '../services/claude'
import type { ClaudeService } from '../services/claude'
import { Companion } from '../services/companion'
import { createAssemblyAIProvider } from '../services/transcription/assemblyai'
import { captureAllScreens } from './screen-capture'
import { loadConfig } from './config'
import { resolvePointTarget, sendPointTarget } from './pointing'
import type { ClickyModel, PointingResult, CompanionEvent, ListeningMode } from '../shared/types'
import { MockClaudeService, MockTTSService, MockTranscriptionProvider } from '../services/mock-services'

export interface DebugAskRequest {
  transcript: string
  model: ClickyModel
}

export interface DebugAskResponse {
  ok: true
  text: string
  pointing: PointingResult
  elapsedMs: number
  screenCount: number
}

export interface DebugAskError {
  ok: false
  error: string
}

interface Deps {
  panelWindow: BrowserWindow
  overlayWindow: BrowserWindow
  statusBarWindow: BrowserWindow
}

export function registerIpcHandlers({ panelWindow, overlayWindow, statusBarWindow }: Deps): Companion {
  const cfg = loadConfig()

  // ── Lazy Claude service for debug-ask ─────────────────────────────
  let claudeService: ClaudeService | null = null
  function getClaude(): ClaudeService {
    if (!claudeService) {
      claudeService = cfg.mockMode ? (new MockClaudeService() as unknown as ClaudeService) : createClaudeService(cfg.claude)
    }
    return claudeService
  }

  // ── Companion state machine ────────────────────────────────────────

  /** Broadcast a companion event to all renderer windows. */
  function broadcastEvent(event: CompanionEvent): void {
    for (const win of [panelWindow, overlayWindow, statusBarWindow]) {
      if (!win.isDestroyed()) {
        win.webContents.send('companion-event', event)
      }
    }
  }

  // Instantiate the Companion. We bypass the standard constructors if mockMode is active.
  const companion = new Companion(
    {
      claude: cfg.claude,
      tts: cfg.tts
    },
    {
      captureScreens: () =>
        captureAllScreens({ hideDuringCapture: [panelWindow, overlayWindow] }),

      resolveAndSendPoint: (pointing, screens) => {
        const target = resolvePointTarget(pointing, screens)
        if (target) {
          sendPointTarget(overlayWindow, target)
        }
      },

      onEvent: broadcastEvent,

      sendTTSAudio: (data) => {
        if (!panelWindow.isDestroyed()) {
          panelWindow.webContents.send('tts-audio', data)
        }
      }
    }
  )

  // Inject mocks if mock mode is true
  if (cfg.mockMode) {
    // Override companion's internal services with mocks
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(companion as any).claude = new MockClaudeService()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(companion as any).tts = new MockTTSService()
    companion.setTranscriptionProvider(new MockTranscriptionProvider())
    console.log('[ipc] Initialized Companion with MOCK services')
  } 
  // Otherwise wire up AssemblyAI STT if an API key is configured
  else if (cfg.transcription.assemblyaiApiKey) {
    const sttProvider = createAssemblyAIProvider({
      apiKey: cfg.transcription.assemblyaiApiKey
    })
    companion.setTranscriptionProvider(sttProvider)
    console.log('[ipc] AssemblyAI STT provider configured')
  } else {
    console.warn(
      '[ipc] No ASSEMBLYAI_API_KEY set — voice input will not work until configured.'
    )
  }

  // ── Global Push-to-Talk Shortcut ───────────────────────────────────
  import('./shortcut-monitor').then(({ registerGlobalShortcutMonitor }) => {
    registerGlobalShortcutMonitor(companion, (newMode) => {
      // Broadcast to all renderers when mode is toggled via shortcut
      for (const win of [panelWindow, overlayWindow, statusBarWindow]) {
        if (!win.isDestroyed()) {
          win.webContents.send('listening-mode-changed', newMode)
        }
      }
    })
  })

  // ── IPC: smoke test ───────────────────────────────────────────────
  ipcMain.handle('ping', () => 'pong')

  // ── IPC: debug-ask (dev only) ─────────────────────────────────────
  ipcMain.handle(
    'debug-ask',
    async (_event, req: DebugAskRequest): Promise<DebugAskResponse | DebugAskError> => {
      const start = Date.now()
      try {
        const screens = await captureAllScreens({
          hideDuringCapture: [panelWindow, overlayWindow]
        })

        const claude = getClaude()
        const result = await claude.respond({
          model: req.model,
          userTranscript: req.transcript,
          history: [],
          screens
        })

        const target = resolvePointTarget(result.pointing, screens)
        if (target) {
          sendPointTarget(overlayWindow, target)
        }

        return {
          ok: true,
          text: result.text,
          pointing: result.pointing,
          elapsedMs: Date.now() - start,
          screenCount: screens.length
        }
      } catch (err) {
        return {
          ok: false,
          error: err instanceof Error ? `${err.name}: ${err.message}` : String(err)
        }
      }
    }
  )

  // ── IPC: companion controls ───────────────────────────────────────

  ipcMain.on('companion:start-listening', () => {
    void companion.startListening()
  })

  ipcMain.on('companion:stop-listening', () => {
    void companion.stopListening()
  })

  ipcMain.on('companion:set-model', (_event, model: ClickyModel) => {
    companion.setModel(model)
  })

  ipcMain.on('companion:set-listening-mode', (_event, mode: ListeningMode) => {
    companion.setListeningMode(mode)
    // Broadcast to all renderers (especially the status bar)
    for (const win of [panelWindow, overlayWindow, statusBarWindow]) {
      if (!win.isDestroyed()) {
        win.webContents.send('listening-mode-changed', mode)
      }
    }
  })

  ipcMain.on('companion:clear-history', () => {
    companion.clearHistory()
  })

  // ── IPC: audio chunks from renderer mic ───────────────────────────

  ipcMain.on('audio-chunk', (_event, chunk: ArrayBuffer) => {
    const pcm16 = new Int16Array(chunk)
    companion.feedAudio(pcm16)

    // Compute RMS power level (0..1) and broadcast to all renderers
    // so waveform bars can react to actual voice volume.
    let sumSq = 0
    for (let i = 0; i < pcm16.length; i++) {
      const normalized = pcm16[i] / 32768
      sumSq += normalized * normalized
    }
    const rms = Math.sqrt(sumSq / pcm16.length)
    // Clamp to 0..1 range (typical speech sits 0.01–0.15)
    const level = Math.min(rms, 1)

    for (const win of [panelWindow, overlayWindow, statusBarWindow]) {
      if (!win.isDestroyed()) {
        win.webContents.send('audio-level', level)
      }
    }
  })

  // ── IPC: TTS playback ended ───────────────────────────────────────

  ipcMain.on('tts-playback-ended', () => {
    companion.onTTSPlaybackEnded()
  })

  // ── IPC: mouse position for cursor following ──────────────────────
  // Poll mouse position and send to overlay for idle cursor animation.
  // 60fps is wasteful; 30fps is smooth enough for a lazy follow.
  setInterval(() => {
    if (overlayWindow.isDestroyed() || !overlayWindow.isVisible()) return

    const cursor = electronScreen.getCursorScreenPoint()
    const displays = electronScreen.getAllDisplays()
    const minX = Math.min(...displays.map((d) => d.bounds.x))
    const minY = Math.min(...displays.map((d) => d.bounds.y))

    overlayWindow.webContents.send('mouse-position', {
      x: cursor.x - minX,
      y: cursor.y - minY
    })
  }, 33) // ~30fps

  return companion
}

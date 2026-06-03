import { contextBridge, ipcRenderer } from 'electron'
import { electronAPI } from '@electron-toolkit/preload'
import type { DebugAskRequest, DebugAskResponse, DebugAskError } from '../main/ipc-handlers'
import type { CompanionEvent, ClickyModel, ListeningMode } from '../shared/types'

/**
 * Exposes a typed surface to the renderer processes. Both the panel
 * renderer and the overlay renderer load this same preload — they use the
 * same `window.clicky` API.
 *
 * Everything that touches OS resources (audio, capture, hotkey, file system,
 * Claude / ElevenLabs / AssemblyAI HTTP) runs in the main process. Renderers
 * call into it through the IPC surface defined here.
 */

const api = {
  // Smoke-test IPC.
  ping: (): Promise<string> => ipcRenderer.invoke('ping'),

  /**
   * Debug-only: drives the full screen-capture → Claude pipeline with a
   * static transcript. Will be removed once the real voice flow is wired.
   */
  debugAsk: (req: DebugAskRequest): Promise<DebugAskResponse | DebugAskError> =>
    ipcRenderer.invoke('debug-ask', req),

  // ── Companion state machine ──────────────────────────────────────────

  /**
   * Subscribe to companion events (voice state changes, transcripts,
   * response text, pointing decisions, TTS signals, errors).
   * Returns an unsubscribe callback.
   */
  onCompanionEvent: (handler: (event: CompanionEvent) => void): (() => void) => {
    const wrapped = (_e: Electron.IpcRendererEvent, event: CompanionEvent): void =>
      handler(event)
    ipcRenderer.on('companion-event', wrapped)
    return () => ipcRenderer.removeListener('companion-event', wrapped)
  },

  /** Start listening for voice input (manual mode). */
  startListening: (): void => {
    ipcRenderer.send('companion:start-listening')
  },

  /** Stop listening and process the transcript (manual mode). */
  stopListening: (): void => {
    ipcRenderer.send('companion:stop-listening')
  },

  /** Change the active Claude model. */
  setModel: (model: ClickyModel): void => {
    ipcRenderer.send('companion:set-model', model)
  },

  /** Switch between automatic (always-listening) and manual (mic button) mode. */
  setListeningMode: (mode: ListeningMode): void => {
    ipcRenderer.send('companion:set-listening-mode', mode)
  },

  /** Clear conversation history. */
  clearHistory: (): void => {
    ipcRenderer.send('companion:clear-history')
  },

  // ── Audio capture (renderer → main) ─────────────────────────────────

  /**
   * Send a PCM16 audio chunk from the renderer's mic capture to main.
   * The chunk is an ArrayBuffer (structured clone across IPC).
   */
  sendAudioChunk: (chunk: ArrayBuffer): void => {
    ipcRenderer.send('audio-chunk', chunk)
  },

  // ── TTS playback ────────────────────────────────────────────────────

  /**
   * Subscribe to TTS audio data pushed from main. The handler receives
   * a base64-encoded audio string + MIME type for <audio> playback.
   * Returns an unsubscribe callback.
   */
  onTTSAudio: (
    handler: (data: { audioBase64: string; mimeType: string }) => void
  ): (() => void) => {
    const wrapped = (
      _e: Electron.IpcRendererEvent,
      data: { audioBase64: string; mimeType: string }
    ): void => handler(data)
    ipcRenderer.on('tts-audio', wrapped)
    return () => ipcRenderer.removeListener('tts-audio', wrapped)
  },

  /** Tell main that TTS playback finished (so companion can transition to idle). */
  ttsPlaybackEnded: (): void => {
    ipcRenderer.send('tts-playback-ended')
  },

  // ── Overlay: pointing ───────────────────────────────────────────────

  /**
   * Overlay-only: subscribe to pointing targets emitted by main when Claude
   * decides to point. The handler fires the bezier-arc flight animation.
   * Returns an unsubscribe callback.
   */
  onPointAt: (handler: (target: PointAtTarget) => void): (() => void) => {
    const wrapped = (_e: Electron.IpcRendererEvent, target: PointAtTarget): void =>
      handler(target)
    ipcRenderer.on('point-at', wrapped)
    return () => ipcRenderer.removeListener('point-at', wrapped)
  },

  // ── Overlay: cursor following ───────────────────────────────────────

  /**
   * Subscribe to mouse position updates for the idle cursor-follow animation.
   * Returns an unsubscribe callback.
   */
  onMousePosition: (handler: (pos: { x: number; y: number }) => void): (() => void) => {
    const wrapped = (_e: Electron.IpcRendererEvent, pos: { x: number; y: number }): void =>
      handler(pos)
    ipcRenderer.on('mouse-position', wrapped)
    return () => ipcRenderer.removeListener('mouse-position', wrapped)
  },

  // ── Status bar: listening mode ──────────────────────────────────────

  /**
   * Subscribe to listening mode changes (manual ↔ automatic).
   * Used by the status bar to show "Always on" vs "Listening".
   */
  onListeningModeChange: (handler: (mode: ListeningMode) => void): (() => void) => {
    const wrapped = (_e: Electron.IpcRendererEvent, mode: ListeningMode): void =>
      handler(mode)
    ipcRenderer.on('listening-mode-changed', wrapped)
    return () => ipcRenderer.removeListener('listening-mode-changed', wrapped)
  },

  // ── Audio level for waveform reactivity ─────────────────────────────

  /**
   * Subscribe to real-time audio power level (0..1) computed from mic input.
   * Used by waveform bars to react to actual voice volume.
   */
  onAudioLevel: (handler: (level: number) => void): (() => void) => {
    const wrapped = (_e: Electron.IpcRendererEvent, level: number): void =>
      handler(level)
    ipcRenderer.on('audio-level', wrapped)
    return () => ipcRenderer.removeListener('audio-level', wrapped)
  }
}

/** Target shape pushed to the overlay renderer; mirrors OverlayPointTarget in main. */
export interface PointAtTarget {
  x: number
  y: number
  label: string
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI)
    contextBridge.exposeInMainWorld('clicky', api)
  } catch (error) {
    console.error('preload contextBridge failed:', error)
  }
} else {
  // @ts-ignore — fallback for non-isolated environments
  window.electron = electronAPI
  // @ts-ignore
  window.clicky = api
}

export type ClickyAPI = typeof api

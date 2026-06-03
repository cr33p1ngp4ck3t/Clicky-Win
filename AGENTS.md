# Clicky (Windows) - Agent Instructions

<!-- This is the single source of truth for all AI coding agents. CLAUDE.md is a symlink to this file. -->
<!-- AGENTS.md spec: https://github.com/agentsmd/agents.md — supported by Claude Code, Cursor, Copilot, Gemini CLI, and others. -->

## Overview

Windows tray companion app. Lives entirely in the Windows system tray (no taskbar icon, no main window). Clicking the tray icon opens a custom floating panel with companion voice controls. Uses a global push-to-talk hotkey (`Ctrl + Alt`) to capture voice input even when in the background, transcribes it via AssemblyAI streaming, and sends the transcript + a screenshot of the user's screen to Claude. Claude responds with text (streamed) and voice (ElevenLabs TTS). A blue cursor overlay flies to and points at UI elements Claude references on any connected monitor.

## Architecture

- **App Type**: System tray-only (`skipTaskbar: true`), no standard main window
- **Framework**: Electron (Main/Renderer) + React + TypeScript + Vite
- **Pattern**: Component state + IPC bridging for logic (Main process is the source of truth)
- **AI Chat**: Claude (Sonnet 4.6 / Opus 4.8) via direct API keys (or optional worker URL)
- **Speech-to-Text**: AssemblyAI real-time streaming (`u3-rt-pro` model) via v3 WebSocket API
- **Text-to-Speech**: ElevenLabs (`eleven_flash_v2_5` model) via direct API key
- **Screen Capture**: Electron `desktopCapturer` APIs, multi-monitor support
- **Voice Input**: Push-to-talk via global system hooks (`uiohook-napi`) capturing `Ctrl + Alt`. Browser `MediaRecorder` captures audio, sends PCM16 buffers to Main over IPC.
- **Element Pointing**: Claude embeds `[POINT:x,y:label:screenN]` tags in responses. The overlay parses these, maps coordinates to the correct monitor, and animates the blue cursor along a bezier arc to the target.
- **Concurrency**: Node.js event loop in Main; React hooks + Context in Renderer.

### Key Architecture Decisions

**Tray App Pattern**: The app uses Electron's `Tray` module for the system tray icon and a custom borderless `BrowserWindow` for the floating control panel. `skipTaskbar: true` prevents it from showing up in the Alt-Tab switcher or taskbar. The panel auto-dismisses on `blur` events (clicking outside).

**Overlay Window**: A full-screen, transparent, click-through `BrowserWindow` hosts the blue cursor companion. It joins all displays via `setIgnoreMouseEvents(true)` and `setAlwaysOnTop(true, 'screen-saver')`. The cursor position, response text, and pointing animations all render in this overlay via React and CSS animations.

**Global Push-To-Talk Shortcut**: Background push-to-talk uses `uiohook-napi` instead of Electron's `globalShortcut`. Electron's native module only fires on keydown, whereas `uiohook-napi` intercepts raw OS events globally, allowing detection of `keydown` (start listening) and `keyup` (stop listening) for `Ctrl + Alt`.

**Mock Mode**: The app falls back to a "Mock Test Mode" if API keys are missing. This instantiates Mock versions of the Claude, TTS, and Transcription services to simulate a complete conversational turn, allowing UI/UX development without burning API credits.

## Key Files

| File | Lines | Purpose |
|------|-------|---------|
| `src/main/index.ts` | ~70 | Main process entry point. Creates tray, registers IPC handlers, enforces single-instance lock, and suppresses default taskbar behaviors. |
| `src/services/companion.ts` | ~200 | Central state machine. Owns voice state (idle/listening/processing/responding), models, history, and coordinates the pipeline (STT → Screenshot → Claude → Pointing → TTS). |
| `src/main/tray.ts` | ~90 | System tray lifecycle. Creates the icon, handles left-click to toggle the panel (calculating position relative to tray), and auto-hides on blur. |
| `src/main/windows/panel-window.ts` | ~45 | Creates the floating React panel window (`skipTaskbar: true`, borderless, transparent). |
| `src/main/windows/overlay-window.ts` | ~55 | Creates the full-screen click-through overlay window for the cursor. |
| `src/renderer/src/panel/Panel.tsx` | ~300 | React panel UI. Shows companion status, mic button, model picker (Sonnet/Opus), and settings. Uses standard CSS for styling. |
| `src/renderer/src/overlay/Overlay.tsx` | ~230 | React overlay UI. Renders the blue cursor, speech bubble, and handles bezier animation using Framer Motion or pure CSS transitions. |
| `src/main/screen-capture.ts` | ~100 | Multi-monitor screenshot capture using `desktopCapturer`. Matches displays to `screen.getAllDisplays()`. |
| `src/services/transcription/assemblyai.ts` | ~150 | AssemblyAI streaming STT. Mints tokens via v3 GET API, manages the WebSocket, sends base64 PCM audio, and parses Turn messages. |
| `src/renderer/src/panel/audio-recorder.ts`| ~80 | Browser microphone capture via `MediaRecorder` or `AudioWorklet`. Emits raw buffers to Main via IPC. |
| `src/main/shortcut-monitor.ts` | ~50 | Global Push-to-Talk monitor via `uiohook-napi`. Detects `Ctrl+Alt` press and release. |
| `src/services/claude.ts` | ~150 | Anthropic API client. Handles image encoding, `[POINT]` tag parsing, and SSE streaming. |
| `src/services/tts.ts` | ~50 | ElevenLabs TTS client. Returns base64 audio for playback in the renderer. |
| `src/main/ipc-handlers.ts` | ~150 | Routes messages between the React renderer and the Main process services. Wires up mock services if configured. |
| `src/main/config.ts` | ~80 | Central configuration management, reading from `.env` and `store`. |

## Build & Run

```bash
# Install dependencies
npm install

# Run the dev server
npm run dev

# Build for Windows
npm run build:win

# Run typechecking
npm run typecheck
```

**Note on native modules**: The app uses `uiohook-napi`, which may require a C++ build toolchain on Windows if pre-built binaries are unavailable for your Node version.

## Code Style & Conventions

### Variable and Method Naming

IMPORTANT: Follow these naming rules strictly. Clarity is the top priority.

- Be as clear and specific with variable and method names as possible
- **Optimize for clarity over concision.** A developer with zero context on the codebase should immediately understand what a variable or method does just from reading its name
- Use longer names when it improves clarity. Do NOT use single-character variable names
- When passing props or arguments to functions, keep the same names as the original variable. Do not shorten or abbreviate parameter names.

### Code Clarity

- **Clear is better than clever.** Do not write functionality in fewer lines if it makes the code harder to understand
- Write more lines of code if additional lines improve readability and comprehension
- When a variable or method name alone cannot fully explain something, add a comment explaining what is happening and why

### React/Electron Conventions

- Use React for all UI rendering in the Renderer process.
- All heavy processing, filesystem access, native hooks, and direct API calls happen in the **Main process** (in `src/services/`).
- State is synchronized from Main to Renderer via IPC events (e.g., `window.clicky.onEvent`).
- Do not import Main process code directly into the Renderer.
- CSS should use standard selectors; no Tailwind unless requested.

### Do NOT

- Do not add features, refactor code, or make "improvements" beyond what was asked
- Do not add docstrings, comments, or type annotations to code you did not change
- Do not re-architect the IPC layer unless explicitly required.

## Self-Update Instructions

<!-- AI agents: follow these instructions to keep this file accurate. -->

When you make changes to this project that affect the information in this file, update this file to reflect those changes. Specifically:

1. **New files**: Add new source files to the "Key Files" table with their purpose and approximate line count
2. **Deleted files**: Remove entries for files that no longer exist
3. **Architecture changes**: Update the architecture section if you introduce new patterns, frameworks, or significant structural changes
4. **Build changes**: Update build commands if the build process changes
5. **New conventions**: If the user establishes a new coding convention during a session, add it to the appropriate conventions section
6. **Line count drift**: If a file's line count changes significantly (>50 lines), update the approximate count in the Key Files table

Do NOT update this file for minor edits, bug fixes, or changes that don't affect the documented architecture or conventions.

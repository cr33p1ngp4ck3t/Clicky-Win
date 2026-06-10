# clicky-win

Windows port of [Clicky](https://github.com/cr33p1ngp4ck3t/my-clicky) — an AI buddy that lives next to your cursor, can see your screen, talk to you, and point at things.

The original is a Swift/SwiftUI/AppKit macOS app. This is a from-scratch reimplementation in Electron + TypeScript + React, targeting Windows 10/11.

## Stack

- Electron 39
- React 19
- TypeScript 5.9
- Vite 7 (via `electron-vite`)
- `@anthropic-ai/sdk` for Claude integration

See `../vault/windows-mapping/02-stack-decision.md` for why this stack.

## Project layout

```
src/
├── main/                  # Electron main process
│   ├── index.ts           # entry — tray, windows, IPC
│   ├── tray.ts            # NotifyIcon-equivalent + click-to-toggle panel
│   └── windows/
│       ├── panel-window.ts    # dropdown BrowserWindow factory
│       └── overlay-window.ts  # click-through overlay BrowserWindow factory
├── preload/               # contextBridge surface for both renderers
│   ├── index.ts
│   └── index.d.ts
├── renderer/              # served by Vite
│   ├── panel.html         # dropdown entry
│   ├── overlay.html       # overlay entry
│   └── src/
│       ├── shared/
│       │   └── design-system.css   # color / spacing / type tokens
│       ├── panel/
│       │   ├── main.tsx            # panel ReactDOM root
│       │   ├── panel.css
│       │   └── Panel.tsx
│       └── overlay/
│           ├── main.tsx            # overlay ReactDOM root
│           ├── overlay.css
│           └── Overlay.tsx
├── services/              # cross-process business logic (TBD)
│   └── transcription/
└── shared/
    └── types.ts           # types used everywhere (VoiceState, ClickyModel, …)
```

## Scripts

```bash
npm install          # one-time
npm run dev          # hot-reload dev mode
npm run typecheck    # tsc --noEmit on both node + web tsconfigs
npm run build        # production build to out/
npm run build:win    # build + electron-builder NSIS/MSI installer
```

## Architecture notes

- **Two `BrowserWindow`s, one preload.** The panel and the overlay share `src/preload/index.ts` and the `window.clicky` IPC surface, but render different HTML entries (`panel.html` / `overlay.html`) configured in `electron.vite.config.ts`.
- **No main app window.** Clicky is tray-only; closing all windows does *not* quit the app (handled in `src/main/index.ts`).
- **Overlay spans the virtual screen.** Single window covers the bounding rect of all monitors, with `setIgnoreMouseEvents(true)` so clicks pass through. Reacts to `display-added/removed/metrics-changed` to handle hot-plug.
- **All OS work in main.** Audio, screen capture, hotkey, HTTP — every OS-touching service lives in the main process; renderers call into it via typed IPC.

See `../vault/` for the full design notes.

## Manually testing the Claude pipeline

The panel has a temporary **"debug: ask Claude"** button that drives the full pipeline (capture → Claude → result) with a static prompt. To use it:

1. Get an Anthropic API key (or set up the Cloudflare Worker — TBD).
2. Create a `.env` file in this directory with one of:
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   # or, preferred in production:
   CLICKY_WORKER_URL=https://clicky-worker.<subdomain>.workers.dev
   ```
3. `npm run dev`
4. Click the tray icon → click "debug: ask Claude".
5. The panel and overlay hide, all displays get captured, Claude responds, and the answer + pointing decision is shown in the panel's debug output area.

Note: `.env` is read by Electron's main process at startup via `process.env`. If you start dev with a parent shell that already exported the variables, you don't need a `.env`.

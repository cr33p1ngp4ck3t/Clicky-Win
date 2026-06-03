/**
 * Claude API service — the brain of Clicky.
 *
 * One call per conversation turn:
 *   user transcript + N screenshots → streamed text + a pointing decision.
 *
 * Modernization vs the original Swift app:
 *   - Uses the official @anthropic-ai/sdk instead of hand-rolled URLSession +
 *     SSE parsing.
 *   - Tool use (point_at / dont_point) instead of the [POINT:x,y:label:screenN]
 *     regex sentinel — see claude-pointing-tool.ts for the why.
 *   - Adaptive thinking enabled, which lets Claude spend extra tokens on
 *     tricky-to-find UI elements but stay snappy for "where's the save button"
 *     style questions.
 *   - Prompt caching on the system block — every turn after the first reuses
 *     the cached prefix, which is meaningful since the prompt is ~1.5k tokens.
 *
 * See vault/api-integrations/01-anthropic-messages.md for the full design.
 */

import Anthropic from '@anthropic-ai/sdk'
import type {
  BetaMessageParam,
  BetaTextBlockParam,
  BetaImageBlockParam,
  BetaContentBlockParam
} from '@anthropic-ai/sdk/resources/beta'
import type { ClickyModel, ConversationTurn, DisplayCapture, PointingResult } from '../shared/types'
import { CLICKY_SYSTEM_PROMPT } from './claude-prompt'
import { buildPointingTools } from './claude-pointing-tool'

/**
 * Required betas:
 *   - context-management-2025-06-27 powers the SDK's tool runner loop.
 *   - extended-cache-ttl-2025-04-11 keeps the cached system prompt around
 *     long enough that it survives the user thinking between turns.
 */
const BETA_HEADERS = ['context-management-2025-06-27', 'extended-cache-ttl-2025-04-11']

/** Hard cap so a runaway tool-use loop can't burn through tokens. */
const MAX_TOKENS_PER_TURN = 1024

export interface ClaudeServiceConfig {
  /**
   * Either a direct Anthropic API key (dev / testing) or — preferred — a
   * Cloudflare Worker proxy URL so the key never ships in the binary.
   * When `workerBaseURL` is set, it overrides `apiKey` and points the SDK at
   * the worker; the worker injects the real key server-side.
   */
  apiKey?: string
  workerBaseURL?: string
}

export interface RespondParams {
  /** Currently selected model — driven by the panel's model picker. */
  model: ClickyModel
  /** What the user just said (post-STT). */
  userTranscript: string
  /** Past turns this session. Caller decides how far back to send. */
  history: ConversationTurn[]
  /** Screenshots — one per monitor, primary screen first. */
  screens: DisplayCapture[]
  /** Optional abort — wired to the panel's "cancel" button later. */
  signal?: AbortSignal
  /**
   * Optional streaming hook so the renderer can show the text as it arrives.
   * Called once per delta with the new fragment. The TTS pipeline takes the
   * final concatenated string from the returned Promise, not these deltas.
   */
  onTextDelta?: (delta: string) => void
}

export interface RespondResult {
  /** The full assistant text — what TTS will speak. */
  text: string
  /** Pointing decision from the tool call. */
  pointing: PointingResult
}

/**
 * Build a configured Claude client. One per app instance — the SDK manages
 * its own connection pool, no reason to construct ad hoc.
 */
export function createClaudeService(config: ClaudeServiceConfig): ClaudeService {
  // If neither a worker proxy nor a direct API key is configured, return a
  // small stub that surfaces a clear error when used. This prevents the
  // Anthropic SDK from throwing its low-level "Could not resolve authentication" error
  // during client construction or the first call.
  if (!config.workerBaseURL && !config.apiKey) {
    const msg =
      'Anthropic not configured: set ANTHROPIC_API_KEY or CLICKY_WORKER_URL (worker proxy) in environment or .env'
    console.warn('[claude] ' + msg)
    const stub = {
      async respond(_params: RespondParams): Promise<RespondResult> {
        throw new Error(msg)
      }
    } as unknown as ClaudeService
    return stub
  }

  const client = new Anthropic({
    // When proxying through the worker, the worker is responsible for the
    // real Authorization header. We still pass a placeholder so the SDK
    // doesn't refuse to construct.
    apiKey: config.workerBaseURL ? 'worker-proxy' : (config.apiKey ?? undefined),
    baseURL: config.workerBaseURL,
    // Electron's main process is Node, but the SDK still defaults to
    // dangerouslyAllowBrowser=false there which is correct — leaving alone.
    defaultHeaders: {
      'anthropic-beta': BETA_HEADERS.join(',')
    }
  })
  return new ClaudeService(client)
}

export class ClaudeService {
  constructor(private readonly client: Anthropic) {}

  /**
   * Run one conversation turn. Streams text via `onTextDelta` if provided,
   * and resolves with the full text + pointing decision once the model
   * stops (after calling exactly one of the two pointing tools).
   */
  async respond(params: RespondParams): Promise<RespondResult> {
    const { model, userTranscript, history, screens, signal, onTextDelta } = params

    // `getSpokenText` is a thunk so the tool's run() callback can read the
    // most-recent accumulated text at the moment the tool fires — we don't
    // know it up front.
    let accumulatedText = ''
    const { tools, readDecision } = buildPointingTools(() => accumulatedText)

    const messages: BetaMessageParam[] = [
      ...historyToMessages(history),
      {
        role: 'user',
        content: buildUserContent(userTranscript, screens)
      }
    ]

    // toolRunner handles the assistant ↔ tool-call ↔ tool-result loop for us.
    // In Clicky's case the loop should be exactly one iteration: assistant
    // emits text + a tool_use, we return "ok", assistant emits stop_reason
    // end_turn. We still use the runner so we get correct retry / error
    // handling for free.
    const runner = this.client.beta.messages.toolRunner({
      model,
      max_tokens: MAX_TOKENS_PER_TURN,
      // Cache the prompt — every subsequent turn reuses this prefix.
      system: [
        {
          type: 'text',
          text: CLICKY_SYSTEM_PROMPT,
          cache_control: { type: 'ephemeral', ttl: '1h' }
        } satisfies BetaTextBlockParam
      ],
      messages,
      tools,
      // Force a tool call — the model is required to either point or
      // explicitly decline. No "I forgot to call a tool" failure mode.
      tool_choice: { type: 'any' },
      // Adaptive thinking — the model decides per-turn how much to think.
      // Fast for "where's the save button", slower for tricky UI lookups.
      thinking: { type: 'adaptive' },
      stream: true
    })

    if (signal) {
      runner.setRequestOptions({ signal })
    }

    // Iterate every message stream the runner produces. Usually one (the
    // assistant's reply); could be more if a tool_use → tool_result round-trip
    // happens, which for us is fine — we still concatenate all text.
    for await (const stream of runner) {
      stream.on('text', (delta) => {
        accumulatedText += delta
        onTextDelta?.(delta)
      })
      // Wait for this stream to finish before pulling the next one off the
      // runner — otherwise we'd race the tool runner's internal state.
      await stream.finalMessage()
    }

    return {
      text: accumulatedText.trim(),
      pointing: readDecision().result
    }
  }
}

/**
 * Map conversation history into Anthropic's message format. Each prior
 * turn becomes one user + one assistant message. We deliberately drop
 * screenshots from old turns — they balloon token usage fast, and the model
 * almost never needs them once a follow-up is asked. The original Swift app
 * does the same.
 */
function historyToMessages(history: ConversationTurn[]): BetaMessageParam[] {
  const out: BetaMessageParam[] = []
  for (const turn of history) {
    out.push({ role: 'user', content: turn.userTranscript })
    out.push({ role: 'assistant', content: turn.assistantResponse })
  }
  return out
}

/**
 * Build the multimodal content for the current user turn:
 *
 *   [ image_screen_1, "label of screen 1",
 *     image_screen_2, "label of screen 2",
 *     ...,
 *     "What the user said." ]
 *
 * Putting the label after each image (rather than before) is what the
 * original app does and what Anthropic's vision docs recommend — the model
 * reads better when the descriptor immediately follows the image.
 */
function buildUserContent(
  userTranscript: string,
  screens: DisplayCapture[]
): BetaContentBlockParam[] {
  const blocks: BetaContentBlockParam[] = []

  // Primary screen first, then the rest in screen-number order. Models
  // pay slightly more attention to earlier images in the sequence.
  const sorted = [...screens].sort((a, b) => {
    if (a.isPrimary !== b.isPrimary) return a.isPrimary ? -1 : 1
    return a.screenNumber - b.screenNumber
  })

  for (const screen of sorted) {
    const image: BetaImageBlockParam = {
      type: 'image',
      source: {
        type: 'base64',
        media_type: screen.mediaType,
        data: bufferToBase64(screen.imageData)
      }
    }
    blocks.push(image)
    blocks.push({ type: 'text', text: screen.label })
  }

  blocks.push({ type: 'text', text: userTranscript })
  return blocks
}

/**
 * Base64-encode a Uint8Array. We avoid `Buffer.from(...).toString('base64')`
 * even though this code runs in main (Node), to keep the service itself
 * runtime-agnostic in case we ever move part of it to the renderer.
 */
function bufferToBase64(data: Uint8Array): string {
  // Chunked to avoid the "too many arguments" stack limit on String.fromCharCode
  // when applied to multi-MB screenshots.
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < data.length; i += chunkSize) {
    const slice = data.subarray(i, i + chunkSize)
    binary += String.fromCharCode.apply(null, Array.from(slice))
  }
  // btoa exists in both Node 18+ and Electron renderers.
  return typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(binary, 'binary').toString('base64')
}

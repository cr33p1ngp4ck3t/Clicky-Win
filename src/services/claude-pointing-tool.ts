/**
 * The `point_at` and `dont_point` tools — replacement for the original Swift
 * app's `[POINT:x,y:label:screenN]` regex protocol.
 *
 * Why tool use instead of regex? The Anthropic SDK validates tool inputs
 * against the JSON schema before they reach our code, which gives us:
 *   - typed `screen` integers (no more parsing screen0/screenN strings)
 *   - typed coordinates (no NaN risk from string→Number)
 *   - "don't point" becomes a separate tool call, not a sentinel
 *   - the model is structurally guaranteed to pick exactly one path
 *
 * See vault/api-integrations/02-pointing-protocol.md for the original
 * protocol this replaces.
 */

// Use Zod's v4-compat subpath. The Anthropic SDK's betaZodTool internally
// `require("zod/v4")` and reads the v4-style `.def` schema property — passing
// a v3 schema crashes with "Cannot read properties of undefined (reading 'def')".
import { z } from 'zod/v4'
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod'
import type { PointingResult } from '../shared/types'

export const pointAtInputSchema = z.object({
  x: z
    .number()
    .int()
    .describe(
      'Pixel x coordinate in the screenshot coordinate space. The image label tells you the dimensions; (0,0) is the top-left corner; x increases rightward.'
    ),
  y: z
    .number()
    .int()
    .describe(
      'Pixel y coordinate in the screenshot coordinate space. (0,0) is the top-left corner; y increases downward.'
    ),
  label: z
    .string()
    .min(1)
    .max(40)
    .describe(
      'Short 1-3 word description of the element (e.g. "search bar", "save button"). Used as an accessibility hint on the overlay.'
    ),
  screen: z
    .number()
    .int()
    .min(1)
    .describe(
      'The screen number (1-based) where the element lives. 1 = "primary focus" (the cursor\'s screen). Use the screen numbers from the image labels.'
    )
})
export type PointAtInput = z.infer<typeof pointAtInputSchema>

export const dontPointInputSchema = z.object({})
export type DontPointInput = z.infer<typeof dontPointInputSchema>

/**
 * Result of resolving the tool calls Claude made during one turn. The
 * orchestrator (companion state machine) reads this and triggers the overlay
 * animation accordingly.
 */
export interface PointingDecision {
  /** What the cursor should do this turn. */
  result: PointingResult
}

/**
 * Build the two tools, each with a `run` callback that captures a single
 * mutable `decision` cell. The tool runner invokes whichever Claude calls,
 * and the resulting decision is read after the run completes.
 *
 * We treat the tools as "report" tools rather than "do" tools — they don't
 * cause side effects themselves, they just record Claude's choice for the
 * orchestrator to act on.
 */
export function buildPointingTools(spokenText: () => string): {
  tools: ReturnType<typeof betaZodTool>[]
  readDecision: () => PointingDecision
} {
  let captured: PointingResult = {
    spokenText: '',
    coordinate: null,
    elementLabel: null,
    screenNumber: null
  }

  const pointAtTool = betaZodTool({
    name: 'point_at',
    description:
      "Make the blue cursor fly to a UI element on screen. Use this whenever pointing would genuinely help — when the user is asking how to do something, looking for a menu, trying to find a button, or navigating an app. Err on the side of pointing rather than not pointing.",
    // Cast bridges the SDK .d.ts (declares ZodType from v3 type space) with
    // the actual runtime expectation of a v4 schema. See the zod/v4 import
    // comment above — the SDK's runtime path does `require("zod/v4")` and
    // reads `.def`, so a v4 schema is what works; only the types disagree.
    // `as any` (not `as never`) — `as never` poisons inference downstream
    // and the resulting BetaRunnableTool<never> won't fit the tools array.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inputSchema: pointAtInputSchema as any,
    run: async (input: PointAtInput) => {
      captured = {
        spokenText: spokenText(),
        coordinate: { x: input.x, y: input.y },
        elementLabel: input.label,
        screenNumber: input.screen
      }
      // The tool result Claude sees — short, confirms the action so it can
      // close out the turn without overthinking.
      return 'ok'
    }
  })

  const dontPointTool = betaZodTool({
    name: 'dont_point',
    description:
      "Call this when pointing wouldn't help — general knowledge questions, conversations not tied to what's on screen, or when the answer is already self-contained without needing a visual reference.",
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    inputSchema: dontPointInputSchema as any,
    run: async () => {
      captured = {
        spokenText: spokenText(),
        coordinate: null,
        elementLabel: null,
        screenNumber: null
      }
      return 'ok'
    }
  })

  return {
    tools: [pointAtTool, dontPointTool],
    readDecision: () => ({ result: captured })
  }
}

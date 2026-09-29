/**
 * Credential-free `ModelProvider` for smoke tests (`BRAIN_MODEL_MOCK=1`):
 * a canned chat reply, `{"candidates": []}` for the extractor and
 * `{"operations": []}` for the planner. Calls are discriminated by their
 * system prompt; the chat prompt is matched by prefix because retrieved
 * context is appended after the stable part.
 */
import type { ModelCompleteInput } from "../core/types";
import { MockModelProvider } from "../extract/extractor";
import { EXTRACTOR_SYSTEM_PROMPT } from "../extract/prompts";
import { PLANNER_SYSTEM_PROMPT } from "../plan/prompts";
import { CHAT_SYSTEM_PROMPT } from "./chat";

export const MOCK_CHAT_REPLY = "(mock reply) I'm a stand-in model; set ANTHROPIC_API_KEY and unset BRAIN_MODEL_MOCK to talk to Claude.";

export const MOCK_STREAM_WORDS_PER_CHUNK = 5;
export const MOCK_STREAM_DELAY_MS = 10;

/** Split `text` into chunks of `words` whitespace-delimited words; whitespace is preserved so the chunks concatenate back to `text`. */
export function chunkWords(text: string, words = MOCK_STREAM_WORDS_PER_CHUNK): string[] {
  const tokens = text.match(/\S+\s*|\s+/g) ?? [];
  const out: string[] = [];
  for (let i = 0; i < tokens.length; i += words) out.push(tokens.slice(i, i + words).join(""));
  return out;
}

/**
 * `MockModelProvider` that also streams: the scripted reply is delivered in
 * ~5-word chunks with a short delay between them so the REPL visibly streams
 * under `BRAIN_MODEL_MOCK=1`. `complete` (used by the extractor/planner) is
 * unchanged, and `stream` goes through it so `calls` records one entry per turn.
 */
export class StreamingMockModelProvider extends MockModelProvider {
  private readonly delayMs: number;

  constructor(responder: ConstructorParameters<typeof MockModelProvider>[0], delayMs = MOCK_STREAM_DELAY_MS) {
    super(responder);
    this.delayMs = delayMs;
  }

  async stream(input: ModelCompleteInput, onDelta: (text: string) => void): Promise<string> {
    const text = await this.complete(input);
    const chunks = chunkWords(text);
    for (let i = 0; i < chunks.length; i += 1) {
      if (i > 0 && this.delayMs > 0) await new Promise((r) => setTimeout(r, this.delayMs));
      onDelta(chunks[i]!);
    }
    return text;
  }
}

export function createMockModelProvider(reply = MOCK_CHAT_REPLY, delayMs = MOCK_STREAM_DELAY_MS): StreamingMockModelProvider {
  return new StreamingMockModelProvider((input) => {
    if (input.system === EXTRACTOR_SYSTEM_PROMPT) return '{"candidates": []}';
    if (input.system === PLANNER_SYSTEM_PROMPT) return '{"operations": []}';
    if (input.system.startsWith(CHAT_SYSTEM_PROMPT)) return reply;
    return reply;
  }, delayMs);
}

export function mockModelRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env["BRAIN_MODEL_MOCK"] ?? "").trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false";
}

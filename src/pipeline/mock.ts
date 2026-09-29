/**
 * Credential-free `ModelProvider` for smoke tests (`BRAIN_MODEL_MOCK=1`):
 * a canned chat reply, `{"candidates": []}` for the extractor and
 * `{"operations": []}` for the planner. Calls are discriminated by their
 * system prompt; the chat prompt is matched by prefix because retrieved
 * context is appended after the stable part.
 */
import { MockModelProvider } from "../extract/extractor";
import { EXTRACTOR_SYSTEM_PROMPT } from "../extract/prompts";
import { PLANNER_SYSTEM_PROMPT } from "../plan/prompts";
import { CHAT_SYSTEM_PROMPT } from "./chat";

export const MOCK_CHAT_REPLY = "(mock reply) I'm a stand-in model; set ANTHROPIC_API_KEY and unset BRAIN_MODEL_MOCK to talk to Claude.";

export function createMockModelProvider(reply = MOCK_CHAT_REPLY): MockModelProvider {
  return new MockModelProvider((input) => {
    if (input.system === EXTRACTOR_SYSTEM_PROMPT) return '{"candidates": []}';
    if (input.system === PLANNER_SYSTEM_PROMPT) return '{"operations": []}';
    if (input.system.startsWith(CHAT_SYSTEM_PROMPT)) return reply;
    return reply;
  });
}

export function mockModelRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env["BRAIN_MODEL_MOCK"] ?? "").trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false";
}

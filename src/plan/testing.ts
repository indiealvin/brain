/**
 * Test double for `ModelProvider`: replays a queue of scripted responses and
 * records every call so tests can assert on the prompt that was sent.
 */
import type { ModelProvider } from "../core/types";

export type ModelCall = Parameters<ModelProvider["complete"]>[0];

export class ScriptedModelProvider implements ModelProvider {
  readonly calls: ModelCall[] = [];
  private readonly responses: string[];

  constructor(responses: string[] = []) {
    this.responses = [...responses];
  }

  /** Queue another response. */
  push(...responses: string[]): void {
    this.responses.push(...responses);
  }

  get remaining(): number {
    return this.responses.length;
  }

  async complete(input: ModelCall): Promise<string> {
    this.calls.push(input);
    const next = this.responses.shift();
    if (next === undefined) throw new Error("ScriptedModelProvider: no scripted response left");
    return next;
  }
}

/**
 * A local stand-in for the OpenRouter API (`/auth/key`, `/models`), so a
 * live `doctor.run` check makes real HTTP calls without the network, and a
 * test can hold a call open: a pending request to cancel, or work for
 * `shutdown` to wait on.
 *
 * Steps:
 * - `openrouterStub.start {as, hold?: [path…]}`: start the stub; `as` is the
 *   base URL the transcript uses for it (e.g. "http://openrouter.stub"), mapped
 *   to the real `http://127.0.0.1:<port>`. Requests to a `hold` path wait
 *   until it is released.
 * - `openrouterStub.awaitRequest {path}`: wait until the stub has received a
 *   request for `path` (so the server's call is in flight).
 * - `openrouterStub.release {path}`: answer held and future requests for `path`.
 * - `openrouterStub.expectRequests {paths}`: the paths received so far, in order, equal `paths`.
 */
import { DEFAULT_OPENROUTER_MODEL } from "../../../src/model/openrouter";
import { registerStep, sleep, stepString, stepStrings, type StepContext } from "./steps";

export interface OpenRouterStub {
  readonly url: string;
  /** Paths received, in order. */
  readonly requests: string[];
  release(path: string): void;
  stop(): void;
}

export function startOpenRouterStub(hold: string[] = []): OpenRouterStub {
  const held = new Map<string, { promise: Promise<void>; release: () => void }>();
  for (const path of hold) {
    let release!: () => void;
    const promise = new Promise<void>((r) => {
      release = r;
    });
    held.set(path, { promise, release });
  }
  const requests: string[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const path = new URL(req.url).pathname;
      requests.push(path);
      await held.get(path)?.promise;
      if (path === "/auth/key") return Response.json({ data: { label: "openrouter stub" } });
      if (path === "/models") return Response.json({ data: [{ id: DEFAULT_OPENROUTER_MODEL }] });
      return new Response("not found", { status: 404 });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    requests,
    release: (path) => held.get(path)?.release(),
    stop: () => void server.stop(true),
  };
}

function stub(ctx: StepContext): OpenRouterStub {
  const s = ctx.state.get("openrouterStub");
  if (s === undefined) throw new Error("openrouterStub.start has not run");
  return s as OpenRouterStub;
}

registerStep("openrouterStub.start", (step, ctx) => {
  const hold = Array.isArray(step["hold"]) ? stepStrings(step, "hold") : [];
  const s = startOpenRouterStub(hold);
  ctx.state.set("openrouterStub", s);
  ctx.defer(() => {
    for (const path of hold) s.release(path);
    s.stop();
  });
  ctx.alias(stepString(step, "as"), s.url);
});

registerStep("openrouterStub.awaitRequest", async (step, ctx) => {
  const path = stepString(step, "path");
  const s = stub(ctx);
  const deadline = Date.now() + 20_000;
  while (!s.requests.includes(path)) {
    if (Date.now() > deadline) throw new Error(`openrouterStub: no request for ${path} (got ${JSON.stringify(s.requests)})`);
    await sleep(10);
  }
});

registerStep("openrouterStub.release", (step, ctx) => {
  stub(ctx).release(stepString(step, "path"));
});

registerStep("openrouterStub.expectRequests", (step, ctx) => {
  const want = stepStrings(step, "paths");
  const got = stub(ctx).requests;
  if (JSON.stringify(got) !== JSON.stringify(want)) throw new Error(`openrouterStub: expected requests ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
});

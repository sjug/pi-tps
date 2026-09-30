import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import extension from "../src/extension.ts";
import { loadCalibrations, saveCalibrations } from "../src/store.ts";

type Handler = (event: any, ctx: ExtensionContext) => unknown;

/** Minimal fake of the Pi runtime: records handlers, replays events. */
function fakePi(id = "fake") {
  const handlers = new Map<string, Handler[]>();
  const statuses: (string | undefined)[] = [];
  const ctx = {
    hasUI: true,
    model: { provider: "test", id },
    ui: { setStatus: (_key: string, text: string | undefined) => statuses.push(text) },
  } as unknown as ExtensionContext;
  const pi = {
    on: (event: string, handler: Handler) => {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
  } as unknown as ExtensionAPI;
  const emit = (type: string, event: Record<string, unknown> = {}) => {
    for (const h of handlers.get(type) ?? []) h({ type, ...event }, ctx);
  };
  return { pi, emit, statuses, last: () => statuses[statuses.length - 1] };
}

const assistant = (usageOutput: number, reasoning?: number) => ({
  role: "assistant",
  content: [],
  usage: { output: usageOutput, reasoning },
});

function delta(type: string, delta: string) {
  return { assistantMessageEvent: { type, delta } };
}

describe("extension adapter", () => {
  // Fake timers also fake performance.now, so advancing the clock moves both
  // the 200ms tick and the meter's timestamps.
  const previousSettings = process.env.PI_TPS_SETTINGS;
  beforeEach(() => {
    vi.useFakeTimers();
    process.env.PI_TPS_SETTINGS = join(mkdtempSync(join(tmpdir(), "pi-tps-")), "settings.json");
  });
  afterEach(() => {
    vi.useRealTimers();
    if (previousSettings === undefined) delete process.env.PI_TPS_SETTINGS;
    else process.env.PI_TPS_SETTINGS = previousSettings;
  });
  const tick = (ms: number) => vi.advanceTimersByTime(ms);

  it("preserves another session's updated model when both loaded the old map", () => {
    saveCalibrations({
      "test/a": { ratio: 1, samples: 1 },
      "test/b": { ratio: 1, samples: 1 },
    });
    const a = fakePi("a");
    const b = fakePi("b");
    extension(a.pi);
    extension(b.pi);
    for (const session of [a, b]) {
      session.emit("before_provider_request", { payload: {} });
      session.emit("message_start", { message: assistant(0) });
      for (let i = 0; i < 50; i++) {
        session.emit("message_update", delta("text_delta", "!"));
        tick(50);
      }
      session.emit("message_end", { message: assistant(100) });
    }
    const learned = loadCalibrations();
    for (const key of ["test/a", "test/b"]) {
      expect(learned[key]!.samples).toBe(2);
      expect(learned[key]!.ratio).toBeCloseTo(1.3);
    }
  });

  it("replays a full turn and settles on usage.output", () => {
    const { pi, emit, last } = fakePi();
    extension(pi);

    emit("session_start");
    expect(last()).toBeUndefined();

    emit("message_start", { message: { role: "user" } });
    emit("message_end", { message: { role: "user" } });

    emit("before_provider_request", { payload: {} });
    tick(400);
    expect(last()).toBe("τ 0.4s…");

    emit("message_start", { message: assistant(0) });
    tick(50);
    for (let i = 0; i < 20; i++) {
      emit("message_update", { message: assistant(0), ...delta("text_delta", "!") });
      tick(50);
    }
    expect(last()).toMatch(/^τ 450ms  Δ ~\d+ tok\/s$/);

    // 38 tokens over 19 gaps of 50ms.
    emit("message_end", { message: assistant(38) });
    expect(last()).toBe("τ 450ms  Δ 40 tok/s");
  });

  it("ignores message_end for non-assistant roles", () => {
    const { pi, emit, last } = fakePi();
    extension(pi);
    emit("before_provider_request", { payload: {} });
    emit("message_start", { message: assistant(0) });
    for (let i = 0; i < 10; i++) {
      emit("message_update", { message: assistant(0), ...delta("text_delta", "!") });
      tick(50);
    }
    const streaming = last();
    emit("message_end", { message: { role: "toolResult" } });
    emit("message_end", { message: { role: "custom" } });
    expect(last()).toBe(streaming);
    expect(last()).toContain("~");
  });

  it("stops the waiting tick on message_end and agent_end", () => {
    const { pi, emit, statuses } = fakePi();
    extension(pi);
    emit("before_provider_request", { payload: {} });
    tick(600);
    const painted = statuses.length;
    expect(painted).toBeGreaterThan(1);

    emit("message_end", { message: assistant(0) });
    const afterEnd = statuses.length;
    tick(1000);
    expect(statuses.length).toBe(afterEnd);

    emit("before_provider_request", { payload: {} });
    emit("agent_end", { messages: [] });
    const afterAgentEnd = statuses.length;
    tick(1000);
    expect(statuses.length).toBe(afterAgentEnd);
  });

  it("scales the next live rate by this model's learned ratio", () => {
    const { pi, emit, last } = fakePi();
    extension(pi);

    emit("before_provider_request", { payload: {} });
    emit("message_start", { message: assistant(0) });
    for (let i = 0; i < 50; i++) {
      emit("message_update", { message: assistant(0), ...delta("text_delta", "!") });
      tick(50);
    }
    emit("message_end", { message: assistant(100) });

    emit("before_provider_request", { payload: {} });
    emit("message_start", { message: assistant(0) });
    for (let i = 0; i < 20; i++) {
      emit("message_update", { message: assistant(0), ...delta("text_delta", "!") });
      tick(50);
    }
    expect(last()).toMatch(/^τ .+  Δ ~\d+ tok\/s$/);
    const live = Number(/Δ ~(\d+)/.exec(last() ?? "")?.[1]);
    expect(live).toBeGreaterThanOrEqual(35);
  });

  it("clears the status on shutdown", () => {
    const { pi, emit, last } = fakePi();
    extension(pi);
    emit("before_provider_request", { payload: {} });
    emit("session_shutdown", { reason: "quit" });
    expect(last()).toBeUndefined();
  });

  it("does not let hidden reasoning tokens inflate the learned ratio", () => {
    const { pi, emit, last } = fakePi();
    extension(pi);

    // 50 visible tokens streamed, 2000 hidden reasoning tokens billed.
    emit("before_provider_request", { payload: {} });
    emit("message_start", { message: assistant(0) });
    for (let i = 0; i < 50; i++) {
      emit("message_update", { message: assistant(0), ...delta("text_delta", "!") });
      tick(50);
    }
    emit("message_end", { message: assistant(2050, 2000) });

    // Next turn at the same true 20 tok/s must not read as ~800 tok/s.
    emit("before_provider_request", { payload: {} });
    emit("message_start", { message: assistant(0) });
    for (let i = 0; i < 20; i++) {
      emit("message_update", { message: assistant(0), ...delta("text_delta", "!") });
      tick(50);
    }
    const live = Number(/Δ ~(\d+)/.exec(last() ?? "")?.[1]);
    expect(live).toBeGreaterThanOrEqual(18);
    expect(live).toBeLessThanOrEqual(22);
  });
});

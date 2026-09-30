import { describe, expect, it } from "vitest";
import { formatSnapshot } from "../src/format.ts";
import type { Snapshot } from "../src/meter.ts";

const base: Snapshot = {
  phase: "idle",
  ttftMs: null,
  liveTps: null,
  decodeTps: null,
  source: null,
  outputTokens: null,
  activeMs: 0,
  deltaCount: 0,
  thinkingShare: 0,
  refused: false,
};

describe("formatSnapshot", () => {
  it("is empty while idle", () => {
    expect(formatSnapshot(base)).toBe("");
  });

  it("ticks TTFT while waiting", () => {
    expect(formatSnapshot({ ...base, phase: "waiting" }, 800)).toBe("τ 0.8s…");
  });

  it("marks live estimates with a tilde", () => {
    const text = formatSnapshot({
      ...base,
      phase: "streaming",
      ttftMs: 250,
      liveTps: 42.2,
    });
    expect(text).toBe("τ 250ms  Δ ~42 tok/s");
  });

  it("shows only TTFT while streaming has no live window yet", () => {
    expect(formatSnapshot({ ...base, phase: "streaming", ttftMs: 250 })).toBe("τ 250ms");
  });

  it("omits the tilde on settled usage", () => {
    const text = formatSnapshot({
      ...base,
      phase: "settled",
      ttftMs: 1200,
      decodeTps: 48.1,
      source: "usage",
    });
    expect(text).toBe("τ 1.2s  Δ 48 tok/s");
  });

  it("keeps the tilde when settled on an estimate", () => {
    const text = formatSnapshot({
      ...base,
      phase: "settled",
      ttftMs: 200,
      decodeTps: 12.4,
      source: "estimate",
    });
    expect(text).toBe("τ 200ms  Δ ~12 tok/s");
  });

  it("renders an em dash when the sample is refused", () => {
    const text = formatSnapshot({
      ...base,
      phase: "settled",
      ttftMs: 400,
      refused: true,
    });
    expect(text).toBe("τ 400ms  Δ —");
  });
});

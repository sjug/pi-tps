import { describe, expect, it } from "vitest";
import { estimateTokens } from "../src/estimate.ts";
import { Meter } from "../src/meter.ts";

/** Each "!" is one estimated token. */
const TOK = "!";

function stream(meter: Meter, n: number, startAt: number, gapMs: number): number {
  let t = startAt;
  for (let i = 0; i < n; i++) {
    t += gapMs;
    meter.record(TOK, "text", t);
  }
  return t;
}

describe("estimateTokens", () => {
  it("scores punctuation as one token each", () => {
    expect(estimateTokens("!!!!")).toBe(4);
  });

  it("does not count ASCII letters as one token per character", () => {
    expect(estimateTokens("abcd")).toBe(1);
  });

  it("packs CJK tighter than Latin", () => {
    const han = estimateTokens("中文中文");
    const latin = estimateTokens("abcdefgh");
    expect(han).toBeGreaterThan(latin);
    expect(han).toBeLessThan(8);
  });
});

describe("Meter", () => {
  it("starts idle with nothing to report", () => {
    const meter = new Meter(() => 0);
    meter.reset(0);
    const snap = meter.snapshot(0);
    expect(snap.phase).toBe("idle");
    expect(snap.ttftMs).toBeNull();
    expect(snap.decodeTps).toBeNull();
    expect(snap.liveTps).toBeNull();
    expect(snap.refused).toBe(false);
  });

  it.each([" ", "\t", "    "])("times nonempty whitespace deltas: %j", (whitespace) => {
    const meter = new Meter(() => 400);
    meter.markRequestStart(0);
    meter.record("", "text", 50);
    meter.record(whitespace, "text", 100);
    meter.record("!", "text", 300);
    meter.record("!", "text", 400);
    meter.finish(3);
    const snap = meter.snapshot();
    expect(snap.ttftMs).toBe(100);
    expect(snap.activeMs).toBe(300);
    expect(snap.deltaCount).toBe(3);
    expect(snap.decodeTps).toBe(10);
  });

  it("measures TTFT from request start to first delta", () => {
    const meter = new Meter();
    meter.reset(0);
    meter.markRequestStart(100);
    meter.record(TOK, "text", 450);
    expect(meter.snapshot(450).ttftMs).toBe(350);
  });

  it("excludes TTFT from decode time", () => {
    const meter = new Meter();
    meter.reset(0);
    meter.markRequestStart(0);
    stream(meter, 20, 500, 50);
    const snap = meter.snapshot(1500);
    expect(snap.ttftMs).toBe(550);
    expect(snap.activeMs).toBeCloseTo(950, 0);
    expect(snap.activeMs).toBeLessThan(1500);
  });

  it("excludes a long pause from active generation time", () => {
    const meter = new Meter();
    meter.reset(0);
    meter.markRequestStart(0);
    let t = stream(meter, 10, 0, 50);
    t += 60_000;
    stream(meter, 10, t, 50);
    const snap = meter.snapshot(t + 500);
    expect(snap.activeMs).toBeLessThan(1100);
    expect(snap.decodeTps).toBeGreaterThan(15);
  });

  it("excludes a short tool pause when a new generation span starts", () => {
    const meter = new Meter();
    meter.reset(0);
    meter.markRequestStart(0);
    let t = stream(meter, 10, 0, 50);
    t += 900;
    meter.markGenerationStart(t);
    stream(meter, 10, t, 50);
    expect(meter.snapshot(t + 500).activeMs).toBe(900);
  });

  it("uses the provider count for settled decode TPS", () => {
    const meter = new Meter();
    meter.reset(0);
    meter.markRequestStart(0);
    stream(meter, 20, 0, 50);
    meter.finish(54);
    const snap = meter.snapshot();
    expect(snap.phase).toBe("settled");
    expect(snap.source).toBe("usage");
    expect(snap.outputTokens).toBe(54);
    expect(snap.decodeTps).toBeCloseTo(54 / (snap.activeMs / 1000), 5);
  });

  it("keeps the estimate when usage is missing", () => {
    const meter = new Meter();
    meter.reset(0);
    meter.markRequestStart(0);
    stream(meter, 20, 0, 50);
    meter.finish(0);
    const snap = meter.snapshot();
    expect(snap.source).toBe("estimate");
    expect(snap.outputTokens).toBe(20);
  });

  it("refuses a single-chunk dump instead of inventing a rate", () => {
    const meter = new Meter();
    meter.reset(0);
    meter.markRequestStart(0);
    meter.record(TOK.repeat(200), "text", 800);
    meter.finish(200, 801);
    const snap = meter.snapshot(801);
    expect(snap.refused).toBe(true);
    expect(snap.decodeTps).toBeNull();
  });

  it("refuses an implausible flush rate", () => {
    const meter = new Meter();
    meter.reset(0);
    meter.markRequestStart(0);
    meter.record(TOK, "text", 0);
    meter.record(TOK.repeat(800), "text", 60);
    meter.finish(8000, 60);
    const snap = meter.snapshot(60);
    expect(snap.activeMs).toBeGreaterThanOrEqual(50);
    expect(snap.refused).toBe(true);
    expect(snap.decodeTps).toBeNull();
  });

  it("live window tracks the recent rate, not the whole turn", () => {
    const meter = new Meter();
    meter.reset(0);
    meter.markRequestStart(0);
    stream(meter, 10, 0, 100);
    const end = stream(meter, 40, 1000, 10);
    const snap = meter.snapshot(end);
    expect(snap.phase).toBe("streaming");
    expect(snap.liveTps).not.toBeNull();
    expect(snap.decodeTps).not.toBeNull();
    expect(snap.liveTps!).toBeGreaterThan(snap.decodeTps!);
  });

  it("does not refuse mid-stream after a single delta", () => {
    const meter = new Meter();
    meter.reset(0);
    meter.markRequestStart(0);
    meter.record(TOK, "text", 300);
    const snap = meter.snapshot(300);
    expect(snap.phase).toBe("streaming");
    expect(snap.refused).toBe(false);
    expect(snap.liveTps).toBeNull();
  });

  it("holds the last live rate across a stall instead of dropping to null", () => {
    const meter = new Meter();
    meter.reset(0);
    meter.markRequestStart(0);
    const end = stream(meter, 20, 0, 50);
    const before = meter.snapshot(end).liveTps;
    expect(before).not.toBeNull();
    const stalled = meter.snapshot(end + 1500).liveTps;
    expect(stalled).toBe(before);
  });

  it("clears the held live rate on reset", () => {
    const meter = new Meter();
    meter.reset(0);
    meter.markRequestStart(0);
    const end = stream(meter, 20, 0, 50);
    expect(meter.snapshot(end).liveTps).not.toBeNull();
    meter.reset(end + 10);
    meter.markRequestStart(end + 10);
    meter.record(TOK, "text", end + 20);
    expect(meter.snapshot(end + 20).liveTps).toBeNull();
  });

  it("does not report a live rate from two near-simultaneous opening deltas", () => {
    const meter = new Meter();
    meter.reset(0);
    meter.markRequestStart(0);
    meter.record(TOK.repeat(30), "text", 500);
    meter.record(TOK.repeat(30), "text", 501);
    expect(meter.snapshot(501).liveTps).toBeNull();
    stream(meter, 20, 501, 50);
    const live = meter.snapshot(1501).liveTps;
    expect(live).not.toBeNull();
    expect(live!).toBeLessThan(1000);
  });

  it("never holds a live rate above the plausibility cap", () => {
    const meter = new Meter();
    meter.reset(0);
    meter.markRequestStart(0);
    meter.record(TOK, "text", 0);
    meter.record(TOK.repeat(5000), "text", 60);
    expect(meter.snapshot(60).liveTps).toBeNull();
    expect(meter.snapshot(300).liveTps).toBeNull();
  });

  it("counts thinking toward the thinking share", () => {
    const meter = new Meter();
    meter.reset(0);
    meter.markRequestStart(0);
    meter.record("!!!!", "thinking", 100);
    meter.record("!!!!", "text", 200);
    expect(meter.snapshot(200).thinkingShare).toBeCloseTo(0.5, 5);
  });
});

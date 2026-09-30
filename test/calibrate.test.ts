import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import lockfile from "proper-lockfile";
import {
  applyCalibration,
  fold,
  foldSample,
  modelKey,
  UNCALIBRATED,
  type Calibration,
} from "../src/calibrate.ts";
import { Meter, type Snapshot } from "../src/meter.ts";
import { formatSnapshot } from "../src/format.ts";
import { loadCalibrations, saveCalibrations } from "../src/store.ts";

const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  phase: "streaming",
  ttftMs: 200,
  liveTps: 40,
  decodeTps: 40,
  source: "estimate",
  outputTokens: 100,
  activeMs: 2500,
  deltaCount: 10,
  thinkingShare: 0,
  refused: false,
  ...over,
});

describe("fold", () => {
  it("adopts the first real sample outright", () => {
    expect(fold(undefined, 50, 100)).toEqual({ ratio: 2, samples: 1 });
  });

  it("ignores short turns", () => {
    expect(fold(undefined, 20, 40)).toBe(UNCALIBRATED);
  });

  it("smooths later samples with a 0.3 EMA", () => {
    const first = fold(undefined, 50, 100);
    const next = fold(first, 50, 50);
    expect(next.samples).toBe(2);
    expect(next.ratio).toBeCloseTo(2 * 0.7 + 1 * 0.3, 5);
  });

  it("rejects a 4× outlier instead of yanking the ratio", () => {
    const current: Calibration = { ratio: 1.2, samples: 3 };
    expect(fold(current, 50, 400)).toBe(current);
  });

  it("keeps models on separate keys", () => {
    expect(modelKey("openai", "gpt-4")).toBe("openai/gpt-4");
    expect(modelKey("openai", "gpt-4")).not.toBe(modelKey("anthropic", "opus"));
  });
});

describe("foldSample", () => {
  const meter = { estimatedTokens: 300, estimatedVisibleTokens: 100 };

  it("compares visible tokens only when the provider reports reasoning", () => {
    expect(foldSample(meter, { output: 2100, reasoning: 2000 })).toEqual({
      estimated: 100,
      actual: 100,
    });
  });

  it("compares totals when reasoning is not reported", () => {
    expect(foldSample(meter, { output: 310 })).toEqual({ estimated: 300, actual: 310 });
  });

  it("keeps the ratio stable across turns with wildly different hidden reasoning", () => {
    let cal = fold(undefined, ...Object.values(foldSample(meter, { output: 2100, reasoning: 2000 })) as [number, number]);
    cal = fold(cal, ...Object.values(foldSample(meter, { output: 105, reasoning: 5 })) as [number, number]);
    expect(cal.samples).toBe(2);
    expect(cal.ratio).toBeCloseTo(1, 1);
  });
});

describe("applyCalibration", () => {
  const cal: Calibration = { ratio: 2, samples: 1 };

  it.each(["streaming", "settled"])("refuses calibrated %s rates above the cap", (phase) => {
    const meter = new Meter(() => 100);
    meter.markRequestStart(0);
    meter.record("!", "text", 0);
    meter.record("!".repeat(900), "text", 100);
    if (phase === "settled") meter.finish(0);
    const out = applyCalibration(meter.snapshot(100), cal);
    expect(out.refused).toBe(true);
    expect(out.liveTps).toBeNull();
    expect(out.decodeTps).toBeNull();
    expect(formatSnapshot(out)).toBe("τ 0ms  Δ —");
  });

  it("scales live TPS and estimate-sourced decode", () => {
    const out = applyCalibration(snap(), cal);
    expect(out.liveTps).toBe(80);
    expect(out.decodeTps).toBe(80);
    expect(out.outputTokens).toBe(200);
  });

  it("does not scale usage-backed decode TPS", () => {
    const out = applyCalibration(snap({ source: "usage", decodeTps: 40, outputTokens: 80 }), cal);
    expect(out.liveTps).toBe(80);
    expect(out.decodeTps).toBe(40);
    expect(out.outputTokens).toBe(80);
  });
});

describe("store", () => {
  it("loads and updates BOM-prefixed Pi settings without losing other settings", () => {
    const path = join(mkdtempSync(join(tmpdir(), "pi-tps-")), "settings.json");
    writeFileSync(path, "\uFEFF" + JSON.stringify({
      theme: "dark",
      piTps: { calibration: { "a/one": { ratio: 1, samples: 1 } } },
    }));
    expect(loadCalibrations(path)["a/one"]).toEqual({ ratio: 1, samples: 1 });
    saveCalibrations({ "a/one": { ratio: 2, samples: 2 } }, path);
    expect(JSON.parse(readFileSync(path, "utf8")).theme).toBe("dark");
    expect(loadCalibrations(path)["a/one"]).toEqual({ ratio: 2, samples: 2 });
  });

  it.each([
    '{"theme":"dark", BROKEN',
    '[]',
    'null',
  ])("preserves invalid settings instead of replacing them: %s", (original) => {
    const path = join(mkdtempSync(join(tmpdir(), "pi-tps-")), "settings.json");
    writeFileSync(path, original);
    expect(loadCalibrations(path)).toEqual({});
    expect(() => saveCalibrations({ "a/one": { ratio: 2, samples: 1 } }, path)).not.toThrow();
    expect(readFileSync(path, "utf8")).toBe(original);
  });

  it("leaves settings untouched while another writer holds the lock", () => {
    const path = join(mkdtempSync(join(tmpdir(), "pi-tps-")), "settings.json");
    const original = JSON.stringify({ theme: "dark" });
    writeFileSync(path, original);
    const release = lockfile.lockSync(path, { realpath: false });
    try {
      expect(() => saveCalibrations({ "a/one": { ratio: 2, samples: 1 } }, path)).not.toThrow();
      expect(readFileSync(path, "utf8")).toBe(original);
    } finally {
      release();
    }
    saveCalibrations({ "a/one": { ratio: 2, samples: 1 } }, path);
    expect(loadCalibrations(path)["a/one"]).toEqual({ ratio: 2, samples: 1 });
  });

  it("round-trips calibrations without clobbering the rest of settings.json", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-tps-"));
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ other: true, piTps: { extra: 1 } }));
    saveCalibrations({ "openai/gpt": { ratio: 1.5, samples: 2 } }, path);
    const loaded = loadCalibrations(path);
    expect(loaded["openai/gpt"]).toEqual({ ratio: 1.5, samples: 2 });
    const all = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(all.other).toBe(true);
    expect((all.piTps as { extra: number }).extra).toBe(1);
  });

  it("keeps entries another session learned for models this one never saw", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-tps-"));
    const path = join(dir, "settings.json");
    saveCalibrations({ "a/one": { ratio: 1.1, samples: 4 } }, path);
    // A second session, holding a stale copy, writes a different key.
    saveCalibrations({ "b/two": { ratio: 0.9, samples: 2 } }, path);
    // The first session updates its own key.
    saveCalibrations({ "a/one": { ratio: 1.2, samples: 5 } }, path);
    expect(loadCalibrations(path)).toEqual({
      "a/one": { ratio: 1.2, samples: 5 },
      "b/two": { ratio: 0.9, samples: 2 },
    });
  });

  it("creates the file when none exists and leaves no temp file behind", () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-tps-"));
    const path = join(dir, "nested", "settings.json");
    saveCalibrations({ "a/one": { ratio: 1, samples: 1 } }, path);
    expect(loadCalibrations(path)["a/one"]).toEqual({ ratio: 1, samples: 1 });
    expect(readdirSync(join(dir, "nested"))).toEqual(["settings.json"]);
  });
});

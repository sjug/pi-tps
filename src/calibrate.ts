import { MAX_PLAUSIBLE_TPS, type Snapshot } from "./meter.ts";

// fold() and its thresholds follow pi-tokrate (MIT, Copyright (c) 2026
// Eric Qian); see NOTICE.

/** Learned scale: multiply an estimate by `ratio` to match this model. */
export interface Calibration {
  ratio: number;
  samples: number;
}

const SMOOTHING = 0.3;
const MIN_SAMPLE_TOKENS = 40;
const OUTLIER_FACTOR = 4;
const MIN_RATIO = 0.05;
const MAX_RATIO = 20;

export const UNCALIBRATED: Calibration = { ratio: 1, samples: 0 };

export function modelKey(provider: string | undefined, id: string | undefined): string {
  return `${provider ?? "unknown"}/${id ?? "unknown"}`;
}

/**
 * Fold one finished turn into this model's correction factor.
 *
 * `actual / estimated` is one noisy sample of how the live estimator
 * compares to the provider's tokenizer. Short turns and 4× outliers are
 * ignored; after the first sample, new ratios are EMA-smoothed.
 */
export function fold(
  current: Calibration | undefined,
  estimated: number,
  actual: number,
): Calibration {
  const base = current ?? UNCALIBRATED;
  if (!Number.isFinite(estimated) || !Number.isFinite(actual)) return base;
  if (estimated < MIN_SAMPLE_TOKENS || actual <= 0) return base;

  const observed = actual / estimated;
  if (observed < MIN_RATIO || observed > MAX_RATIO) return base;

  if (base.samples === 0) return { ratio: observed, samples: 1 };

  const drift = observed / base.ratio;
  if (drift > OUTLIER_FACTOR || drift < 1 / OUTLIER_FACTOR) return base;

  return {
    ratio: base.ratio * (1 - SMOOTHING) + observed * SMOOTHING,
    samples: base.samples + 1,
  };
}

/**
 * Pick the two token counts that describe the same thing.
 *
 * Providers that report `usage.reasoning` may stream only a summary of it
 * (OpenAI) or all of it (Anthropic); either way the hidden share varies per
 * turn and would make the ratio chase noise. Compare visible tokens only.
 * Providers that report nothing get totals against totals.
 */
export function foldSample(
  meter: { estimatedTokens: number; estimatedVisibleTokens: number },
  usage: { output: number; reasoning?: number },
): { estimated: number; actual: number } {
  if (typeof usage.reasoning === "number") {
    return { estimated: meter.estimatedVisibleTokens, actual: usage.output - usage.reasoning };
  }
  return { estimated: meter.estimatedTokens, actual: usage.output };
}

export function correct(estimate: number, calibration: Calibration | undefined): number {
  return estimate * (calibration ?? UNCALIBRATED).ratio;
}

/** Scale estimate-sourced fields. Usage-backed decode TPS is left alone. */
export function applyCalibration(snap: Snapshot, calibration: Calibration | undefined): Snapshot {
  const ratio = (calibration ?? UNCALIBRATED).ratio;
  if (ratio === 1) return snap;

  const liveTps = snap.liveTps === null ? null : snap.liveTps * ratio;
  const decodeTps = snap.decodeTps === null || snap.source !== "estimate"
    ? snap.decodeTps
    : snap.decodeTps * ratio;
  const displayedRate = snap.phase === "streaming" ? liveTps : decodeTps;
  const refused = snap.refused || (displayedRate !== null && displayedRate > MAX_PLAUSIBLE_TPS);

  return {
    ...snap,
    liveTps: refused ? null : liveTps,
    decodeTps: refused ? null : decodeTps,
    source: refused ? null : snap.source,
    refused,
    outputTokens: snap.source === "estimate" && snap.outputTokens !== null
      ? Math.round(snap.outputTokens * ratio)
      : snap.outputTokens,
  };
}

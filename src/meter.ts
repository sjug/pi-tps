import { estimateTokens } from "./estimate.ts";

/** A gap longer than this was not spent generating (tool, prompt, stall). */
const IDLE_GAP_MS = 2000;

/** Trailing window for the live rate. */
const WINDOW_MS = 1000;

/** Decode TPS below this duration is a buffer flush, not a measurement. */
const MIN_ACTIVE_MS = 50;

/** A single SSE dump has no inter-delta span to divide by. */
const MIN_DELTAS = 2;

/** Above this, the number is a flush artifact. */
export const MAX_PLAUSIBLE_TPS = 10_000;

export type DeltaKind = "text" | "thinking" | "toolcall";
export type Phase = "idle" | "waiting" | "streaming" | "settled";
export type TokenSource = "usage" | "estimate";

export type Clock = () => number;

interface Sample {
  at: number;
  tokens: number;
}

export interface Snapshot {
  phase: Phase;
  ttftMs: number | null;
  liveTps: number | null;
  decodeTps: number | null;
  source: TokenSource | null;
  outputTokens: number | null;
  activeMs: number;
  deltaCount: number;
  thinkingShare: number;
  refused: boolean;
}

export class Meter {
  private nowFn: Clock;
  private samples: Sample[] = [];
  private estimated = 0;
  private estimatedThinking = 0;
  private actual: number | null = null;
  private activeMs = 0;
  private lastDeltaAt: number | null = null;
  private deltaCount = 0;
  private requestAt: number | null = null;
  private firstTokenAt: number | null = null;
  private ttftMs: number | null = null;
  private streaming = false;
  private settled = false;
  private lastLiveTps: number | null = null;

  constructor(now: Clock = () => performance.now()) {
    this.nowFn = now;
  }

  /** Begin a turn. Previous state is discarded. */
  reset(now: number = this.nowFn()): void {
    this.samples = [];
    this.estimated = 0;
    this.estimatedThinking = 0;
    this.actual = null;
    this.activeMs = 0;
    this.lastDeltaAt = null;
    this.deltaCount = 0;
    this.requestAt = null;
    this.firstTokenAt = null;
    this.ttftMs = null;
    this.streaming = false;
    this.settled = false;
    this.lastLiveTps = null;
  }

  /**
   * Provider request is about to fire. TTFT is measured from here, not from
   * user-message commit, so prompt assembly is not mixed into prefill wait.
   */
  markRequestStart(now: number = this.nowFn()): void {
    this.requestAt = now;
    this.ttftMs = null;
    this.firstTokenAt = null;
  }

  /**
   * A new generation span is beginning (new assistant message after a tool).
   * The clock does not carry across this boundary.
   */
  markGenerationStart(now: number = this.nowFn()): void {
    this.streaming = true;
    this.settled = false;
    this.lastDeltaAt = null;
  }

  record(delta: string, kind: DeltaKind = "text", now: number = this.nowFn()): void {
    if (delta.length === 0) return;
    const tokens = estimateTokens(delta);

    this.latchTtft(now);
    if (this.lastDeltaAt !== null) {
      const gap = now - this.lastDeltaAt;
      if (gap >= 0 && gap <= IDLE_GAP_MS) this.activeMs += gap;
    }
    this.lastDeltaAt = now;
    this.streaming = true;
    this.settled = false;
    this.deltaCount += 1;
    this.estimated += tokens;
    if (kind === "thinking") this.estimatedThinking += tokens;
    this.samples.push({ at: now, tokens });
    this.trim(now);
  }

  /** Live estimator total for this turn. Used to learn a per-model scale. */
  get estimatedTokens(): number {
    return this.estimated;
  }

  /** Estimator total excluding thinking deltas. */
  get estimatedVisibleTokens(): number {
    return this.estimated - this.estimatedThinking;
  }

  /** End the stream, adopting the provider's output count when it is real. */
  finish(actualTokens: number, _now: number = this.nowFn()): void {
    this.streaming = false;
    this.settled = true;
    if (Number.isFinite(actualTokens) && actualTokens > 0) this.actual = actualTokens;
  }

  snapshot(now: number = this.nowFn()): Snapshot {
    const source: TokenSource | null =
      this.actual !== null ? "usage" : this.estimated > 0 ? "estimate" : null;
    const tokens = this.actual ?? (this.estimated > 0 ? this.estimated : null);
    const decode = this.decodeRate(tokens);

    let phase: Phase = "idle";
    if (this.settled) phase = "settled";
    else if (this.streaming && this.firstTokenAt !== null) phase = "streaming";
    else if (this.requestAt !== null && !this.settled) phase = "waiting";

    // The meter refuses finished samples. Mid-stream, a one-delta meter
    // is simply "no data yet"; calibration can separately refuse a live rate.
    const refused = phase === "settled" && this.shouldRefuse(decode);

    return {
      phase,
      ttftMs: this.ttftMs,
      liveTps: phase === "streaming" ? this.liveRate(now) : null,
      decodeTps: refused ? null : decode,
      source: refused ? null : source,
      outputTokens: tokens === null ? null : Math.round(tokens),
      activeMs: this.activeMs,
      deltaCount: this.deltaCount,
      thinkingShare: this.estimated > 0 ? this.estimatedThinking / this.estimated : 0,
      refused,
    };
  }

  private latchTtft(now: number): void {
    if (this.firstTokenAt !== null) return;
    this.firstTokenAt = now;
    if (this.requestAt !== null) this.ttftMs = Math.max(0, now - this.requestAt);
  }

  private trim(now: number): void {
    const cutoff = now - WINDOW_MS;
    let i = 0;
    while (i < this.samples.length && this.samples[i]!.at < cutoff) i++;
    if (i > 0) this.samples = this.samples.slice(i);
  }

  /**
   * Live rate for display. Holds the last real window rate across a stall so
   * the footer does not flicker between a number and nothing; the held value
   * is still an estimate and callers mark it as such.
   */
  private liveRate(now: number): number | null {
    const rate = this.windowRate(now);
    if (rate !== null) this.lastLiveTps = rate;
    return this.lastLiveTps;
  }

  /**
   * Estimated tokens in the trailing window, excluding the sample that opened it.
   *
   * The same gates as the settled rate apply: a span under MIN_ACTIVE_MS is
   * two deltas from one flush, not a measurement, and a rate above
   * MAX_PLAUSIBLE_TPS is a burst artifact. Both return null so the held
   * value (or nothing) is shown instead of a five-digit number.
   */
  private windowRate(now: number): number | null {
    this.trim(now);
    if (this.samples.length < 2) return null;
    const first = this.samples[0]!;
    const last = this.samples[this.samples.length - 1]!;
    const span = last.at - first.at;
    if (span < MIN_ACTIVE_MS) return null;
    let tokens = 0;
    for (let i = 1; i < this.samples.length; i++) tokens += this.samples[i]!.tokens;
    const rate = (tokens / span) * 1000;
    return rate > MAX_PLAUSIBLE_TPS ? null : rate;
  }

  private decodeRate(tokens: number | null): number | null {
    if (tokens === null || tokens <= 0 || this.activeMs <= 0) return null;
    return tokens / (this.activeMs / 1000);
  }

  private shouldRefuse(decode: number | null): boolean {
    if (this.deltaCount < MIN_DELTAS) return this.deltaCount > 0 || this.actual !== null;
    if (this.activeMs < MIN_ACTIVE_MS) return true;
    if (decode !== null && decode > MAX_PLAUSIBLE_TPS) return true;
    return false;
  }
}

import type { Snapshot } from "./meter.ts";

function fmtTtft(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function fmtTps(tps: number): string {
  if (tps < 10) return tps.toFixed(1);
  if (tps < 100) return tps.toFixed(0);
  return String(Math.round(tps));
}

function fmtWaitingTtft(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * Compact footer: τ for TTFT, Δ for decode tok/s.
 * Live estimates are marked `~`. Refused samples render `—`.
 */
export function formatSnapshot(snap: Snapshot, nowTtftMs?: number): string {
  const tau =
    snap.ttftMs !== null
      ? `τ ${fmtTtft(snap.ttftMs)}`
      : snap.phase === "waiting" && nowTtftMs !== null && nowTtftMs !== undefined && nowTtftMs > 0
        ? `τ ${fmtWaitingTtft(nowTtftMs)}…`
        : null;

  let delta: string | null = null;
  if (snap.phase === "streaming") {
    const live = snap.liveTps;
    if (snap.refused) delta = "Δ —";
    else if (live !== null && live > 0) delta = `Δ ~${fmtTps(live)} tok/s`;
  } else if (snap.phase === "settled") {
    if (snap.refused || snap.decodeTps === null) delta = "Δ —";
    else {
      const mark = snap.source === "estimate" ? "~" : "";
      delta = `Δ ${mark}${fmtTps(snap.decodeTps)} tok/s`;
    }
  }

  const parts = [tau, delta].filter((p): p is string => p !== null);
  return parts.join("  ");
}

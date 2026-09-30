# pi-tps

Honest tokens-per-second for the [Pi coding agent](https://github.com/earendil-works/pi).

Generation speed, time-to-first-token, and a live estimate that never pretends to be `usage.output`.

```
τ 0.8s…              waiting for the first token
τ 0.8s  Δ ~42 tok/s  streaming (estimate)
τ 0.8s  Δ 48 tok/s   settled (provider count)
τ 0.8s  Δ —          refused: flush, single chunk, or no decode window
```

`τ` is TTFT. `Δ` is decode tok/s. `~` means the numerator is still an estimate.

## Install

```bash
pi install ./          # from this repo
# or, once published:
# pi install npm:pi-tps
```

Then `/reload`. Do not install other TPS footer extensions at the same time — they fight over the same status key.

## What it measures

| Number | Clock | Tokens |
|---|---|---|
| TTFT | `before_provider_request` → first non-empty text/thinking/toolcall delta | — |
| Live `Δ` | trailing 1s of streamed deltas | estimated from text, then scaled by a per-model factor |
| Settled `Δ` | active generation time (gaps >2s and tool-bounded spans excluded) | `usage.output` when present |

The live estimate is almost always off by a constant that depends on the model (CJK packing, code vocab, batched flushes). After each turn the plugin compares that estimate to `usage.output` and keeps an EMA of the ratio, keyed by `provider/id`. When the provider reports `usage.reasoning`, only visible tokens are compared, so hidden reasoning cannot skew the ratio. The next stream is multiplied by it and still marked `~`. Settled usage-backed Δ is never scaled. Learned ratios live in Pi's `settings.json` (honouring `PI_CODING_AGENT_DIR`) under `piTps.calibration`, merged only for the changed model and written under Pi's own file lock. Updates to different models are preserved; for the same model, the last successful write wins. If the lock is busy or settings cannot be read safely, the write is skipped and calibration remains in memory.

It does **not** divide by `agent_end − agent_start`. A 30s bash is not slow generation.

A single SSE dump, a sub-50ms span, or a rate above 10k tok/s renders `—` instead of a fantasy number.

## Why another one

There are ~30 Pi packages that print `tok/s`. They disagree about the clock, the numerator, and whether a buffer flush is a measurement. The research notes are in [`FINDINGS.md`](FINDINGS.md). This package takes the measurement core from that review and leaves the dashboards to other addons.

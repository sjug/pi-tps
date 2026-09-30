# What 32 Pi TPS meters actually measure

Clones live under `meters/` (see `meters/MANIFEST.md`). Four review passes read the source, not the READMEs. This file is the synthesis: what “TPS” means in the wild, which packages are worth stealing from, and the design of the addon in this repo.

## The field is not one metric

Almost every package labels the number `tok/s` or `TPS`. They are measuring at least five different clocks:

| Clock | Start | End | Tools in the denominator? | Typical packages |
|---|---|---|---|---|
| Agent wall | `agent_start` | `agent_end` | yes | official `tps.ts`, `@schovest/pi-tps`, `@yqt5420/pi-token-speed` |
| Prompt / run wall | `before_agent_start` | `agent_end` / `agent_settled` | yes | `@oipsanthony/pi-tps`, `pi-response-stats` |
| Turn wait | `turn_start` | `message_end` | no | `@arhen/pi-core-tps-stats` |
| Decode | first content delta | last delta or `message_end` | no | `pi-tokrate`, `@pi-plugins/speed`, `pi-speedometer`, `pi-tps-footer`, `pi-rakit` |
| Live window | recent deltas | now | varies | `pi-token-speed`, `oh-my-tps`, `pi-tps-meter` |

The official sample is `usage.output / (agent_end − agent_start)`. A 30s `bash` with 10 output tokens reports 0.3 tok/s. That is not generation speed. Several published packages still ship it.

A second trap: **live estimate and final `usage.output` are different quantities**. Packages that swap one for the other without a `~` / `≈` / `[est]` mark will lie about whichever phase you are looking at. `chars/4` and “1 token per SSE chunk” are the two most common live lies. Chunk-counting is worse: the error grows exactly when the server is fast (speculative decoding, `--stream-interval`).

A third trap: **SSE batching**. Window-from-first-chunk-to-last-chunk on a gateway that flushes 200 tokens in 0.3ms reports thousands of tok/s. `@arhen/pi-core-tps-stats` published the capture table (14 vs 801 on the same model). `@pi-plugins/speed` and `@monotykamary/pi-tps` refuse those samples. `omp-throughput` does not.

## Ranking (overall, for building a dedicated meter)

Honesty first, then UX, then tests. Different products are marked.

| Rank | Package | Role | Why it placed |
|---|---|---|---|
| 1 | **pi-tokrate** | decode + live | Two-phase honesty (`~estimate` vs `usage.output / activeMs`), tool-excluded clock, CJK estimator + calibration, baseline coloring, deep modules, real tests |
| 2 | **@pi-plugins/speed** | decode (settled) | Token-weighted EMA, first-chunk proration, 2ms/single-chunk drop, streamed-vs-billed reasoning, excellent tests |
| 3 | **pi-tps-footer** | decode + rest average | First-delta clock, Bayesian chars/token, leaky per-model average, 500 tok/s flush gate, `≈` label |
| 4 | **@oipsanthony/pi-tps** | *prompt e2e* (not decode) | One named formula, persisted request/prompt facts, injectable clock, Pi+OMP tests |
| 5 | **pi-pulse** | live UX | Best footer craft (TTFT phases, braille, abort-safe tick, injectable `performance.now`); numerator is unlabeled char/4 |
| 6 | **pi-speedometer** | post-turn ontology | TTFT ≠ prefill ≠ decode; last-delta decode window; abort skip; no live, no tests |
| 7 | **@monotykamary/pi-tps** | post-turn gates | Stall math, burst-vs-flush, `TPS —` when unmeasurable, usage.output, tests; no live UI; 980-line file |
| 8 | **pi-tokometer** | decode + TTFT | Persist timings on the message; 50ms gate; **replaces the whole footer** |
| 9 | **@arhen/pi-core-tps-stats** | *turn wait* | Deliberately includes queue+prefill; median of 200; refuses window math |
| 10 | **pi-rakit-token-speed** | decode | Smallest honest implementation: injectable tracker, `~`, tests |
| 11 | **oh-my-tps** | micro-UX | `τ`/`Δ` language, 2s floor, waiting-phase TTFT; live `tokenx` ≠ final usage |
| 12 | **pi-metrics** | wait HUD + TPS fork | `input`→`agent_settled` HUD; TPS is monotykamary without the stall tests |
| 13 | **pi-live-throughput** | live | Best fake-clock tests in batch 3; final avg still includes TTFT |
| 14 | **pi-turn-metrics** | session decode | `Σ output / Σ (end − firstToken)`; LLM vs tool vs TTFT; untested |
| 15 | **pi-token-speed** | live window | Best sliding-window + tool pause + `/tps` TUI; default **1 token per chunk** |
| 16 | **pi-tps-status** | configurable live | Tool pause refcount, source tags, atomic config; default strategy barely streams |
| 17 | **pi-tps-meter** | gauge UX | Sub-cell live gauge + sparkline; live char/4 vs final usage unlabeled |
| 18 | **pi-simple-tps** | VU widget | Best visual meter; TTFT in the clock; peak-hold of the early spike |
| 19 | **@tian.zuo/pi-token-speed** | live + TTFT | 5s window, gap-persistent summary; Effect ceremony; empty-delta = 1 token |
| 20 | **pi-thinking-realtime-tps** | working loader | Doesn’t fight the footer; 1s window treats a partial as full; mutates `event.message` |
| 21 | **@gondor/pi-pace** | local-ops | Best idle/tools/tpm (merged intervals); TPS includes TTFT |
| 22 | **omp-throughput** | subagent dashboard | The panel everyone wants; chars/4, unweighted μ, no tests |
| 23 | **pi-response-stats** | run wall | Persistence/branch restore is excellent; TPS includes tools |
| 24 | **@ian-pascoe/pi-tps-tracker** | stream aggregate | Official > tiktoken > chars/4; 0ms samples leak into the aggregate |
| 25 | **pi-tps-was-taken** | live EMA | First-token clock is right; stall-frozen EMA; no tests |
| 26 | **@jnardiello/pi-speed** | decode toast | Honest first→last window stuffed into the transcript |
| 27 | **token-rate-pi** | session average | Tool-freeze idea; last-message tokens / first-segment time |
| 28 | **summertime-wu `pi-tps`** | waterfall | Steal the trace; thinking tokens in numerator, thinking time often out of denominator |
| 29 | **pi-token-meter** | post-hoc | 34 lines, TTFT in the clock, stale `@mariozechner` import |
| 30 | **@yqt5420/pi-token-speed** | feature pack | Subagents + TTFT UI; turn wall-clock labeled as t/s |
| 31 | **@schovest/pi-tps** | toast | Official formula again |
| 32 | **official `tps.ts`** | sample | The control. Never ship as decode speed. |

## Steal vs do-not-copy

**Steal**

1. Two rates, two labels (`pi-tokrate`): live = calibrated estimate over a 1s window, marked `~`; final = `usage.output / active_generation_seconds`.
2. Generation-span boundaries (`pi-tokrate` `markGenerationStart`, `pi-token-speed` pause): tools and permission prompts must not accrue.
3. Refuse to invent TPS (`@monotykamary/pi-tps`, `@pi-plugins/speed`): single-chunk, sub-50ms, inter-chunk flush, >10k tok/s → `—`.
4. TTFT / prefill / decode are different clocks (`pi-speedometer`, `pi-pulse`).
5. Token-weighted aggregates `sum(tokens)/sum(ms)`, never `mean(rate_i)` (`@pi-plugins/speed`). `omp-throughput` μ is the anti-pattern.
6. Mark estimates (`~`, `≈`, `[est]`) and color against **this model’s baseline**, not a global 50 tok/s rainbow.
7. Injectable `performance.now`, instance state (not module globals), abort the tick on `session_shutdown`.
8. Hold the last good number until live has enough data (`pi-tps-footer` 0.3s / 20 tok).
9. Persist observed timings (`@oipsanthony/pi-tps` session entries, `pi-tokometer` on the message) if you want `/resume` to replay.
10. Compact `τ` (TTFT) / `Δ` (decode) language (`oh-my-tps`).

**Do not copy**

- `usage.output / agent_wall_clock`.
- Default 1 token per SSE delta.
- Unlabeled `chars/4`.
- Mixing TTFT into TPS without saying so.
- Replacing Pi’s entire footer (only one `setFooter` wins).
- Module-global meters and 900-line `index.ts`.
- Averaging per-request rates.
- Effect/`ManagedRuntime` for a handful of numbers.
- Mutating `event.message`.

## Design of this addon

The meter in this repo is a **deep module**: a lot of behaviour behind one snapshot. The Pi extension is a thin adapter. Tests hit the meter, not Pi.

**Interface (the test surface)**

```
reset / markRequestStart / markGenerationStart / record / finish / snapshot
```

Callers never see rings, stalls, or the estimator.

**What `snapshot()` reports**

| Field | Definition |
|---|---|
| `ttftMs` | `before_provider_request` → first non-empty text/thinking/toolcall delta |
| `liveTps` | trailing 1s window of *estimated* tokens, first sample excluded; `null` until the window is real |
| `decodeTps` | `usage.output` (else estimate) / active generation ms; `null` if refused |
| `source` | `"usage"` once the provider has spoken, else `"estimate"` |
| `refused` | single-chunk, `<50ms` active, or `>10_000` tok/s |

Active time excludes gaps `>2s` and anything before `markGenerationStart` (the adapter fires that on each new assistant `message_start` so a tool cannot hide inside a 900ms pause).

Live rates are prefixed `~`. Settled usage rates are not. A refused sample renders `—` rather than a fantasy number.

**Out of v1 on purpose** (real features, wrong module): subagent dashboard, sparkline chrome, JSONL export, `/speed csv`, footer replacement, wait-time HUD. Those are other packages. This one does one thing: honest generation speed.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyCalibration, fold, foldSample, modelKey, type Calibration } from "./calibrate.ts";
import { formatSnapshot } from "./format.ts";
import { Meter, type DeltaKind } from "./meter.ts";
import { loadCalibrations, saveCalibrations } from "./store.ts";

const STATUS_KEY = "tps";
const TICK_MS = 200;

function deltaKind(type: "text_delta" | "thinking_delta" | "toolcall_delta"): DeltaKind {
  if (type === "thinking_delta") return "thinking";
  if (type === "toolcall_delta") return "toolcall";
  return "text";
}

export default function (pi: ExtensionAPI): void {
  const meter = new Meter();
  const calibrations = loadCalibrations();
  let tick: ReturnType<typeof setInterval> | null = null;
  let lastCtx: ExtensionContext | null = null;
  let requestAt: number | null = null;
  let turnKey = modelKey(undefined, undefined);
  let turnCalibration: Calibration | undefined;

  const stopTick = (): void => {
    if (tick !== null) {
      clearInterval(tick);
      tick = null;
    }
  };

  const paint = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    lastCtx = ctx;
    const snap = applyCalibration(meter.snapshot(), turnCalibration);
    const waitingMs =
      snap.phase === "waiting" && requestAt !== null ? performance.now() - requestAt : undefined;
    const text = formatSnapshot(snap, waitingMs);
    ctx.ui.setStatus(STATUS_KEY, text === "" ? undefined : text);
  };

  const ensureTick = (): void => {
    if (tick !== null) return;
    tick = setInterval(() => {
      if (lastCtx) paint(lastCtx);
    }, TICK_MS);
  };

  pi.on("session_start", (_event, ctx) => {
    meter.reset();
    requestAt = null;
    stopTick();
    paint(ctx);
  });

  // Fires once per provider call, including retries, so each measurement is
  // one request: TTFT from the last attempt, decode over that stream only.
  pi.on("before_provider_request", (_event, ctx) => {
    const now = performance.now();
    requestAt = now;
    turnKey = modelKey(ctx.model?.provider, ctx.model?.id);
    turnCalibration = calibrations[turnKey];
    meter.reset(now);
    meter.markRequestStart(now);
    ensureTick();
    paint(ctx);
  });

  pi.on("message_start", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    meter.markGenerationStart();
    paint(ctx);
  });

  pi.on("message_update", (event, ctx) => {
    const stream = event.assistantMessageEvent;
    if (
      stream.type !== "text_delta" &&
      stream.type !== "thinking_delta" &&
      stream.type !== "toolcall_delta"
    ) {
      return;
    }
    if (stream.delta.length === 0) return;
    meter.record(stream.delta, deltaKind(stream.type));
    paint(ctx);
  });

  // message_end also fires for user, toolResult and custom messages; only the
  // assistant one closes a generation span.
  pi.on("message_end", (event, ctx) => {
    if (event.message.role !== "assistant") return;
    meter.finish(event.message.usage.output);
    const sample = foldSample(meter, event.message.usage);
    const next = fold(turnCalibration, sample.estimated, sample.actual);
    if (next.samples !== (turnCalibration?.samples ?? 0)) {
      calibrations[turnKey] = next;
      // Synchronous on purpose: one small file, and the event path is idle
      // between turns. A missed write costs a few turns of re-learning.
      saveCalibrations({ [turnKey]: next });
    }
    stopTick();
    paint(ctx);
  });

  // Belt and braces: no stream survives the end of the agent loop.
  pi.on("agent_end", () => stopTick());

  pi.on("session_shutdown", (_event, ctx) => {
    stopTick();
    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
  });
}

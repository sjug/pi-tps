import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import type { Calibration } from "./calibrate.ts";

const SETTINGS_KEY = "piTps";

/** Pi's agent dir, honouring the same override Pi itself reads. */
function defaultPath(): string {
  if (process.env.PI_TPS_SETTINGS) return process.env.PI_TPS_SETTINGS;
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(agentDir, "settings.json");
}

function isCalibration(value: unknown): value is Calibration {
  if (typeof value !== "object" || value === null) return false;
  const c = value as Record<string, unknown>;
  return (
    typeof c.ratio === "number" &&
    Number.isFinite(c.ratio) &&
    c.ratio > 0 &&
    typeof c.samples === "number" &&
    Number.isFinite(c.samples) &&
    c.samples >= 0
  );
}

function parseCalibrationMap(raw: unknown): Record<string, Calibration> {
  const out: Record<string, Calibration> = {};
  if (typeof raw !== "object" || raw === null) return out;
  for (const [key, value] of Object.entries(raw)) {
    if (isCalibration(value)) out[key] = value;
  }
  return out;
}

function readAll(path: string): Record<string, unknown> {
  try {
    const all = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")) as unknown;
    if (typeof all !== "object" || all === null || Array.isArray(all)) {
      throw new Error("Settings must be a JSON object");
    }
    return all as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

function section(all: Record<string, unknown>): Record<string, unknown> {
  const raw = all[SETTINGS_KEY];
  return typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};
}

export function loadCalibrations(path: string = defaultPath()): Record<string, Calibration> {
  try {
    return parseCalibrationMap(section(readAll(path)).calibration);
  } catch {
    return {};
  }
}

/**
 * Persist learned ratios into Pi's settings.json.
 *
 * Read-merge-write under Pi's own lock: the file belongs to Pi and every
 * other extension, and Pi's SettingsManager writes it with proper-lockfile.
 * The merge goes one level into the calibration map because a second Pi
 * session holds its own copy. Pass only changed model entries, not the whole
 * session cache. For the same model, the last successful write wins.
 * The write lands via rename so a reader never sees a torn file.
 *
 * Failures are swallowed: the in-memory ratio still holds for this session
 * and the next learned sample for that model attempts another write.
 */
export function saveCalibrations(
  calibrations: Record<string, Calibration>,
  path: string = defaultPath(),
): void {
  let release: (() => void) | null = null;
  try {
    mkdirSync(dirname(path), { recursive: true });
    release = lockfile.lockSync(path, { realpath: false });
    const all = readAll(path);
    const prev = section(all);
    all[SETTINGS_KEY] = {
      ...prev,
      calibration: { ...parseCalibrationMap(prev.calibration), ...calibrations },
    };
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(all, null, 2)}\n`);
    renameSync(tmp, path);
  } catch {
    // Ignore — losing one update is not worth interrupting a session over.
  } finally {
    release?.();
  }
}

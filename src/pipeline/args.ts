import { initEnvFromArgs } from "../config.js";
import { numberArg, stringArg } from "../media/utils.js";

export type SelectionMode = "all" | "single" | "ids" | "failed";

export function parseIdsCsv(raw: string | undefined): number[] {
  if (!raw) return [];
  return [...new Set(raw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n > 0))];
}

export function parseSelection(argv: string[], envPrefix: string): {
  mode: SelectionMode;
  singleId?: number;
  ids: number[];
  offset: number;
  limit: number;
} {
  const mode = (stringArg(argv, "--mode") ??
    process.env[`${envPrefix}_MODE`] ??
    "all") as SelectionMode;
  const singleId = numberArg(argv, "--single-id");
  const ids = parseIdsCsv(stringArg(argv, "--ids") ?? process.env[`${envPrefix}_IDS`]);
  const offset = numberArg(argv, "--offset") ?? (Number(process.env[`${envPrefix}_OFFSET`] ?? "0") || 0);
  const limit =
    numberArg(argv, "--limit") ??
    (Number(process.env[`${envPrefix}_LIMIT`] ?? process.env.MEDIA_BATCH_SIZE ?? "25") || 25);
  return { mode, singleId, ids, offset: Math.max(0, offset), limit: Math.max(1, limit) };
}

export function initPipelineEnv(argv: string[]): void {
  initEnvFromArgs(argv);
}

export { stringArg, numberArg };

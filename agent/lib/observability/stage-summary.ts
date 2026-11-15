/**
 * The single whitelist that decides what a station's structured output may
 * tell the run panel (M6-T1).
 *
 * @remarks
 * Boundary: conversation content never reaches the records directory; station
 * outputSchema fields are machine-readable data the orchestrator already
 * consumes. This module projects ONLY telemetry-grade derivations of those
 * fields — enums, booleans, capped one-liners, and array counts — and nothing
 * else passes. Free-text bodies (plans, findings, criteria, diffs) reduce to
 * counts. Every key produced here IS the whitelist; adding one is a review-gate
 * change (M6-T6), not an incidental edit.
 */

import { annotateStageSummary } from "./run-store.js";

/** The telemetry-grade value shapes a summary field may take. */
export type SummaryValue = boolean | number | string;

/**
 * Wire-side helper for the `run_*` wrapper tools: project and record, never
 * fail the station call over the panel.
 *
 * @remarks
 * A `"use step"` function: the run store lives on `node:fs`, which workflow
 * tools may only reach through a step; the write is idempotent (latest-wins
 * per station), so step replay applies it safely. Callers await it after
 * `ctx.agent` returns; failures are swallowed by design — a panel write must
 * never fail the station call.
 *
 * @param rootSessionId - The orchestrator session that called the wrapper
 * (`ctx.session.id`); summaries attribute to its run record.
 */
export async function recordStageSummary(
  rootSessionId: string,
  station: string,
  output: unknown
): Promise<void> {
  "use step";
  try {
    const summary = stageSummaryFor(station, output);
    if (summary !== null) {
      await annotateStageSummary(rootSessionId, station, summary);
    }
  } catch {
    // Best-effort telemetry: swallowed by design.
  }
}

/** Hard cap for any string field; longer values are truncated, never stored whole. */
const STRING_CAP = 120;

const capped = (value: unknown): string | undefined => {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  if (value.length <= STRING_CAP) {
    return value;
  }
  return `${value.slice(0, STRING_CAP - 1)}…`;
};

const boolean = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const count = (value: unknown): number | undefined =>
  Array.isArray(value) ? value.length : undefined;

/**
 * Project one station's structured output into its whitelist summary.
 *
 * @param station - The station name (`classifier`, `researcher`, `analyst`,
 * `implementer`, `reviewer`).
 * @param output - The typed output the wrapper received from `ctx.agent`.
 * @returns The whitelisted fields, or null when the station has no whitelist
 * or the output is not an object.
 */
export function stageSummaryFor(
  station: string,
  output: unknown
): Record<string, SummaryValue> | null {
  if (typeof output !== "object" || output === null) {
    return null;
  }
  const source = output as Record<string, unknown>;
  const summary: Record<string, SummaryValue> = {};
  const put = (key: string, value: SummaryValue | undefined): void => {
    if (value !== undefined) {
      summary[key] = value;
    }
  };
  switch (station) {
    case "classifier":
      put("type", capped(source.type));
      put("complexity", capped(source.complexity));
      put("priority", capped(source.priority));
      put("actionable", boolean(source.actionable));
      put("needsClarification", boolean(source.needs_clarification));
      break;
    case "researcher":
      put("findingCount", count(source.findings));
      put("gapCount", count(source.gaps));
      put(
        "artifactSaved",
        typeof source.artifact_id === "string" && source.artifact_id.length > 0
      );
      break;
    case "analyst":
      put("problemStatement", capped(source.problem_statement));
      put("criteriaCount", count(source.acceptance_criteria));
      put("riskCount", count(source.risks));
      put(
        "artifactSaved",
        typeof source.artifact_id === "string" && source.artifact_id.length > 0
      );
      break;
    case "implementer": {
      put("branch", capped(source.branch));
      put("pushed", boolean(source.pushed));
      put("verificationCount", count(source.verification));
      put("deviationCount", count(source.deviations));
      break;
    }
    case "reviewer": {
      put("verdict", capped(source.verdict));
      put("blockingCount", count(source.blocking_findings));
      put("suggestionCount", count(source.suggestions));
      const criteria = Array.isArray(source.criteria_results)
        ? source.criteria_results
        : [];
      put("criteriaTotal", criteria.length);
      put(
        "criteriaPassed",
        criteria.filter(
          (entry) =>
            typeof entry === "object" &&
            entry !== null &&
            (entry as { pass?: unknown }).pass === true
        ).length
      );
      break;
    }
    default:
      return null;
  }
  return Object.keys(summary).length > 0 ? summary : null;
}

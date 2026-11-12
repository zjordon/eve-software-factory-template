import { defineInstrumentation } from "eve/instrumentation";
import {
  type RunRecord,
  sweepExpired,
  type TokenTotal,
  upsertRun,
} from "../lib/observability/run-store.js";

/**
 * Actions that become timeline stages on a run record.
 *
 * @remarks
 * The five station wrappers (`run_classifier`, `run_researcher`,
 * `run_analyst`, `run_implementer`, `run_reviewer`) are matched by prefix so a
 * station added later is tracked without an edit here. `push_branch` and the
 * GitHub PR creation are the two shipping milestones the panel calls out.
 */
const isStageAction = (name: string): boolean =>
  name.startsWith("run_") ||
  name === "push_branch" ||
  name === "github__createPullRequest";

const nowIso = (): string => new Date().toISOString();

/** Ring caps on per-record lists, so a pathological run stays bounded. */
const TURN_FAILURES_CAP = 10;
const ACTION_ERRORS_CAP = 5;
const INPUT_REQUESTS_CAP = 50;
const STAGES_CAP = 50;

/** The dedupe key for one event: type plus the operation's idempotency key. */
const dedupeKey = (type: string, idempotencyKey: string): string =>
  `${type}:${idempotencyKey}`;

const tokensFromUsage = (
  usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        inputTokenDetails?: {
          cacheReadTokens?: number;
          cacheWriteTokens?: number;
        };
      }
    | undefined,
  calls = 1
): TokenTotal => ({
  cacheReadTokens: usage?.inputTokenDetails?.cacheReadTokens ?? 0,
  cacheWriteTokens: usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
  calls,
  inputTokens: usage?.inputTokens ?? 0,
  outputTokens: usage?.outputTokens ?? 0,
});

const addTokens = (total: TokenTotal, addend: TokenTotal): void => {
  total.calls += addend.calls;
  total.inputTokens += addend.inputTokens;
  total.outputTokens += addend.outputTokens;
  total.cacheReadTokens += addend.cacheReadTokens;
  total.cacheWriteTokens += addend.cacheWriteTokens;
};

/** The run a scope belongs to: the root session, defaulting to its own session when the root is omitted (root sessions). */
const rootOf = (scope: { rootSessionId?: string; sessionId: string }): string =>
  scope.rootSessionId ?? scope.sessionId;

/** Whether a scope describes the root session itself rather than a station child. */
const isRootScope = (scope: {
  rootSessionId?: string;
  sessionId: string;
}): boolean =>
  scope.rootSessionId === undefined || scope.rootSessionId === scope.sessionId;

/**
 * Find this action's stage entry by the idempotency key.
 *
 * @remarks
 * Terminal action events carry no name or callId; the start and its terminal
 * share the idempotencyKey, which is what correlates them. Station wrappers
 * can run repeatedly within one run (reviewer revision cycles), so stages key
 * per action, not per name.
 */
const findStage = (
  record: RunRecord,
  idempotencyKey: string
): RunRecord["stages"][number] | undefined =>
  record.stages.find((stage) => stage.key === idempotencyKey);

/**
 * The run-recorder instrumentation: the M5 observability data plane.
 *
 * @remarks
 * Every root session becomes one record under `.eve/run-records/`; station
 * child sessions attribute their model usage and milestone actions to the root
 * through `scope.rootSessionId`. All handlers upsert through the store's
 * `${event.type}:${idempotencyKey}` dedupe, so events replayed after a
 * restart (an M4-verified constant of the resident form) apply exactly once.
 * `tracePolicy` is metadata-only by explicit decision: no prompt, reply, tool
 * argument, or error detail is ever recorded, which is what keeps the panel
 * free of conversation content. Error typing therefore leans on structural
 * `errorCode` fields (action failures); turn-level failures record "unknown"
 * when no action code is available.
 */
export default defineInstrumentation({
  events: {
    "action.completed": (event) =>
      // Ordinary tool completions carry no stage or run-level signal (model
      // usage is aggregated from model.call events), so writeIf keeps them
      // free: no write per tool call.
      upsertRun(
        rootOf(event.scope),
        (record) => {
          const stage = findStage(record, event.idempotencyKey);
          if (stage !== undefined) {
            stage.completedAt = nowIso();
            stage.outcome = "completed";
            stage.durationMs =
              new Date(stage.completedAt).getTime() -
              new Date(stage.startedAt).getTime();
            if (event.usage !== undefined) {
              stage.tokens = tokensFromUsage(event.usage);
            }
          }
        },
        {
          dedupeKey: dedupeKey(event.type, event.idempotencyKey),
          writeIf: (record) =>
            findStage(record, event.idempotencyKey) !== undefined,
        }
      ),
    "action.failed": (event) =>
      upsertRun(
        rootOf(event.scope),
        (record) => {
          const stage = findStage(record, event.idempotencyKey);
          if (stage !== undefined) {
            stage.completedAt = nowIso();
            stage.outcome = event.outcome;
            stage.durationMs =
              new Date(stage.completedAt).getTime() -
              new Date(stage.startedAt).getTime();
          }
          record.actionErrors = [
            ...record.actionErrors,
            { at: nowIso(), errorCode: event.errorCode ?? "unknown" },
          ].slice(-ACTION_ERRORS_CAP);
        },
        { dedupeKey: dedupeKey(event.type, event.idempotencyKey) }
      ),
    "action.started": (event) =>
      isStageAction(event.name)
        ? upsertRun(
            rootOf(event.scope),
            (record) => {
              record.stages = [
                ...record.stages,
                {
                  callId: event.callId,
                  completedAt: null,
                  durationMs: null,
                  key: event.idempotencyKey,
                  name: event.name,
                  outcome: null,
                  startedAt: nowIso(),
                  tokens: null,
                },
              ];
              if (record.stages.length > STAGES_CAP) {
                // Drop the oldest closed stage; open stages stay so their
                // terminal event still lands.
                const oldestClosed = record.stages.findIndex(
                  (stage) => stage.completedAt !== null
                );
                record.stages.splice(oldestClosed === -1 ? 0 : oldestClosed, 1);
              }
            },
            { dedupeKey: dedupeKey(event.type, event.idempotencyKey) }
          )
        : undefined,
    "channel.delivery.completed": (event) =>
      event.sessionId === event.rootSessionId
        ? upsertRun(
            event.sessionId,
            (record) => {
              record.deliveries.count += 1;
              record.deliveries.lastAt = nowIso();
            },
            { dedupeKey: dedupeKey(event.type, event.idempotencyKey) }
          )
        : undefined,
    "channel.delivery.failed": (event) =>
      event.sessionId === event.rootSessionId
        ? upsertRun(
            event.sessionId,
            (record) => {
              record.deliveries.count += 1;
              record.deliveries.lastAt = nowIso();
            },
            { dedupeKey: dedupeKey(event.type, event.idempotencyKey) }
          )
        : undefined,
    "input.requested": (event) =>
      isRootScope(event.scope)
        ? upsertRun(
            event.scope.sessionId,
            (record) => {
              record.inputRequests = [
                ...record.inputRequests.filter(
                  (request) => request.requestId !== event.requestId
                ),
                {
                  kind: event.kind,
                  outcome: null,
                  requestedAt: nowIso(),
                  requestId: event.requestId,
                  resolvedAt: null,
                },
              ];
              // Prune the overflow off the oldest resolved entries;
              // unresolved ones are exactly what the hang detector needs to
              // keep, even past the cap.
              const open = record.inputRequests.filter(
                (request) => request.resolvedAt === null
              );
              const resolved = record.inputRequests.filter(
                (request) => request.resolvedAt !== null
              );
              if (record.inputRequests.length > INPUT_REQUESTS_CAP) {
                const drop = Math.min(
                  resolved.length,
                  record.inputRequests.length - INPUT_REQUESTS_CAP
                );
                record.inputRequests = [...resolved.slice(drop), ...open];
              }
            },
            { dedupeKey: dedupeKey(event.type, event.idempotencyKey) }
          )
        : undefined,
    "input.resolved": (event) =>
      isRootScope(event.scope)
        ? upsertRun(
            event.scope.sessionId,
            (record) => {
              const request = record.inputRequests.find(
                (entry) => entry.requestId === event.requestId
              );
              if (request !== undefined && request.resolvedAt === null) {
                request.resolvedAt = nowIso();
                request.outcome = event.outcome;
              }
            },
            { dedupeKey: dedupeKey(event.type, event.idempotencyKey) }
          )
        : undefined,
    "model.call.completed": (event) =>
      upsertRun(
        rootOf(event.scope),
        (record) => {
          addTokens(record.modelUsage, tokensFromUsage(event.usage));
        },
        { dedupeKey: dedupeKey(event.type, event.idempotencyKey) }
      ),
    "session.completed": (event) =>
      upsertRun(
        event.sessionId,
        (record) => {
          record.status = "completed";
          record.terminal ??= { at: nowIso(), errorType: "unknown" };
        },
        { onlyIfExists: true }
      ),
    "session.failed": (event) =>
      upsertRun(
        event.sessionId,
        (record) => {
          record.status = "failed";
          record.terminal ??= { at: nowIso(), errorType: "unknown" };
        },
        { onlyIfExists: true }
      ),
    "session.started": (event) =>
      // Child (station) sessions attribute to their root and never get a
      // record of their own.
      event.parentLineage === undefined
        ? upsertRun(event.sessionId, (record) => {
            record.channel ??= event.channelType ?? event.channelKind ?? null;
            if (record.title === null && typeof event.title === "string") {
              record.title = event.title;
            }
          })
        : undefined,
    "session.waiting": (event) =>
      upsertRun(
        event.sessionId,
        (record) => {
          if (record.terminal === null) {
            record.status = "waiting";
          }
        },
        { onlyIfExists: true }
      ),
    "turn.cancelled": (event) =>
      upsertRun(
        event.sessionId,
        (record) => {
          record.failureStreak = 0;
        },
        {
          dedupeKey: dedupeKey(event.type, event.idempotencyKey),
          onlyIfExists: true,
        }
      ),
    // Terminal turn events carry no rootSessionId, so root filtering rides on
    // onlyIfExists: station child sessions have no record to update.
    "turn.completed": (event) =>
      upsertRun(
        event.sessionId,
        (record) => {
          record.failureStreak = 0;
        },
        {
          dedupeKey: dedupeKey(event.type, event.idempotencyKey),
          onlyIfExists: true,
        }
      ),
    "turn.failed": (event) =>
      upsertRun(
        event.sessionId,
        (record) => {
          record.turns.failed += 1;
          record.failureStreak += 1;
          // Turn error details are content and are not recorded; the most
          // recent action error code (structural, recorded) types the loop.
          const lastActionError = record.actionErrors.at(-1);
          record.turnFailures = [
            ...record.turnFailures,
            {
              at: nowIso(),
              errorType: lastActionError?.errorCode ?? "unknown",
              turnId: event.turnId,
            },
          ].slice(-TURN_FAILURES_CAP);
        },
        {
          dedupeKey: dedupeKey(event.type, event.idempotencyKey),
          onlyIfExists: true,
        }
      ),
    "turn.started": (event) =>
      event.sessionId === event.rootSessionId
        ? upsertRun(
            event.sessionId,
            (record) => {
              record.turns.started += 1;
              if (record.terminal === null) {
                record.status = "running";
              }
              if (
                event.initiatorPrincipal !== undefined &&
                record.principal === null
              ) {
                record.principal = {
                  id: event.initiatorPrincipal.id ?? "unknown",
                  type: event.initiatorPrincipal.type,
                };
              }
            },
            { dedupeKey: dedupeKey(event.type, event.idempotencyKey) }
          )
        : undefined,
  },
  setup: async () => {
    await sweepExpired().catch((error: unknown) => {
      console.error("runs instrumentation: retention sweep failed", error);
    });
  },
  tracePolicy: () => ({
    emit: true,
    recordInputs: false,
    recordOutputs: false,
  }),
});

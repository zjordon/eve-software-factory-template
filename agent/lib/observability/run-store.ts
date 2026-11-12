import {
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

/**
 * Which GitHub surface a run's thread lives on, parsed from the channel's
 * continuation token (`repo:<id>:issue:<n>` / `repo:<id>:pull:<n>` /
 * `repo:<id>:pull:<n>:review-comment:<cid>`).
 */
export interface RunThreadRef {
  readonly kind: "issue" | "pull" | "review_thread";
  readonly number: number;
}

/** Token totals for one run or one stage, aggregated from model/action usage. */
export interface TokenTotal {
  cacheReadTokens: number;
  cacheWriteTokens: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
}

/** One pipeline station (or milestone action) as a timeline entry. */
export interface RunStage {
  readonly callId: string;
  completedAt: string | null;
  durationMs: number | null;
  /** The action's idempotency key: terminal action events correlate on it. */
  readonly key: string;
  readonly name: string;
  outcome: string | null;
  readonly startedAt: string;
  tokens: TokenTotal | null;
}

/** One recorded turn failure; `errorType` is the action-layer error code when one is available. */
export interface TurnFailureEntry {
  readonly at: string;
  readonly errorType: string;
  readonly turnId: string;
}

/** One approval/question card lifecycle, for the panel and the hang detector. */
export interface InputRequestEntry {
  readonly kind: string;
  outcome: string | null;
  readonly requestedAt: string;
  readonly requestId: string;
  resolvedAt: string | null;
}

/** A failed action's structural error code, kept recent for error typing. */
export interface ActionErrorEntry {
  readonly at: string;
  readonly errorCode: string;
}

/**
 * One factory run: the lifecycle of a root session (a labeled issue, a
 * mention, a CI-fix dispatch), as reconstructed from instrumentation events.
 *
 * @remarks
 * Child (station) sessions never get their own record: their model usage and
 * stage actions are attributed to the root through `scope.rootSessionId`.
 */
export interface RunRecord {
  actionErrors: ActionErrorEntry[];
  channel: string | null;
  createdAt: string;
  deliveries: { count: number; lastAt: string | null };
  failureStreak: number;
  inputRequests: InputRequestEntry[];
  intakeIssue: number | null;
  modelUsage: TokenTotal;
  principal: { type: string; id: string } | null;
  prUrl: string | null;
  seenKeys: string[];
  readonly sessionId: string;
  stages: RunStage[];
  status: "running" | "waiting" | "completed" | "failed";
  terminal: { at: string; errorType: string } | null;
  thread: RunThreadRef | null;
  title: string | null;
  turnFailures: TurnFailureEntry[];
  turns: { started: number; failed: number };
  updatedAt: string;
}

/** A zombie classification computed at read time; null when the run looks healthy. */
export interface ZombieFlag {
  readonly detail: string;
  readonly since: string;
  readonly type: "approval-hang" | "error-loop";
}

/** A run as the list view shows it: the record plus derived fields. */
export interface RunSummary {
  readonly durationMs: number;
  readonly record: RunRecord;
  readonly zombie: ZombieFlag | null;
}

/** Token/run totals for one calendar day (UTC), for the aggregate view. */
export interface DailyTotal {
  readonly day: string;
  readonly failedRuns: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly runs: number;
  readonly totalDurationMs: number;
}

/** How long an unresolved input request may sit before the run counts as hung. */
const APPROVAL_HANG_MS = 30 * 60 * 1000;

/** Consecutive turn failures that mark an error loop. */
const ERROR_LOOP_STREAK = 2;

/** How long a terminal run's record is kept before the sweep deletes it. */
export const RETENTION_DAYS = 30;

/** Ring cap for dedupe keys: bounded memory per record even for pathological runs. */
const SEEN_KEYS_CAP = 1000;

/** Session ids are filename-safe by construction; anything else is refused. */
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Root directory for run records, resolved at module load so relative values
 * anchor to the process working directory (the same posture as the local Blob
 * backend in `agent/lib/blob.ts`).
 */
const RECORDS_DIR = resolve(
  process.env.FACTORY_RUN_RECORDS_DIR ?? ".eve/run-records"
);

/** Maps a session id to its record path, refusing ids that would escape. */
function recordPath(sessionId: string): string {
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(
      `Refusing a run-record key with unsafe characters: ${sessionId}`
    );
  }
  const path = resolve(RECORDS_DIR, `${sessionId}.json`);
  if (path !== RECORDS_DIR && !path.startsWith(`${RECORDS_DIR}${sep}`)) {
    throw new Error(
      `Refusing a run-record key that escapes the records directory: ${sessionId}`
    );
  }
  return path;
}

const enoentCode = (error: unknown): string | null =>
  error instanceof Error && "code" in error
    ? String((error as NodeJS.ErrnoException).code)
    : null;

/**
 * Per-session write chains: instrumentation events, channel annotations, and
 * sweeps can interleave, so every read-modify-write on one record is queued
 * behind the previous one. Map growth is bounded by active sessions.
 */
const writeChains = new Map<string, Promise<void>>();

function enqueue<T>(
  sessionId: string,
  operation: () => Promise<T>
): Promise<T> {
  // The stored chain never rejects: a failed operation must not poison the
  // next write on the same record.
  const previous = writeChains.get(sessionId) ?? Promise.resolve();
  const chained = previous.then(operation);
  writeChains.set(
    sessionId,
    chained.then(
      () => undefined,
      () => undefined
    )
  );
  return chained;
}

const nowIso = (): string => new Date().toISOString();

const emptyTokens = (): TokenTotal => ({
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  calls: 0,
  inputTokens: 0,
  outputTokens: 0,
});

const freshRecord = (sessionId: string): RunRecord => ({
  actionErrors: [],
  channel: null,
  createdAt: nowIso(),
  deliveries: { count: 0, lastAt: null },
  failureStreak: 0,
  inputRequests: [],
  intakeIssue: null,
  modelUsage: emptyTokens(),
  principal: null,
  prUrl: null,
  seenKeys: [],
  sessionId,
  stages: [],
  status: "running",
  terminal: null,
  thread: null,
  title: null,
  turnFailures: [],
  turns: { failed: 0, started: 0 },
  updatedAt: nowIso(),
});

async function readRecord(sessionId: string): Promise<RunRecord | null> {
  try {
    const contents = await readFile(recordPath(sessionId), "utf8");
    const parsed = JSON.parse(contents) as RunRecord;
    return parsed.sessionId === sessionId ? parsed : null;
  } catch (error) {
    if (enoentCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function writeRecord(record: RunRecord): Promise<void> {
  const path = recordPath(record.sessionId);
  const tmpPath = `${path}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await rm(tmpPath, { force: true });
  await writeFile(tmpPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(tmpPath, path);
}

/**
 * Mutate one run record under the session's write chain.
 *
 * @remarks
 * With `dedupeKey` set (`${event.type}:${idempotencyKey}` at the call site),
 * an event already applied to the record is skipped whole, so replayed events
 * after a restart cannot double-count turns, stages, or tokens. The cap on
 * `seenKeys` means a replay of an event pushed out of the ring long ago could
 * re-apply; at factory volume (well under the cap per run) that is theoretical.
 * `writeIf` gates the write on the record (a terminal action event with no
 * matching stage stays free). Storage failures are swallowed and logged: this
 * is an observability side channel and must never break a dispatch or a turn.
 */
export const upsertRun = (
  sessionId: string,
  mutator: (record: RunRecord) => void,
  options?: {
    dedupeKey?: string;
    onlyIfExists?: boolean;
    writeIf?: (record: RunRecord) => boolean;
  }
): Promise<void> =>
  enqueue(sessionId, async () => {
    try {
      const existing = await readRecord(sessionId);
      if (existing === null && options?.onlyIfExists) {
        return;
      }
      const key = options?.dedupeKey;
      if (
        existing !== null &&
        key !== undefined &&
        existing.seenKeys.includes(key)
      ) {
        return;
      }
      const record = existing ?? freshRecord(sessionId);
      if (key !== undefined) {
        record.seenKeys = [...record.seenKeys, key].slice(-SEEN_KEYS_CAP);
      }
      if (options?.writeIf !== undefined && !options.writeIf(record)) {
        return;
      }
      mutator(record);
      record.updatedAt = nowIso();
      await writeRecord(record);
    } catch (error) {
      console.error(
        `run-store: failed to update record for ${sessionId}`,
        error
      );
    }
  });

/**
 * Attach channel-layer metadata (GitHub thread identity, intake issue, PR
 * link) to a run record.
 *
 * @remarks
 * The GitHub channel learns a session's thread from its continuation token
 * and auth stamps, which instrumentation events do not carry. This can run
 * before or after the instrumentation saw `session.started`; either order
 * converges because fields are only filled, never overwritten.
 */
export const annotateRun = (
  sessionId: string,
  annotation: {
    thread?: RunThreadRef | null;
    intakeIssue?: number | null;
    prUrl?: string | null;
  }
): Promise<void> =>
  enqueue(sessionId, async () => {
    try {
      const record = (await readRecord(sessionId)) ?? freshRecord(sessionId);
      if (annotation.thread !== null && annotation.thread !== undefined) {
        record.thread = annotation.thread;
      }
      if (
        annotation.intakeIssue !== null &&
        annotation.intakeIssue !== undefined
      ) {
        record.intakeIssue = annotation.intakeIssue;
      }
      if (annotation.prUrl !== null && annotation.prUrl !== undefined) {
        record.prUrl = annotation.prUrl;
      }
      record.updatedAt = nowIso();
      await writeRecord(record);
    } catch (error) {
      console.error(
        `run-store: failed to annotate record for ${sessionId}`,
        error
      );
    }
  });

/** Read one run record, or null when no record exists (yet). */
export const getRun = (sessionId: string): Promise<RunRecord | null> =>
  enqueue(sessionId, () => readRecord(sessionId)).catch(() => null);

/** Record files present in the records directory (ids, without extension). */
async function recordIds(): Promise<string[]> {
  try {
    const entries = await readdir(RECORDS_DIR);
    return entries
      .filter((entry) => entry.endsWith(".json"))
      .map((entry) => entry.slice(0, -".json".length))
      .filter((id) => SESSION_ID_PATTERN.test(id));
  } catch (error) {
    if (enoentCode(error) === "ENOENT") {
      return [];
    }
    throw error;
  }
}

/** How often the opportunistic sweep runs when records are listed. */
const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

let lastSweepAt = 0;

/**
 * List runs newest-first, zombies pinned to the top.
 *
 * @remarks
 * Also runs the retention sweep at most once per hour in-process: the pm2
 * resident form restarts rarely enough that a timer would be the only other
 * driver, and this keeps the module timer-free.
 */
export const listRuns = async (limit = 50): Promise<RunSummary[]> => {
  const ids = await recordIds();
  const records = (await Promise.all(ids.map((id) => getRun(id)))).flatMap(
    (record) => (record === null ? [] : [record])
  );
  const summaries = records.map(summarizeRun);
  summaries.sort((a, b) => {
    const zombieRank = (run: RunSummary): number =>
      run.zombie === null ? 1 : 0;
    return (
      zombieRank(a) - zombieRank(b) ||
      b.record.updatedAt.localeCompare(a.record.updatedAt)
    );
  });
  if (Date.now() - lastSweepAt > SWEEP_INTERVAL_MS) {
    lastSweepAt = Date.now();
    await sweepExpired().catch((error: unknown) => {
      console.error("run-store: retention sweep failed", error);
    });
  }
  return summaries.slice(0, limit);
};

/** Derive the list-view fields (zombie flag, wall duration) for one record. */
export const summarizeRun = (record: RunRecord): RunSummary => ({
  durationMs:
    new Date(record.updatedAt).getTime() - new Date(record.createdAt).getTime(),
  record,
  zombie: detectZombie(record),
});

/** Token totals for one day plus run counts, grouped by UTC day. */
export const dailyTotals = (records: readonly RunRecord[]): DailyTotal[] => {
  const byDay = new Map<string, DailyTotal>();
  for (const record of records) {
    const day = record.createdAt.slice(0, 10);
    const current =
      byDay.get(day) ??
      ({
        day,
        failedRuns: 0,
        inputTokens: 0,
        outputTokens: 0,
        runs: 0,
        totalDurationMs: 0,
      } satisfies DailyTotal);
    byDay.set(day, {
      day,
      failedRuns: current.failedRuns + (record.status === "failed" ? 1 : 0),
      inputTokens: current.inputTokens + record.modelUsage.inputTokens,
      outputTokens: current.outputTokens + record.modelUsage.outputTokens,
      runs: current.runs + 1,
      totalDurationMs:
        current.totalDurationMs +
        (new Date(record.updatedAt).getTime() -
          new Date(record.createdAt).getTime()),
    });
  }
  return [...byDay.values()].sort((a, b) => b.day.localeCompare(a.day));
};

/**
 * Classify a run as a zombie, from the M4 session-zombie taxonomy.
 *
 * @remarks
 * Approval hang: an input request (usually an approval card) never resolved
 * while the session sits non-terminal past the threshold. Error loop:
 * consecutive turn failures at or above the streak threshold, typed by the
 * most recent action error code (turn-level error details are content and are
 * not recorded under the metadata-only policy).
 */
export function detectZombie(record: RunRecord): ZombieFlag | null {
  if (record.terminal === null) {
    const hung = record.inputRequests.find(
      (request) =>
        request.resolvedAt === null &&
        Date.now() - new Date(request.requestedAt).getTime() > APPROVAL_HANG_MS
    );
    if (hung !== undefined) {
      return {
        detail: `unresolved ${hung.kind} for over ${Math.round(APPROVAL_HANG_MS / 60_000)} minutes`,
        since: hung.requestedAt,
        type: "approval-hang",
      };
    }
  }
  if (record.failureStreak >= ERROR_LOOP_STREAK) {
    const last = record.turnFailures.at(-1);
    return {
      detail: `${record.failureStreak} consecutive failed turns${
        last === undefined ? "" : ` (last: ${last.errorType})`
      }`,
      since: last?.at ?? record.updatedAt,
      type: "error-loop",
    };
  }
  return null;
}

/**
 * Delete terminal records past the retention window and stale temp files.
 *
 * @remarks
 * Called once at instrumentation setup and opportunistically from
 * {@link listRuns}; failures are logged and non-fatal.
 */
export const sweepExpired = async (): Promise<void> => {
  const cutoff = Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000;
  const expired = (
    await Promise.all(
      (
        await recordIds()
      ).map(async (id) => {
        const record = await readRecord(id).catch(() => null);
        return record?.terminal !== null &&
          record?.terminal !== undefined &&
          new Date(record.terminal.at).getTime() < cutoff
          ? recordPath(id)
          : null;
      })
    )
  ).flatMap((path) => (path === null ? [] : [path]));
  await Promise.all(expired.map((path) => rm(path, { force: true })));
  const entries = await readdir(RECORDS_DIR).catch(() => []);
  await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".tmp"))
      .map(async (entry) => {
        const path = resolve(RECORDS_DIR, entry);
        const info = await stat(path).catch(() => null);
        if (info !== null && info.mtimeMs < Date.now() - SWEEP_INTERVAL_MS) {
          await rm(path, { force: true });
        }
      })
  );
};

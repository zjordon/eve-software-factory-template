import { createAnthropic } from "@ai-sdk/anthropic";

// One place to change every agent's model. The upstream template uses Vercel AI
// Gateway strings (<provider>/<model>); this fork points every agent at Zhipu's
// Anthropic-compatible endpoint instead, so a GLM Coding Plan subscription
// covers the usage. The key comes from ZHIPU_API_KEY (env), never hardcoded;
// ZHIPU_BASE_URL overrides the endpoint (set it to https://api.z.ai/api/anthropic/v1
// on the international plan). The /v1 suffix is required: @ai-sdk/anthropic v4
// appends /messages to the baseURL without inserting the version segment, and
// Zhipu's gateway answers the versionless path with HTTP 200 and an empty
// stream, which surfaces as AI_NoOutputGeneratedError.

/**
 * Failure-only transport logging for the Zhipu gateway (issue #9).
 *
 * @remarks
 * The run panel keeps structural error codes, but the GLM endpoint
 * intermittently kills long tool-heavy streaming calls with a client-side
 * error that carries no HTTP signal at all (the harness's parking log prints
 * `details: {}`), so the gateway's raw behavior at the moment of failure is
 * the only evidence that can separate a transport cut from a protocol
 * defect. This wrapper records, to the process log (pm2) only — never into
 * run records: transport rejections with their cause, non-2xx responses with
 * a bounded body excerpt, and SSE streams that end without a terminal event
 * (`message_stop` / `[DONE]`) with the byte count, the event-type sequence,
 * and whether a tool_use block appeared (the suspected defect signature).
 * Successful calls log nothing. Beyond the logs the transport is byte-for-
 * byte pass-through.
 */

/** State accumulated while one gateway response streams through the wrapper. */
interface StreamTrace {
  bytes: number;
  eventTypes: string[];
  sawTerminal: boolean;
  sawToolUse: boolean;
}

/** Statuses whose Response constructor rejects a non-null body. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

const requestPath = (input: RequestInfo | URL): string => {
  const toPath = (value: string): string => {
    try {
      return new URL(value).pathname;
    } catch {
      return "(unparsed url)";
    }
  };
  if (typeof input === "string") {
    return toPath(input);
  }
  if (input instanceof URL) {
    return toPath(input.href);
  }
  const { url } = input;
  return toPath(url);
};

/** Log a natural stream end that never saw a terminal event. */
const logIfUnterminated = (
  trace: StreamTrace,
  startedAt: number,
  path: string
): void => {
  if (!trace.sawTerminal) {
    console.error(
      `zhipu-fetch: stream ended without a terminal event after ${Date.now() - startedAt}ms ${path}: ${trace.bytes}B, tool_use seen: ${trace.sawToolUse}, event types: ${trace.eventTypes.slice(-12).join(" > ") || "(none parsed)"}`
    );
  }
};

/**
 * Fold one SSE line into the trace: the event-type sequence (consecutive
 * duplicates collapsed) plus the terminal and tool_use flags.
 */
const trackSseLine = (line: string, trace: StreamTrace): void => {
  if (line.startsWith("event:")) {
    const name = line.slice("event:".length).trim();
    if (name.length > 0 && trace.eventTypes.at(-1) !== name) {
      trace.eventTypes.push(name);
    }
    if (name === "message_stop") {
      trace.sawTerminal = true;
    }
  }
  if (line.includes("[DONE]")) {
    trace.sawTerminal = true;
  }
  if (line.includes('"tool_use"')) {
    trace.sawToolUse = true;
  }
};

/**
 * Wrap a gateway response body in a pull-based stream that folds SSE lines
 * into the trace and logs the three abnormal endings: a natural end without a
 * terminal event, a read failure mid-stream, and a consumer-side cancel.
 */
const trackedBody = (
  body: ReadableStream<Uint8Array>,
  trace: StreamTrace,
  startedAt: number,
  path: string
): ReadableStream<Uint8Array> => {
  const reader = body.getReader();
  let tail = "";
  let cancelled = false;
  const decoder = new TextDecoder();
  return new ReadableStream<Uint8Array>({
    async cancel(reason) {
      cancelled = true;
      console.error(
        `zhipu-fetch: stream cancelled by consumer after ${Date.now() - startedAt}ms ${path}: ${trace.bytes}B, terminal seen: ${trace.sawTerminal}, last events: ${trace.eventTypes.slice(-6).join(" > ") || "(none)"}, reason: ${String(reason).slice(0, 120)}`
      );
      await reader.cancel(reason);
    },
    async pull(controller) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch (error) {
        console.error(
          `zhipu-fetch: stream read failed after ${Date.now() - startedAt}ms ${path}: ${trace.bytes}B, tool_use seen: ${trace.sawToolUse}, last events: ${trace.eventTypes.slice(-6).join(" > ") || "(none)"}`,
          error
        );
        controller.error(error);
        return;
      }
      if (result.done) {
        // The cancel handler resolves a pending read as done; that arrival
        // belongs to the cancel path, not a natural end.
        if (tail.length > 0) {
          trackSseLine(tail, trace);
        }
        if (!cancelled) {
          logIfUnterminated(trace, startedAt, path);
          controller.close();
        }
        return;
      }
      const { value } = result;
      trace.bytes += value.byteLength;
      controller.enqueue(value);
      // Complete lines fold into the trace once; only the trailing partial
      // line carries over (bounded, for a pathological unterminated line).
      tail += decoder.decode(value, { stream: true });
      const lines = tail.split("\n");
      tail = lines.pop() ?? "";
      if (tail.length > 4096) {
        tail = tail.slice(-4096);
      }
      for (const line of lines) {
        trackSseLine(line, trace);
      }
    },
  });
};

const modelFetch: typeof fetch = async (input, init) => {
  const path = requestPath(input);
  const requestBytes =
    typeof init?.body === "string" ? init.body.length : undefined;
  const startedAt = Date.now();
  try {
    const response = await fetch(input, init);
    const headers = new Headers(response.headers);
    headers.delete("content-encoding");
    headers.delete("content-length");
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      console.error(
        `zhipu-fetch: HTTP ${response.status} after ${Date.now() - startedAt}ms ${path} (request ${requestBytes ?? "?"}B): ${body.slice(0, 500)}`
      );
      return new Response(
        NULL_BODY_STATUSES.has(response.status) ? null : body,
        {
          headers,
          status: response.status,
          statusText: response.statusText,
        }
      );
    }
    if (response.body === null) {
      return response;
    }
    const trace: StreamTrace = {
      bytes: 0,
      eventTypes: [],
      sawTerminal: false,
      sawToolUse: false,
    };
    return new Response(trackedBody(response.body, trace, startedAt, path), {
      headers,
      status: response.status,
      statusText: response.statusText,
    });
  } catch (error) {
    console.error(
      `zhipu-fetch: transport failed after ${Date.now() - startedAt}ms ${path} (request ${requestBytes ?? "?"}B):`,
      error
    );
    throw error;
  }
};

const zhipu = createAnthropic({
  apiKey: process.env.ZHIPU_API_KEY,
  baseURL:
    process.env.ZHIPU_BASE_URL ?? "https://open.bigmodel.cn/api/anthropic/v1",
  fetch: modelFetch,
});

export const MODELS = {
  analyst: zhipu("glm-5.3"),
  classifier: zhipu("glm-5.3-flash"), // fast triage on the flash tier
  implementer: zhipu("glm-5.3"), // the station that writes the code gets the strongest coding model
  orchestrator: zhipu("glm-5.3"),
  researcher: zhipu("glm-5.3-flash"),
  reviewer: zhipu("glm-5.3"), // same vendor as implementer: the single-provider tradeoff of this fork
} as const;

export type FactoryAgent = keyof typeof MODELS;

// Context window per agent, in tokens. GLM-5.3 is 1M per Zhipu's published
// specs; the flash entry is declared conservatively at 200K until the plan's
// model page confirms its window. eve needs this number to compile compaction
// triggers, and models outside the AI Gateway catalog carry no metadata, so
// each agent.ts passes its entry as `modelContextWindowTokens` alongside
// `model`. Keep the numbers in sync with the model ids above.
export const MODEL_CONTEXT_WINDOW_TOKENS: Record<FactoryAgent, number> = {
  analyst: 1_000_000,
  classifier: 200_000,
  implementer: 1_000_000,
  orchestrator: 1_000_000,
  researcher: 200_000,
  reviewer: 1_000_000,
};

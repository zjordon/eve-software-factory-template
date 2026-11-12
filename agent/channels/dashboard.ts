import { defineChannel, GET } from "eve/channels";
import { routeAuth } from "eve/channels/auth";
import { FACTORY_REPO } from "../lib/constants.js";
import {
  dailyTotals,
  getRun,
  listRuns,
  type RunRecord,
  summarizeRun,
} from "../lib/observability/run-store.js";
import { operatorRouteAuth } from "../lib/route-auth.js";

/**
 * Runs the operator route-auth walk and returns the 401 Response to return
 * when the caller did not authenticate, or null when access is granted.
 */
const unauthorized = async (request: Request): Promise<Response | null> => {
  const result = await routeAuth(request, operatorRouteAuth);
  return result instanceof Response ? result : null;
};

/** A run record minus the dedupe bookkeeping the panel never needs. */
type LeanRunRecord = Omit<RunRecord, "seenKeys">;

/** Strips bookkeeping fields the panel never needs off the wire shape. */
const leanRecord = (record: RunRecord): LeanRunRecord => {
  const { seenKeys: _seenKeys, ...lean } = record;
  return lean;
};

/**
 * The factory's run panel (M5): a read-only window onto run records.
 *
 * @remarks
 * - Read-only by construction: the only session operation any route touches
 *   is `attachSession(id).getEventStream()`, which follows a run live without
 *   being able to steer it; nothing here can send, respond, cancel, or reset.
 * - Authenticated exactly like the eve route channel (Basic via
 *   `agent/lib/route-auth.ts`); an unauthenticated request gets the framework
 *   401 with the Basic challenge. `none()` is never introduced.
 * - Paths avoid static/param collisions on purpose: the page lives at
 *   `/runs/ui`, details at `/run/:id` — a `/runs/:id` route would be
 *   ambiguous against the static page path.
 */
export default defineChannel({
  routes: [
    GET("/runs", async (request) => {
      const denied = await unauthorized(request);
      if (denied !== null) {
        return denied;
      }
      const summaries = await listRuns(50);
      return Response.json(
        {
          runs: summaries.map((summary) => ({
            ...summary,
            record: leanRecord(summary.record),
          })),
          totals: dailyTotals(summaries.map((summary) => summary.record)),
        },
        { headers: { "cache-control": "no-store" } }
      );
    }),

    GET("/run/:id", async (request, { params }) => {
      const denied = await unauthorized(request);
      if (denied !== null) {
        return denied;
      }
      const record = await getRun(params.id);
      if (record === null) {
        return Response.json(
          { code: "not_found", error: "No run record for that id.", ok: false },
          { headers: { "cache-control": "no-store" }, status: 404 }
        );
      }
      return Response.json(
        { ...summarizeRun(record), record: leanRecord(record) },
        { headers: { "cache-control": "no-store" } }
      );
    }),

    GET("/run/:id/stream", async (request, { attachSession, params }) => {
      const denied = await unauthorized(request);
      if (denied !== null) {
        return denied;
      }
      try {
        // ?tail=N replays the last N events before following live (negative
        // startIndex counts back from the newest). A tail of exactly 1 often
        // lands on a streaming chunk the panel mutes, which reads as a dead
        // feed; a short replay gives the operator the recent boundaries.
        const tailParam = Number(new URL(request.url).searchParams.get("tail"));
        const tail =
          Number.isSafeInteger(tailParam) && tailParam > 0 && tailParam <= 50
            ? -tailParam
            : -12;
        const events = await attachSession(params.id).getEventStream({
          startIndex: tail,
        });
        // getEventStream yields parsed event objects, not wire bytes; an HTTP
        // body must be bytes, so encode each event as one NDJSON line here —
        // the same framing the eve channel's own stream route uses. Handing
        // the object stream to Response directly aborts the connection with
        // an empty reply (verified live; the doc example is misleading).
        // A blank line every 25s keeps bytes flowing while a station runs a
        // long quiet tool: idle proxies (the Cloudflare edge cuts ~100s) kill
        // silent streams otherwise. Readers skip blank lines.
        const encoder = new TextEncoder();
        let keepAlive: ReturnType<typeof setInterval> | undefined;
        const body = events.pipeThrough(
          new TransformStream({
            start(controller) {
              keepAlive = setInterval(() => {
                try {
                  controller.enqueue(encoder.encode("\n"));
                } catch {
                  // The readable side is gone (client disconnected): the
                  // Transformer type has no cancel slot in this TS lib, so
                  // the first failed enqueue is the stop signal.
                  if (keepAlive !== undefined) {
                    clearInterval(keepAlive);
                  }
                }
              }, 25_000);
            },
            transform: (event, controller) => {
              controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
            },
          })
        );
        return new Response(body, {
          headers: {
            "cache-control": "no-store",
            "content-type": "application/x-ndjson; charset=utf-8",
          },
        });
      } catch {
        return Response.json(
          {
            code: "not_found",
            error: "That session is not streaming right now.",
            ok: false,
          },
          { headers: { "cache-control": "no-store" }, status: 404 }
        );
      }
    }),

    GET("/runs/ui", async (request) => {
      const denied = await unauthorized(request);
      if (denied !== null) {
        return denied;
      }
      return new Response(runPanelPage(), {
        headers: {
          "cache-control": "no-store",
          "content-type": "text/html; charset=utf-8",
        },
      });
    }),
  ],
});

/** The inline single-page panel: zero external dependencies, 30s list polling, live detail stream with a polling fallback. */
const runPanelPage = (): string => `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Foreman 运行面板</title>
<style>
  :root { color-scheme: light dark; }
  body {
    margin: 0; padding: 1rem 1.25rem 3rem;
    font: 14px/1.55 ui-sans-serif, system-ui, "Segoe UI", "PingFang SC",
      "Microsoft YaHei", sans-serif;
    background: #f6f7f9; color: #1c2128;
  }
  @media (prefers-color-scheme: dark) {
    body { background: #0d1117; color: #e6edf3; }
    a { color: #6cb6ff; }
    .card, .banner { background: #161b22; border-color: #30363d; }
    th { background: #10151c; }
    tr.zombie { background: #3d1418; }
    .muted { color: #8b949e; }
    .dot.ok { background: #3fb950; } .dot.bad { background: #f85149; }
    .dot.run { background: #d29922; } .dot.wait { background: #8957e5; }
  }
  header { display: flex; align-items: baseline; gap: 0.75rem; flex-wrap: wrap; }
  h1 { font-size: 1.15rem; margin: 0 0 0.5rem; }
  .muted { color: #57606a; font-size: 0.85rem; }
  .card { background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: 1rem; margin: 0.75rem 0; }
  table { border-collapse: collapse; width: 100%; font-size: 0.9rem; }
  th, td { text-align: left; padding: 0.4rem 0.55rem; border-bottom: 1px solid #d8dee4; vertical-align: top; }
  th { font-weight: 600; }
  @media (prefers-color-scheme: dark) { th, td { border-color: #21262d; } }
  tbody tr { cursor: pointer; }
  tbody tr:hover { background: rgba(125, 125, 125, 0.08); }
  tr.zombie { background: #fff1f0; }
  tr.zombie:hover { background: #ffdfdc; }
  .dot { display: inline-block; width: 0.6rem; height: 0.6rem; border-radius: 50%; margin-right: 0.35rem; vertical-align: middle; }
  .dot.ok { background: #1a7f37; } .dot.bad { background: #cf222e; }
  .dot.run { background: #9a6700; } .dot.wait { background: #8250df; }
  .banner { border: 1px solid #cf222e; border-radius: 8px; padding: 0.6rem 0.9rem; margin: 0.75rem 0; }
  .stage-dots { letter-spacing: 2px; white-space: nowrap; }
  .stage-dots b { font-weight: 600; }
  pre#live { background: rgba(125, 125, 125, 0.1); border-radius: 6px; padding: 0.6rem 0.8rem; font-size: 0.8rem; max-height: 16rem; overflow: auto; white-space: pre-wrap; }
  .kv { display: grid; grid-template-columns: max-content 1fr; gap: 0.15rem 1rem; }
  .kv dt { font-weight: 600; } .kv dd { margin: 0; }
  button { font: inherit; padding: 0.25rem 0.8rem; border-radius: 6px; border: 1px solid currentColor; background: transparent; color: inherit; cursor: pointer; }
  code { background: rgba(125, 125, 125, 0.15); border-radius: 4px; padding: 0 0.3rem; }
</style>
</head>
<body>
<header>
  <h1>Foreman 运行面板</h1>
  <span class="muted" id="meta">加载中…</span>
</header>
<div class="banner" id="zombie-banner" hidden></div>
<main id="list-view">
  <div class="card">
    <table>
      <thead><tr>
        <th>线程</th><th>状态</th><th>站点推进</th><th>轮</th><th>令牌</th><th>耗时</th><th>PR / 终态</th><th>更新</th>
      </tr></thead>
      <tbody id="runs"></tbody>
    </table>
  </div>
  <div class="card" id="totals" hidden></div>
</main>
<section id="detail-view" hidden>
  <p><button id="back">← 返回列表</button></p>
  <div class="card" id="detail"></div>
  <div class="card"><div class="muted">实时事件（进入站点时跟随站点会话流；断流后自动转为 10 秒轮询）</div><div class="muted" id="activity"></div><pre id="live"></pre></div>
</section>
<script>
"use strict";
const $ = (id) => document.getElementById(id);
const repoUrl = "https://github.com/${FACTORY_REPO}";
const esc = (value) => String(value ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtDur = (ms) => {
  if (!Number.isFinite(ms) || ms < 0) return "–";
  const s = Math.round(ms / 1000);
  if (s < 60) return s + "s";
  if (s < 3600) return Math.floor(s / 60) + "m" + (s % 60) + "s";
  return Math.floor(s / 3600) + "h" + Math.floor((s % 3600) / 60) + "m";
};
const fmtTokens = (n) => (n >= 10000 ? (n / 1000).toFixed(1) + "k" : String(n ?? 0));
const clock = (iso) => { const d = new Date(iso); return Number.isNaN(d.getTime()) ? "" : d.toLocaleTimeString("zh-CN", { hour12: false }); };

const STATIONS = [
  ["run_classifier", "C"], ["run_researcher", "R"], ["run_analyst", "A"],
  ["run_implementer", "I"], ["run_reviewer", "V"],
];
function stageMarks(record) {
  return STATIONS.map(([name, label]) => {
    const stages = record.stages.filter((s) => s.name === name);
    if (stages.length === 0) return '<span class="muted">·</span>';
    const last = stages[stages.length - 1];
    const cls = last.outcome === "completed" ? "ok"
      : last.outcome === null ? "run"
      : "bad";
    return '<b title="' + esc(name) + ' ' + esc(last.outcome ?? "进行中") + '" class="dot ' + cls + '" style="display:inline-block;width:auto;border-radius:4px;padding:0 3px;color:#fff;background-color:inherit">' + label + (stages.length > 1 ? "×" + stages.length : "") + "</b>";
  }).join(" ");
}
const STATUS_LABEL = { running: "运行中", waiting: "等待中", completed: "已完成", failed: "失败" };
function statusCell(record) {
  const cls = record.status === "completed" ? "ok" : record.status === "failed" ? "bad"
    : record.status === "running" ? "run" : "wait";
  return '<span class="dot ' + cls + '"></span>' + esc(STATUS_LABEL[record.status] ?? record.status);
}
function threadCell(record) {
  const t = record.thread;
  const where = t === null ? esc(record.channel ?? "?")
    : (t.kind === "issue" ? "issue" : t.kind === "pull" ? "PR" : "评审") + " #" + t.number;
  return "<div>" + where + (record.intakeIssue !== null ? ' <span class="muted">（工厂 #' + record.intakeIssue + "）</span>" : "") + "</div>"
    + '<div class="muted">' + esc(record.title ?? record.sessionId.slice(0, 12)) + "</div>";
}
function outcomeCell(record) {
  if (record.prUrl !== null) return '<a href="' + esc(record.prUrl) + '" target="_blank" rel="noopener">草稿 PR</a>';
  if (record.terminal !== null) return esc(STATUS_LABEL[record.status] ?? record.status) + ' <span class="muted">' + clock(record.terminal.at) + "</span>";
  return '<span class="muted">–</span>';
}

let selected = null;
let pollTimer = null;
let liveAbort = null;

async function fetchJSON(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("HTTP " + response.status);
  return response.json();
}

function renderList(data) {
  const rows = data.runs.map((run) => {
    const r = run.record;
    const z = run.zombie;
    const tokens = r.modelUsage.inputTokens + r.modelUsage.outputTokens;
    return '<tr id="row-' + esc(r.sessionId) + '" class="' + (z ? "zombie" : "") + '" data-id="' + esc(r.sessionId) + '">'
      + "<td>" + threadCell(r) + "</td>"
      + "<td>" + statusCell(r) + "</td>"
      + '<td class="stage-dots">' + stageMarks(r) + "</td>"
      + "<td>" + r.turns.started + (r.turns.failed > 0 ? ' <span title="失败轮">(' + r.turns.failed + "✗)</span>" : "") + "</td>"
      + "<td>" + fmtTokens(tokens) + "</td>"
      + "<td>" + fmtDur(run.durationMs) + "</td>"
      + "<td>" + outcomeCell(r) + "</td>"
      + '<td class="muted">' + clock(r.updatedAt) + "</td></tr>";
  });
  $("runs").innerHTML = rows.join("") || '<tr><td colspan="8" class="muted">还没有运行记录。给 issue 打上 factory 标签后 30 秒内这里会出现它。</td></tr>';
  for (const row of $("runs").querySelectorAll("tr[data-id]")) {
    row.addEventListener("click", () => { location.hash = row.dataset.id; });
  }
  const zombies = data.runs.filter((run) => run.zombie !== null);
  const banner = $("zombie-banner");
  if (zombies.length > 0) {
    banner.hidden = false;
    banner.innerHTML = "<b>" + zombies.length + " 个僵尸运行</b>：" + zombies.map((run) =>
      esc((run.record.thread === null ? run.record.sessionId.slice(0, 8)
        : "#" + run.record.thread.number) + " " + run.zombie.type + "（" + run.zombie.detail + "）")).join("；")
      + '。<span class="muted">处置口径见运维手册「可观测性」一节（reset / 迁移）。</span>';
  } else {
    banner.hidden = true;
  }
  if (data.totals.length > 0) {
    $("totals").hidden = false;
    $("totals").innerHTML = "<b>按日汇总（近 " + data.totals.length + " 天）</b>"
      + data.totals.slice(0, 14).map((day) =>
        "<div>" + esc(day.day) + "：" + day.runs + " 次（失败 " + day.failedRuns + "），输入 "
        + fmtTokens(day.inputTokens) + " / 输出 " + fmtTokens(day.outputTokens) + " 令牌，累计 " + fmtDur(day.totalDurationMs) + "</div>").join("");
  }
  $("meta").textContent = "共 " + data.runs.length + " 条 · 每 30 秒刷新 · 点击行查看详情";
}

async function refreshList() {
  try {
    renderList(await fetchJSON("/runs"));
  } catch (error) {
    $("meta").textContent = "刷新失败：" + esc(String(error)) + "，将自动重试";
  }
}

function renderDetail(run) {
  const r = run.record;
  const stages = r.stages.map((stage) => {
    const state = stage.outcome === null ? "进行中" : stage.outcome;
    const tokens = stage.tokens === null ? "" :
      " · " + fmtTokens(stage.tokens.inputTokens + stage.tokens.outputTokens) + " 令牌";
    return "<div>" + clock(stage.startedAt) + " <code>" + esc(stage.name) + "</code> "
      + esc(state) + (stage.durationMs === null ? "" : " · " + fmtDur(stage.durationMs)) + tokens + "</div>";
  }).join("") || '<span class="muted">尚无站点动作。</span>';
  const inputs = r.inputRequests.map((request) => {
    const state = request.resolvedAt === null ? "未应答" : request.outcome + " @ " + clock(request.resolvedAt);
    return "<div>" + clock(request.requestedAt) + " <code>" + esc(request.kind) + "</code> " + esc(state) + "</div>";
  }).join("") || '<span class="muted">无审批卡。</span>';
  const failures = r.turnFailures.map((failure) =>
    "<div>" + clock(failure.at) + " <code>" + esc(failure.errorType) + "</code></div>").join("");
  $("detail").innerHTML =
    '<div class="kv">'
    + "<dt>线程</dt><dd>" + threadCell(r).replace(/<div>/g, "").replace(/<\\/div>/g, " · ") + "</dd>"
    + "<dt>会话</dt><dd><code>" + esc(r.sessionId) + "</code></dd>"
    + "<dt>状态</dt><dd>" + statusCell(r) + (r.terminal !== null ? " · " + clock(r.terminal.at) : "") + "</dd>"
    + "<dt>令牌</dt><dd>输入 " + fmtTokens(r.modelUsage.inputTokens) + " / 输出 " + fmtTokens(r.modelUsage.outputTokens)
      + "（缓存读 " + fmtTokens(r.modelUsage.cacheReadTokens) + "，写 " + fmtTokens(r.modelUsage.cacheWriteTokens) + "，调用 " + r.modelUsage.calls + " 次）</dd>"
    + "<dt>轮</dt><dd>" + r.turns.started + " 轮，失败 " + r.turns.failed + "</dd>"
    + (r.prUrl !== null ? '<dt>PR</dt><dd><a href="' + esc(r.prUrl) + '" target="_blank" rel="noopener">' + esc(r.prUrl) + "</a></dd>" : "")
    + (run.zombie !== null ? "<dt>僵尸</dt><dd><b>" + esc(run.zombie.type) + "</b>（" + esc(run.zombie.detail) + "，自 " + esc(run.zombie.since) + "）</dd>" : "")
    + "</div>"
    + "<hr><div><b>站点时间线</b></div>" + stages
    + '<div style="margin-top:0.5rem"><b>审批卡</b></div>' + inputs
    + (failures === "" ? "" : '<div style="margin-top:0.5rem"><b>失败轮</b></div>' + failures
      + (r.thread === null ? "" : '<div class="muted">错误详情以错误评论贴在 <a href="' + repoUrl + "/" + (r.thread.kind === "issue" ? "issues" : "pull") + "/" + r.thread.number + '" target="_blank" rel="noopener">该线程</a>；记录面只存错误代码（对话内容不落盘）。</div>'));
}

function liveLine(text) {
  const node = $("live");
  node.textContent += text + "\\n";
  const lines = node.textContent.split("\\n");
  if (lines.length > 200) node.textContent = lines.slice(-200).join("\\n");
  node.scrollTop = node.scrollHeight;
}

// 活动指示：流式增量块不进日志（刷屏），但它们是"正在生成"的最强信号。
// 二态渲染：事件在流（● 活动中）；静默超 30 秒（○ 静默中 + 已静默时长）——
// 站点跑长工具（sandbox clone / uv sync）期间事件流真静默，只有心跳在走，
// 静默计时由本地时钟驱动，操作者能分辨"在干活"与"死了"。
let lastEventAt = 0;
let activityLabel = "";
function touchActivity(label) {
  lastEventAt = Date.now();
  activityLabel = label;
  renderActivity();
}
function renderActivity() {
  const node = $("activity");
  if (selected === null || lastEventAt === 0) {
    node.textContent = "";
    return;
  }
  const silentMs = Date.now() - lastEventAt;
  if (silentMs > 30000) {
    const mins = Math.floor(silentMs / 60000);
    const secs = Math.floor((silentMs % 60000) / 1000);
    node.textContent =
      "○ " + activityLabel + " 静默中 · 已 " +
      (mins > 0 ? mins + "m" + secs + "s" : secs + "s") +
      "（长工具或 sandbox 初始化）";
  } else {
    node.textContent =
      "● " + activityLabel + " 流式活动中 · 最后活动 " + clock(new Date(lastEventAt).toISOString());
  }
}
setInterval(renderActivity, 1000);

function describeStreamEvent(event) {
  switch (event.type) {
    case "turn.started": return "轮开始";
    case "turn.completed": return "轮完成";
    case "turn.cancelled": return "轮被取消";
    case "turn.failed": return "轮失败";
    case "session.waiting": return "会话挂起等待";
    case "session.completed": return "会话完成";
    case "session.failed": return "会话失败";
    case "actions.requested": {
      const names = (event.data?.actions ?? []).map((action) => action.toolName).join(", ");
      return "请求动作：" + (names || "?");
    }
    case "action.result": {
      const name = event.data?.result?.toolName ?? "?";
      return "动作结束：" + name + "（" + (event.data?.status ?? "?") + "）";
    }
    case "message.completed": return "回复完成";
    case "input.requested": return "审批卡出现";
    // 流式增量块（每秒多条）不进实时区，只留生命周期边界。
    case "message.appended":
    case "reasoning.appended":
    case "reasoning.completed":
    case "action.input.appended":
    case "action.partial":
      return null;
    default: return event.type;
  }
}

async function pump(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let newline = buffer.indexOf("\\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line !== "") {
        try { onEvent(JSON.parse(line)); } catch { /* 忽略半行 */ }
      }
      newline = buffer.indexOf("\\n");
    }
  }
}

// 站点跑在自己的子会话里（根流只在站点边界出声），进入站点时跟随其会话流，
// 让长工具调用（如 sandbox 首次 uv sync）期间实时区也有动静。
let childAbort = null;
function closeChild() {
  if (childAbort !== null) { childAbort.abort(); childAbort = null; }
}
async function followChild(childSessionId, tag) {
  closeChild();
  childAbort = new AbortController();
  let failures = 0;
  for (;;) {
    try {
      const response = await fetch("/run/" + encodeURIComponent(childSessionId) + "/stream?tail=12", { signal: childAbort.signal });
      if (!response.ok || response.body === null) throw new Error("HTTP " + response.status);
      failures = 0;
      let seen = 0;
      await pump(response, (event) => {
        seen += 1;
        const text = describeStreamEvent(event);
        if (text !== null) {
          liveLine((seen <= 12 ? "↩ " : "") + clock(new Date().toISOString()) + " [" + tag + "] " + text);
        }
        touchActivity(tag);
      });
      // 正常结束（站点完成，会话终态）不重连，避免对终态会话空转。
      return;
    } catch (error) {
      if (error.name === "AbortError") return;
      failures += 1;
      if (failures > 2) {
        liveLine("[" + tag + "] 站点会话流结束");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }
}

// 详情数字（状态/令牌/时间线）随此刷新收敛：多窗口各自的重连史不同，
// 定时拉取让 KV 块最多落后 30 秒，而不是各窗口各说各话。
async function refreshDetail(id) {
  try {
    const run = await fetchJSON("/run/" + encodeURIComponent(id));
    if (selected === id) {
      renderDetail(run);
    }
    return run.record.terminal !== null;
  } catch {
    return false;
  }
}

async function followLive(id) {
  if (liveAbort !== null) liveAbort.abort();
  liveAbort = new AbortController();
  let fellBack = false;
  const pollOnce = () => refreshDetail(id);
  try {
    liveLine("—— 已接入实时流 ——");
    // 空闲代理会在长工具期间掐断静默流（心跳之外仍可能断）：先重连（3 次、
    // 间隔 5 秒），连败才真正降级轮询；正常结束（会话终态/服务重启）走同一条
    // 重连路径，由 pollOnce 决定是否收手。每次连接的前 TAIL 条是回放（?tail
    // 参数），行首标 ↩，与直播行区分——多窗口回放窗口不同是预期，不再误读。
    let failures = 0;
    while (selected === id) {
      try {
        const response = await fetch("/run/" + encodeURIComponent(id) + "/stream?tail=12", {
          accept: "application/x-ndjson",
          signal: liveAbort.signal,
        });
        if (!response.ok || response.body === null) throw new Error("HTTP " + response.status);
        failures = 0;
        let seen = 0;
        await pump(response, (event) => {
          seen += 1;
          const prefix = seen <= 12 ? "↩ " : "";
          if (event.type === "subagent.called" && event.data?.childSessionId) {
            const tag = event.data.name ?? "站点";
            liveLine(prefix + clock(new Date().toISOString()) + " → 进入站点 " + tag + "（跟随其会话流）");
            followChild(event.data.childSessionId, tag);
            return;
          }
          if (event.type === "action.result" && String(event.data?.result?.toolName ?? "").startsWith("run_")) {
            closeChild();
          }
          const text = describeStreamEvent(event);
          if (text !== null) liveLine(prefix + clock(new Date().toISOString()) + " " + text);
          touchActivity("会话");
        });
        liveLine("—— 实时流结束 ——");
      } catch (streamError) {
        if (streamError.name === "AbortError" || selected !== id) {
          return;
        }
        failures += 1;
        if (failures > 3) {
          throw streamError;
        }
        liveLine("—— 流中断（" + String(streamError).replace(/\\n/g, " ") + "），5 秒后重连 ——");
      }
      const done = await pollOnce();
      if (done || selected !== id) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  } catch (error) {
    if (error.name !== "AbortError") {
      liveLine("—— 实时流不可用（" + String(error).replace(/\\n/g, " ") + "），降级为 10 秒轮询 ——");
      fellBack = true;
    }
  }
  if (fellBack || selected === id) {
    // 轮询兜底：流断了或结束后，10 秒一档跟进直到终态。
    const done = await pollOnce();
    if (!done && selected === id && pollTimer === null) {
      pollTimer = setInterval(async () => {
        const terminal = await pollOnce();
        if (terminal || selected !== id) {
          clearInterval(pollTimer);
          pollTimer = null;
        }
      }, 10000);
    }
  }
}

function route() {
  const id = decodeURIComponent(location.hash.replace(/^#/, ""));
  if (liveAbort !== null) liveAbort.abort();
  closeChild();
  if (pollTimer !== null) { clearInterval(pollTimer); pollTimer = null; }
  $("live").textContent = "";
  $("activity").textContent = "";
  lastEventAt = 0;
  activityLabel = "";
  if (id === "") {
    selected = null;
    $("detail-view").hidden = true;
    $("list-view").hidden = false;
    return;
  }
  selected = id;
  $("list-view").hidden = true;
  $("detail-view").hidden = false;
  fetchJSON("/run/" + encodeURIComponent(id))
    .then((run) => { renderDetail(run); followLive(id); })
    .catch(() => { $("detail").innerHTML = '<span class="muted">找不到该运行的记录（可能已被 30 天清理）。</span>'; });
}

$("back").addEventListener("click", () => { location.hash = ""; });
window.addEventListener("hashchange", route);
route();
refreshList();
setInterval(() => { if (selected === null) refreshList(); }, 30000);
// 详情打开时数字定时收敛（多窗口一致性），与流的生命周期解耦。
setInterval(() => { if (selected !== null) refreshDetail(selected); }, 30000);
</script>
</body>
</html>`;

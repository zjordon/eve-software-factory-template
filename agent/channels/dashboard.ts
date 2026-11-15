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

  :root { --c-ok:#1a7f36; --c-bad:#cf222e; --c-run:#9a6700; --c-wait:#8250df; --c-off:#d0d7de; --c-dim:#57606a; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) { --c-ok:#3fb950; --c-bad:#f85149; --c-run:#d29922; --c-wait:#8957e5; --c-off:#30363d; --c-dim:#8b949e; }
  }
  .switch { display: flex; gap: 0.4rem; margin-bottom: 0.6rem; }
  .switch button.on { font-weight: 700; border-width: 2px; }
  .pl-edge { stroke: var(--c-off); stroke-width: 2; }
  .pl-edge.off { stroke-dasharray: 3 4; opacity: 0.5; }
  .pl-node circle { fill: var(--c-off); }
  .pl-node.ok circle { fill: var(--c-ok); }
  .pl-node.run circle { fill: var(--c-run); }
  .pl-node.bad circle { fill: var(--c-bad); }
  .pl-node.stuck circle { stroke: var(--c-bad); stroke-width: 3; }
  .pl-glyph { fill: #fff; font-size: 12px; font-weight: 600; }
  .pl-name { fill: inherit; font-size: 11px; }
  .pl-dur { fill: var(--c-dim); font-size: 10px; }
  .pl-rounds { fill: var(--c-run); }
  .pl-back { fill: none; stroke: var(--c-run); stroke-width: 1.5; stroke-dasharray: 4 3; }
  .pl-badge { font-size: 10px; fill: var(--c-run); }
  .pl-wait rect { fill: var(--c-wait); }
  .pl-wait text { fill: #fff; font-size: 10px; }
  .mini-line { stroke: var(--c-off); stroke-width: 1.5; }
  .mini-line.ok { stroke: var(--c-ok); }
  .mini-line.run { stroke: var(--c-run); }
  .mini-line.bad { stroke: var(--c-bad); }
  .mini-node { fill: var(--c-off); }
  .mini-node.ok { fill: var(--c-ok); }
  .mini-node.run { fill: var(--c-run); }
  .mini-node.bad { fill: var(--c-bad); }
  .mini-badge { font-size: 9px; fill: var(--c-run); }
  .g-axis { stroke: var(--c-off); }
  .g-tick { font-size: 9px; fill: var(--c-dim); }
  .g-label { font-size: 10px; fill: var(--c-dim); }
  .g-bar.ok { fill: var(--c-ok); }
  .g-bar.run { fill: var(--c-run); }
  .g-bar.bad { fill: var(--c-bad); }
  .g-bar.wait { fill: var(--c-wait); }
  .pulse circle, .pulse rect, circle.pulse, rect.pulse { animation: breathe 1.6s ease-in-out infinite; }
  @keyframes breathe { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }
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
  <div class="card">
    <div id="hero-switch" class="switch"></div>
    <div id="hero"></div>
    <div id="detail-kv"></div>
  </div>
  <div class="muted" id="activity"></div>
  <details class="card" id="live-box">
    <summary>实时事件（钻取层：跟随站点会话流，断流自动降级 10 秒轮询）</summary>
    <pre id="live"></pre>
  </details>
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

// ---------- 管线模型（列表迷你管线 / 详情管线图 / 甘特 共用） ----------
const PIPELINE = [
  ["run_classifier", "分诊"], ["run_researcher", "研究"], ["run_analyst", "分析"],
  ["run_implementer", "实现"], ["run_reviewer", "评审"], ["push_branch", "推送"], ["github__createPullRequest", "PR"],
];
const STATION_STATE_LABEL = { pending: "未到", running: "进行中", completed: "完成", failed: "失败" };

function stationGroups(record) {
  const groups = {};
  for (const [name] of PIPELINE) {
    const rounds = record.stages.filter((s) => s.name === name);
    groups[name] = { name, rounds, state: "pending" };
  }
  for (const group of Object.values(groups)) {
    if (group.rounds.length === 0) continue;
    const last = group.rounds[group.rounds.length - 1];
    if (last.completedAt === null) group.state = "running";
    else if (last.outcome === "completed") group.state = "completed";
    else group.state = "failed";
  }
  return groups;
}
function visiblePipeline(record) {
  const groups = stationGroups(record);
  return PIPELINE.filter(([name]) => {
    if (name === "run_researcher") return groups[name].rounds.length > 0;
    if (name === "github__createPullRequest") return groups[name].rounds.length > 0 || record.prUrl !== null;
    return true;
  }).map(([name, label]) => ({ ...groups[name], label }));
}
function summaryText(record, name) {
  const s = (record.stationSummaries || {})[name.replace(/^run_/, "")];
  if (!s) return "";
  return Object.entries(s.fields).map(([k, v]) => k + "=" + v).join(" · ");
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

// ---------- 列表行迷你管线（GitLab mini graph 思路：连线点串） ----------
function miniPipeline(record, activeStation) {
  const stations = visiblePipeline(record);
  const reworkRounds = (stationGroups(record).run_reviewer?.rounds ?? []).length;
  const parts = stations.map((station, i) => {
    const state = station.name === activeStation && station.state === "pending" ? "running" : station.state;
    const cls = state === "completed" ? "ok" : state === "running" ? "run" : state === "failed" ? "bad" : "off";
    const badge = station.name === "run_reviewer" && reworkRounds > 1 ? '<text x="' + (i * 26 + 9) + '" y="12" class="mini-badge">×' + reworkRounds + "</text>" : "";
    const connector = i === 0 ? "" : '<line x1="' + (i * 26 - 14) + '" y1="9" x2="' + (i * 26 + 2) + '" y2="9" class="mini-line ' + cls + '" />';
    return connector + '<circle cx="' + (i * 26 + 6) + '" cy="9" r="5" class="mini-node ' + cls + (state === "running" ? " pulse" : "") + '">' +
      '<title>' + esc(station.label + "：" + STATION_STATE_LABEL[state]) + "</title></circle>" + badge;
  }).join("");
  return '<svg class="mini" width="' + ((stations.length - 1) * 26 + 24) + '" height="18" aria-hidden="true">' + parts + "</svg>";
}

// ---------- 详情 hero：管线图 / 甘特 双形态（一键切换） ----------
let heroView = "pipeline";
let liveActive = null; // 实时流推定的当前站（subagent.called）

function pipelineSvg(record, zombie) {
  const stations = visiblePipeline(record);
  const n = stations.length;
  if (n === 0) return '<div class="muted">尚无站点动作。</div>';
  const step = 108, pad = 16, width = (n - 1) * step + pad * 2 + 20;
  const cy = 64, yDur = cy + 22, yLabel = cy - 26;
  let svg = "";
  // 正向连线
  for (let i = 1; i < n; i += 1) {
    const prev = stations[i - 1], cur = stations[i];
    const reached = prev.state !== "pending" || cur.state !== "pending";
    svg += '<line x1="' + (pad + (i - 1) * step + 18) + '" y1="' + cy + '" x2="' + (pad + i * step - 18) + '" y2="' + cy +
      '" class="pl-edge' + (reached ? "" : " off") + '" />';
  }
  // 评审返工回边 V→I（第 N 轮徽标）
  const vIdx = stations.findIndex((s) => s.name === "run_reviewer");
  const iIdx = stations.findIndex((s) => s.name === "run_implementer");
  const vRounds = vIdx >= 0 ? stations[vIdx].rounds.length : 0;
  if (vIdx > iIdx && iIdx >= 0 && vRounds >= 2) {
    const x1 = pad + vIdx * step, x2 = pad + iIdx * step;
    svg += '<path d="M ' + x1 + " " + (cy - 14) + ' C ' + x1 + " " + (cy - 52) + ", " + x2 + " " + (cy - 52) + ", " + x2 + " " + (cy - 14) +
      '" class="pl-back" marker-end="url(#backArrow)" />' +
      '<text x="' + ((x1 + x2) / 2) + '" y="' + (cy - 56) + '" class="pl-badge" text-anchor="middle">返工 第 ' + vRounds + " 轮</text>";
  }
  // 节点
  stations.forEach((station, i) => {
    const x = pad + i * step;
    const isLive = station.name === liveActive && station.state !== "completed";
    const state = isLive ? "running" : station.state;
    const cls = state === "completed" ? "ok" : state === "running" ? "run" : state === "failed" ? "bad" : "off";
    const stuck = zombie && state === "running";
    const last = station.rounds[station.rounds.length - 1];
    const dur = last ? (last.durationMs ?? (Date.now() - new Date(last.startedAt).getTime())) : null;
    const tokens = last && last.tokens ? fmtTokens(last.tokens.inputTokens + last.tokens.outputTokens) : "";
    const tip = station.label + "：" + STATION_STATE_LABEL[state] +
      (dur === null ? "" : " · " + fmtDur(dur)) +
      (tokens === "" ? "" : " · " + tokens + " 令牌") +
      (station.rounds.length > 1 ? " · " + station.rounds.length + " 轮" : "");
    const note = summaryText(record, station.name);
    svg += '<g class="pl-node ' + cls + (state === "running" ? " pulse" : "") + (stuck ? " stuck" : "") + '"><title>' + esc(tip + (note === "" ? "" : "\\n" + note)) + "</title>" +
      '<circle cx="' + x + '" cy="' + cy + '" r="14" />' +
      '<text x="' + x + '" y="' + (cy + 4) + '" class="pl-glyph" text-anchor="middle">' + esc(station.label[0]) + "</text>" +
      '<text x="' + x + '" y="' + yLabel + '" class="pl-name" text-anchor="middle">' + esc(station.label) + "</text>" +
      '<text x="' + x + '" y="' + yDur + '" class="pl-dur" text-anchor="middle">' + (dur === null ? (state === "pending" ? "" : "…") : fmtDur(dur)) +
      (station.rounds.length > 1 ? ' <tspan class="pl-rounds">×' + station.rounds.length + "</tspan>" : "") + "</text></g>";
  });
  // 审批等待（未应答的审批卡 = 当前卡点，紫色）
  const openApproval = (record.inputRequests ?? []).find((r) => r.resolvedAt === null);
  if (openApproval) {
    const lastOpen = [...stations].reverse().find((s) => s.state === "running" || s.state === "completed");
    const idx = lastOpen ? stations.indexOf(lastOpen) : stations.length - 1;
    const x = Math.min(pad + idx * step + 54, width - 30);
    svg += '<g class="pl-wait"><title>审批卡等待中（自 ' + esc(openApproval.requestedAt) + "）</title>" +
      '<rect x="' + (x - 12) + '" y="' + (cy - 8) + '" width="24" height="16" rx="4" />' +
      '<text x="' + x + '" y="' + (cy + 4) + '" class="pl-glyph" text-anchor="middle">等</text></g>';
  }
  return '<svg viewBox="0 0 ' + width + " 110" + '" width="100%" height="110" role="img">' +
    '<defs><marker id="backArrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">' +
    '<path d="M0,0 L8,4 L0,8 z" /></marker></defs>' + svg + "</svg>";
}

function ganttSvg(record) {
  const t0 = new Date(record.createdAt).getTime();
  const t1 = Math.max(new Date(record.updatedAt).getTime(), t0 + 60000);
  const span = t1 - t0;
  const rows = [];
  for (const [name] of PIPELINE) {
    const group = stationGroups(record)[name];
    for (const stage of group.rounds) {
      rows.push({ label: PIPELINE.find(([n]) => n === name)[1], kind: "stage", state: stage.outcome, start: new Date(stage.startedAt).getTime(), end: stage.completedAt ? new Date(stage.completedAt).getTime() : t1, open: stage.completedAt === null });
    }
  }
  for (const req of record.inputRequests ?? []) {
    const end = req.resolvedAt ? new Date(req.resolvedAt).getTime() : t1;
    rows.push({ label: "审批等待", kind: "wait", start: new Date(req.requestedAt).getTime(), end, open: req.resolvedAt === null });
  }
  if (rows.length === 0) return '<div class="muted">尚无时间轴数据。</div>';
  const labelW = 74, barMax = 720, rowH = 22, height = rows.length * rowH + 34;
  const x = (t) => labelW + ((t - t0) / span) * barMax;
  let svg = '<line x1="' + labelW + '" y1="8" x2="' + (labelW + barMax) + '" y2="8" class="g-axis" />' +
    '<text x="' + labelW + '" y="6" class="g-tick">' + clock(record.createdAt) + "</text>" +
    '<text x="' + (labelW + barMax) + '" y="6" class="g-tick" text-anchor="end">' + clock(record.updatedAt) + "</text>";
  rows.forEach((row, i) => {
    const y = 18 + i * rowH;
    const w = Math.max(x(row.end) - x(row.start), 3);
    const cls = row.kind === "wait" ? "wait" : row.state === "completed" ? "ok" : row.open ? "run" : "bad";
    const tip = row.label + " · " + clock(new Date(row.start).toISOString()) + " → " + (row.open ? "…" : clock(new Date(row.end).toISOString())) + " · " + fmtDur(row.end - row.start);
    svg += '<text x="' + (labelW - 6) + '" y="' + (y + 13) + '" class="g-label" text-anchor="end">' + esc(row.label) + "</text>" +
      '<rect x="' + x(row.start) + '" y="' + y + '" width="' + w + '" height="' + (rowH - 8) + '" rx="3" class="g-bar ' + cls + (row.open ? " pulse" : "") + '"><title>' + esc(tip) + "</title></rect>";
  });
  const gapNote = "站间空隙 = 编排器自身耗时";
  return '<svg viewBox="0 0 ' + (labelW + barMax + 8) + " " + height + '" width="100%" height="' + height + '" role="img">' + svg + "</svg>" +
    '<div class="muted">' + gapNote + "；紫段为审批等待。</div>";
}

function renderHero(run) {
  $("hero-switch").innerHTML =
    '<button data-view="pipeline" class="' + (heroView === "pipeline" ? "on" : "") + '">管线图</button>' +
    '<button data-view="gantt" class="' + (heroView === "gantt" ? "on" : "") + '">甘特</button>';
  for (const btn of $("hero-switch").querySelectorAll("button")) {
    btn.addEventListener("click", () => { heroView = btn.dataset.view; renderHero(currentRun); });
  }
  $("hero").innerHTML = heroView === "pipeline" ? pipelineSvg(currentRun.record, currentRun.zombie) : ganttSvg(currentRun.record);
}

// ---------- 列表 / 详情 ----------
let selected = null;
let pollTimer = null;
let liveAbort = null;
let currentRun = null;

async function fetchJSON(url) {
  const response = await fetch(url, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error("HTTP " + response.status);
  return response.json();
}

function renderList(data) {
  const rows = data.runs.map((run) => {
    const r = run.record;
    const tokens = r.modelUsage.inputTokens + r.modelUsage.outputTokens;
    const active = run.zombie ? (r.stages.find((s) => s.completedAt === null)?.name ?? null) : liveRowActive.get(r.sessionId) ?? null;
    return '<tr id="row-' + esc(r.sessionId) + '" class="' + (run.zombie ? "zombie" : "") + '" data-id="' + esc(r.sessionId) + '">'
      + "<td>" + threadCell(r) + "</td>"
      + "<td>" + statusCell(r) + "</td>"
      + "<td>" + miniPipeline(r, active) + "</td>"
      + "<td>" + r.turns.started + (r.turns.failed > 0 ? ' <span title="失败轮">(' + r.turns.failed + "✗)</span>" : "") + "</td>"
      + "<td>" + fmtTokens(tokens) + "</td>"
      + "<td>" + fmtDur(new Date(r.updatedAt) - new Date(r.createdAt)) + "</td>"
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
      esc((run.record.thread === null ? "…" + run.record.sessionId.slice(-8)
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
  currentRun = run;
  const r = run.record;
  renderHero(run);
  const inputs = r.inputRequests.map((request) => {
    const state = request.resolvedAt === null ? "未应答" : request.outcome + " @ " + clock(request.resolvedAt);
    return "<div>" + clock(request.requestedAt) + " <code>" + esc(request.kind) + "</code> " + esc(state) + "</div>";
  }).join("") || '<span class="muted">无审批卡。</span>';
  const failures = r.turnFailures.map((failure) =>
    "<div>" + clock(failure.at) + " <code>" + esc(failure.errorType) + "</code></div>").join("");
  const notes = visiblePipeline(r).filter((s) => summaryText(r, s.name) !== "")
    .map((s) => "<div><b>" + esc(s.label) + "</b> <code>" + esc(summaryText(r, s.name)) + "</code></div>").join("");
  $("detail-kv").innerHTML =
    "<div class=\\"kv\\">"
    + "<dt>线程</dt><dd>" + threadCell(r).replace(/<div>/g, "").replace(/<\\/div>/g, " · ") + "</dd>"
    + "<dt>会话</dt><dd><code>" + esc(r.sessionId) + "</code></dd>"
    + "<dt>状态</dt><dd>" + statusCell(r) + (r.terminal !== null ? " · " + clock(r.terminal.at) : "") + "</dd>"
    + "<dt>令牌</dt><dd>输入 " + fmtTokens(r.modelUsage.inputTokens) + " / 输出 " + fmtTokens(r.modelUsage.outputTokens)
      + "（缓存读 " + fmtTokens(r.modelUsage.cacheReadTokens) + "，写 " + fmtTokens(r.modelUsage.cacheWriteTokens) + "，调用 " + r.modelUsage.calls + " 次）</dd>"
    + "<dt>轮</dt><dd>" + r.turns.started + " 轮，失败 " + r.turns.failed + "</dd>"
    + (r.prUrl !== null ? '<dt>PR</dt><dd><a href="' + esc(r.prUrl) + '" target="_blank" rel="noopener">' + esc(r.prUrl) + "</a></dd>" : "")
    + (run.zombie !== null ? "<dt>僵尸</dt><dd><b>" + esc(run.zombie.type) + "</b>（" + esc(run.zombie.detail) + "，自 " + esc(run.zombie.since) + "）</dd>" : "")
    + "</div>"
    + (notes === "" ? "" : '<div style="margin-top:0.5rem"><b>站级摘要（白名单字段）</b></div>' + notes)
    + '<div style="margin-top:0.5rem"><b>审批卡</b></div>' + inputs
    + (failures === "" ? "" : '<div style="margin-top:0.5rem"><b>失败轮</b></div>' + failures
      + (r.thread === null ? "" : '<div class="muted">错误详情以错误评论贴在 <a href="' + repoUrl + "/" + (r.thread.kind === "issue" ? "issues" : "pull") + "/" + r.thread.number + '" target="_blank" rel="noopener">该线程</a>；记录面只存错误代码（对话内容不落盘）。</div>'));
}

// ---------- 实时区（钻取层）与活动指示 ----------
function liveLine(text) {
  const node = $("live");
  node.textContent += text + "\\n";
  const lines = node.textContent.split("\\n");
  if (lines.length > 200) node.textContent = lines.slice(-200).join("\\n");
  node.scrollTop = node.scrollHeight;
}

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

function eventTime(event) {
  const at = event.meta && event.meta.at;
  return clock(typeof at === "string" ? at : new Date().toISOString());
}

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
    case "message.received": return "消息到达";
    case "step.started": return "模型步开始";
    case "step.completed": return "模型步完成";
    case "step.failed": return "模型步失败";
    case "input.requested": return "审批卡出现";
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

// 实时状态机（T5）：流事件即时驱动视图，不等 30 秒轮询；轮询只做收敛对账。
const liveRowActive = new Map(); // 列表行当前站（sessionId -> station label）
function noteActiveStation(stationTag) {
  // 流事件的 name 是子代理 id（如 "implementer"），管线模型用工具名
  // （"run_implementer"）——统一归一到工具名再比较。
  liveActive = stationTag.startsWith("run_") ? stationTag : "run_" + stationTag;
  if (selected !== null && currentRun && currentRun.record.sessionId === selected) {
    renderHero(currentRun);
  }
}
async function markStageBoundary(sessionId) {
  // 站点边界（run_* 动作结束）立即拉一次记录对账：管线图定格不用等轮询。
  if (selected === sessionId) {
    await refreshDetail(sessionId);
  }
  liveActive = null;
  liveRowActive.delete(sessionId);
  if (currentRun && currentRun.record.sessionId === sessionId) renderHero(currentRun);
}

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
          liveLine((seen <= 12 ? "↩ " : "") + eventTime(event) + " [" + tag + "] " + text);
        }
        touchActivity(tag);
      });
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

async function refreshDetail(id) {
  try {
    const run = await fetchJSON("/run/" + encodeURIComponent(id));
    if (selected === id) {
      renderDetail(run);
    }
    if (run.record.terminal !== null) {
      liveRowActive.delete(id);
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
            liveLine(prefix + eventTime(event) + " → 进入站点 " + tag + "（跟随其会话流）");
            noteActiveStation(tag);
            liveRowActive.set(id, tag.startsWith("run_") ? tag : "run_" + tag);
            followChild(event.data.childSessionId, tag);
            return;
          }
          if (event.type === "action.result" && String(event.data?.result?.toolName ?? "").startsWith("run_")) {
            closeChild();
            void markStageBoundary(id);
          }
          const text = describeStreamEvent(event);
          if (text !== null) liveLine(prefix + eventTime(event) + " " + text);
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
  liveActive = null;
  if (id === "") {
    selected = null;
    currentRun = null;
    $("detail-view").hidden = true;
    $("list-view").hidden = false;
    return;
  }
  selected = id;
  $("list-view").hidden = true;
  $("detail-view").hidden = false;
  fetchJSON("/run/" + encodeURIComponent(id))
    .then((run) => {
      // 慢响应竞态守卫：晚到的旧 run 不得覆盖当前选中，也不得抢占实时流。
      if (selected !== id) return;
      renderDetail(run);
      followLive(id);
    })
    .catch(() => {
      // 同一守卫盖拒绝路径：晚到的旧请求失败不得覆盖当前选中的视图。
      if (selected !== id) return;
      $("detail-kv").innerHTML = '<span class="muted">找不到该运行的记录（可能已被 30 天清理）。</span>';
    });
}

$("back").addEventListener("click", () => { location.hash = ""; });
window.addEventListener("hashchange", route);
route();
refreshList();
setInterval(() => { if (selected === null) refreshList(); }, 30000);
setInterval(() => { if (selected !== null) refreshDetail(selected); }, 30000);

</script>
</body>
</html>`;

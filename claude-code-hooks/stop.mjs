#!/usr/bin/env node
// Stop / SubagentStop — span 合成点：从游标起增量读 transcript JSONL（课题 §2 实测：
// model / usage / 全文 content / tool_use / tool_result / 时间戳全在本地 transcript 里）：
// - 每次模型调用（requestId 归并的 assistant 行组）→ llm span；
// - 每对 tool_use/tool_result → tool span（本地 + MCP 全覆盖、失败也记——DD 参照：
//   Claude Code 官方 OTel 遥测 claude_code.tool 即客户端产出全部工具 span。
//   2026-07-15 治分叉：tool span 从 mcp 服务端双写挪回此处，ADR-0008 补记）；
// - Stop 时另合成/刷新 root agent span（input=用户问题、output=最终回答）。
// v1 平铺树：llm/tool span 的 parent 一律 = root（课题 §3）。
// 输出追加到 spans.jsonl。root span 可能随多次 Stop 重发（同 span_id），读侧按"后写赢"去重。
import crypto from "node:crypto";
import fs from "node:fs";
import { readStdinJson, readState, writeState, appendSpans, reportSpans, cap, run } from "./lib.mjs";

/** 从字节游标起读取完整行；返回 { lines, nextCursor }（未换行收尾的残行不消费）。 */
function readNewLines(file, cursor) {
  const size = fs.statSync(file).size;
  if (size <= cursor) return { lines: [], nextCursor: cursor };
  const fd = fs.openSync(file, "r");
  try {
    const buf = Buffer.alloc(size - cursor);
    fs.readSync(fd, buf, 0, buf.length, cursor);
    const text = buf.toString("utf8");
    const lastNl = text.lastIndexOf("\n");
    if (lastNl < 0) return { lines: [], nextCursor: cursor };
    return {
      lines: text.slice(0, lastNl).split("\n").filter(Boolean),
      nextCursor: cursor + Buffer.byteLength(text.slice(0, lastNl + 1), "utf8"),
    };
  } finally {
    fs.closeSync(fd);
  }
}

/** assistant 消息的可读输出：文本块全文 + tool_use 标记（名字，不含参数）。 */
function assistantText(content) {
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b?.type === "text" ? b.text : b?.type === "tool_use" ? `[tool_use: ${b.name}]` : ""))
    .filter(Boolean)
    .join("\n");
}

/** tool_result 的可读输出：string 直取；块数组取文本块，无文本块退回 JSON 串。 */
function toolResultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const texts = content.map((b) => (b?.type === "text" ? b.text : "")).filter(Boolean);
  if (texts.length) return texts.join("\n");
  try {
    return JSON.stringify(content);
  } catch {
    return "";
  }
}

/** 两个 ISO 时间戳的毫秒差；不可算（缺值/乱序）→ null。 */
function msBetween(fromIso, toIso) {
  const a = Date.parse(fromIso ?? "");
  const b = Date.parse(toIso ?? "");
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
  return b - a;
}

/** 未配对 tool_use 跨批携带上限（state 文件防膨胀；超限丢最旧）。 */
const PENDING_TOOL_USE_MAX = 200;

run(async () => {
  const input = await readStdinJson();
  const state = readState(input.session_id);
  const transcript = input.transcript_path ?? state?.transcript_path;
  // 无 trace 归属或本轮未触发（TDB_OBS_MODE 触发门）→ 不产 span、不上报
  if (!state?.trace_id || state.active === false || !transcript) return;

  const { lines, nextCursor } = readNewLines(transcript, state.cursor ?? 0);
  const pendingSpans = Array.isArray(state.pending_spans) ? state.pending_spans : [];
  const spans = [];

  // 跨批状态：未配对的 tool_use（tool_result 可能落在下一批）+ 上一条 entry 的时间戳
  // （llm 时长近似的起点）。
  const pendingToolUses = new Map(Object.entries(state.pending_tool_uses ?? {}));
  let lastEntryTs = state.last_entry_ts ?? null;

  // 按 requestId 归并（实测坑，2026-07-09 首轮闭环发现）：一次 API 响应会按内容块拆成
  // 多条 assistant 行——requestId 相同、usage 逐行重复。一次模型调用 = 一个 llm span，
  // 逐行出 span 会把轮数虚增 2-3 倍。无 requestId 的行各自成组（合成 transcript 兼容）。
  const groups = [];
  let cur = null;
  for (const [i, line] of lines.entries()) {
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // 容忍脏行
    }

    if (entry?.type === "assistant" && Array.isArray(entry.message?.content)) {
      // 收集 tool_use（所有工具，含本地 Bash/Read 等；MCP 工具剥 telemetry 块、提 intent）
      for (const b of entry.message.content) {
        if (b?.type !== "tool_use" || !b.id) continue;
        const mcp = /^mcp__(.+?)__(.+)$/.exec(b.name ?? "");
        let args = b.input;
        let intent = "";
        if (mcp && args && typeof args === "object" && args.telemetry) {
          const { telemetry, ...rest } = args;
          intent = typeof telemetry?.intent === "string" ? telemetry.intent : "";
          args = rest;
        }
        let inputJson = null;
        try {
          inputJson = cap(JSON.stringify(args));
        } catch {
          /* 入参不可序列化就置空 */
        }
        pendingToolUses.set(b.id, {
          name: mcp ? mcp[2] : (b.name ?? "unknown"),
          mcp_server: mcp ? mcp[1] : null,
          intent,
          input: inputJson,
          ts: entry.timestamp ?? null,
          sidechain: entry.isSidechain ? "1" : "0",
        });
      }

      if (entry.message?.usage) {
        const rid = entry.requestId ?? `line-${i}`;
        if (cur && cur.rid === rid) cur.entries.push(entry);
        else {
          // 新组的时长近似起点 = 组首行之前那条 entry 的落盘时刻（通常是触发本次
          // 模型调用的 user/tool_result 行）。transcript 无请求发起时刻，这是下批近似。
          cur = { rid, entries: [entry], startTs: lastEntryTs };
          groups.push(cur);
        }
      }
    }

    // tool_result 配对（在 user 行里；is_error 的失败调用照记——transport 断掉的
    // MCP 调用也在这里留痕，服务端视角反而看不见）
    if (entry?.type === "user" && Array.isArray(entry.message?.content)) {
      for (const b of entry.message.content) {
        if (b?.type !== "tool_result" || !b.tool_use_id) continue;
        const use = pendingToolUses.get(b.tool_use_id);
        if (!use) continue;
        pendingToolUses.delete(b.tool_use_id);
        spans.push({
          trace_id: state.trace_id,
          span_id: crypto.randomBytes(8).toString("hex"),
          parent_id: state.root_span_id,
          session_id: state.session_id,
          kind: "tool",
          name: use.name,
          model: null,
          status: b.is_error ? "error" : "ok",
          ts: use.ts ?? entry.timestamp ?? new Date().toISOString(),
          duration_ms: msBetween(use.ts, entry.timestamp),
          input: use.input,
          output: cap(toolResultText(b.content)),
          intent: use.intent || undefined,
          tokens_input: null,
          tokens_output: null,
          tokens_cache_read: null,
          tokens_cache_creation: null,
          tags: {
            sidechain: use.sidechain,
            ...(state.ml_app ? { ml_app: state.ml_app } : {}),
            ...(use.mcp_server ? { mcp_server: use.mcp_server } : {}),
          },
        });
      }
    }

    if (entry?.timestamp) lastEntryTs = entry.timestamp;
  }

  for (const g of groups) {
    const first = g.entries[0];
    const last = g.entries[g.entries.length - 1];
    const msg = last.message; // usage/stop_reason 各行重复，取末行；输出拼全组
    // 时长近似：前一条 entry 落盘 → 组内末行落盘。含少量客户端编组开销、略高估；
    // 打 duration_estimated 标与真实测量区分（DD SDK 包住 API 调用才有真时长）。
    const duration = msBetween(g.startTs, last.timestamp);
    spans.push({
      trace_id: state.trace_id,
      span_id: crypto.randomBytes(8).toString("hex"),
      parent_id: state.root_span_id,
      session_id: state.session_id,
      kind: "llm",
      name: "anthropic.messages",
      model: msg.model ?? null,
      status: "ok",
      ts: first.timestamp ?? new Date().toISOString(),
      duration_ms: duration,
      input: null, // 每轮完整 prompt = 之前全部对话，逐轮重复入盘不划算；任务级 in/out 在 root
      output: cap(g.entries.map((e) => assistantText(e.message?.content)).filter(Boolean).join("\n")),
      tokens_input: msg.usage.input_tokens ?? null,
      tokens_output: msg.usage.output_tokens ?? null,
      tokens_cache_read: msg.usage.cache_read_input_tokens ?? null,
      tokens_cache_creation: msg.usage.cache_creation_input_tokens ?? null,
      tags: {
        sidechain: first.isSidechain ? "1" : "0",
        ...(duration != null ? { duration_estimated: "1" } : {}),
        ...(state.ml_app ? { ml_app: state.ml_app } : {}),
        ...(first.requestId ? { request_id: first.requestId } : {}),
        ...(msg.stop_reason ? { stop_reason: msg.stop_reason } : {}),
      },
    });
  }

  // root agent span：主线 Stop 时（不在 SubagentStop）合成/刷新——同 span_id 重发，后写赢。
  if (input.hook_event_name === "Stop") {
    spans.push({
      trace_id: state.trace_id,
      span_id: state.root_span_id,
      parent_id: null,
      session_id: state.session_id,
      kind: "agent",
      name: "claude-code.task",
      model: null,
      status: "ok",
      ts: state.started_at,
      duration_ms: state.started_at ? Date.now() - Date.parse(state.started_at) : null,
      input: cap(state.prompt ?? ""),
      output: cap(typeof input.last_assistant_message === "string" ? input.last_assistant_message : ""),
      tokens_input: null,
      tokens_output: null,
      tokens_cache_read: null,
      tokens_cache_creation: null,
      tags: { trace_source: "client", ...(state.ml_app ? { ml_app: state.ml_app } : {}) },
    });
    state.root_emitted = true;
  }

  appendSpans(spans); // 本地 JSONL 先落（真相源）
  const reportBatch = [...pendingSpans, ...spans];
  const reported = await reportSpans(reportBatch); // HTTP 非 2xx 也视为失败，留待下次重试
  state.cursor = nextCursor;
  state.pending_spans = reported ? [] : reportBatch;
  state.last_entry_ts = lastEntryTs;
  state.pending_tool_uses = Object.fromEntries(
    [...pendingToolUses.entries()].slice(-PENDING_TOOL_USE_MAX),
  );
  writeState(input.session_id, state);
});

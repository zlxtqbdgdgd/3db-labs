#!/usr/bin/env node
// Stop / SubagentStop — span 合成点：从游标起增量读 transcript JSONL，把每条 assistant
// 消息合成一个 llm span（model / usage / 全文 content / 时间戳全在本地 transcript 里，
// 课题 §2 实测），Stop 时另合成/刷新 root agent span（input=用户问题、output=最终回答）。
// v1 平铺树：llm span 的 parent 一律 = root（课题 §3）；tool span 不在本地合成——
// 它由 mcp 侧 recordToolCall 产出（服务端视角，经 PreToolUse 注入同一 trace_id 归属）。
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

run(async () => {
  const input = await readStdinJson();
  const state = readState(input.session_id);
  const transcript = input.transcript_path ?? state?.transcript_path;
  // 无 trace 归属或本轮未触发（TDB_OBS_MODE 触发门）→ 不产 span、不上报
  if (!state?.trace_id || state.active === false || !transcript) return;

  const { lines, nextCursor } = readNewLines(transcript, state.cursor ?? 0);
  const pendingSpans = Array.isArray(state.pending_spans) ? state.pending_spans : [];
  const spans = [];

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
    if (entry?.type !== "assistant" || !entry.message?.usage) continue;
    const rid = entry.requestId ?? `line-${i}`;
    if (cur && cur.rid === rid) cur.entries.push(entry);
    else {
      cur = { rid, entries: [entry] };
      groups.push(cur);
    }
  }

  for (const g of groups) {
    const first = g.entries[0];
    const last = g.entries[g.entries.length - 1];
    const msg = last.message; // usage/stop_reason 各行重复，取末行；输出拼全组
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
      duration_ms: null, // transcript 只有落盘时刻，单轮时长不可得——如实置空
      input: null, // 每轮完整 prompt = 之前全部对话，逐轮重复入盘不划算；任务级 in/out 在 root
      output: cap(g.entries.map((e) => assistantText(e.message?.content)).filter(Boolean).join("\n")),
      tokens_input: msg.usage.input_tokens ?? null,
      tokens_output: msg.usage.output_tokens ?? null,
      tokens_cache_read: msg.usage.cache_read_input_tokens ?? null,
      tokens_cache_creation: msg.usage.cache_creation_input_tokens ?? null,
      tags: {
        sidechain: first.isSidechain ? "1" : "0",
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
  writeState(input.session_id, state);
});

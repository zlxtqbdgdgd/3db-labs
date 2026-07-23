#!/usr/bin/env node
// UserPromptSubmit — trace 铸造点（课题 §3：mint 归"编排循环边界"，在 Claude Code
// 里就是"用户发了一条新消息"这个事件；一条用户消息 = 一条 trace，session 归组）。
// root_span_id 从 trace_id 前 8 字节确定性派生——PreToolUse 无需协调即可算出 parent。
// 不向 stdout 输出任何内容（UserPromptSubmit 的 stdout 会被注入上下文）。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { readStdinJson, readState, writeState, run } from "./lib.mjs";

run(async () => {
  const input = await readStdinJson();
  const sessionId = input.session_id;
  if (!sessionId) return;

  // —— 触发门（DBDOG_OBS_MODE，2026-07-11 用户定：触发了才建 trace，不触发零足迹）——
  //   always     每条消息都记（诊断专用目录用，如 dbdog-test）
  //   triggered  默认：prompt 以触发词开头才记（DBDOG_OBS_TRIGGER，默认「诊断:」；
  //              另恒收 "diag:" 小写前缀作英文触发）
  //   off        彻底关闭
  // 未触发时必须把既有 state 置 inactive——否则本轮的工具调用会被 PreToolUse 注入
  // 上一条 trace 的 id、Stop 会把本轮的模型消息合成进上一条 trace（错误归属）。
  const mode = (process.env.DBDOG_OBS_MODE?.trim() || "triggered").toLowerCase();
  const promptText = (typeof input.prompt === "string" ? input.prompt : "").trimStart();
  const trigger = process.env.DBDOG_OBS_TRIGGER?.trim() || "诊断:";
  // 冒号全半角归一（2026-07-11 用户提出）：中文输入法默认全角「：」，「诊断：」也必须触发；
  // 自定义触发词同样归一后比较，两种冒号都收。
  const norm = (s) => s.replace(/：/g, ":");
  const triggered =
    mode === "always" ||
    (mode === "triggered" &&
      (norm(promptText).startsWith(norm(trigger)) || norm(promptText).toLowerCase().startsWith("diag:")));
  if (!triggered) {
    const prev = readState(sessionId);
    if (prev && prev.active !== false) writeState(sessionId, { ...prev, active: false });
    return;
  }

  // ml_app（DD llmobs 一等维度的 dbdog 对应物）：区分「哪个应用/项目的 trace」——
  // 复盘按它过滤，编码会话和真诊断才分得开。env 显式配 > 项目目录名兜底。
  const mlApp =
    process.env.DBDOG_OBS_ML_APP?.trim() || path.basename(input.cwd || process.cwd()) || "unknown";

  const traceId = crypto.randomBytes(16).toString("hex"); // 32 hex（W3C trace-id 形状）
  const rootSpanId = traceId.slice(0, 16); // 16 hex，确定性派生

  // transcript 读取游标：从当前文件末尾起——Stop 只合成本条 trace 的新增轮次。
  let cursor = 0;
  try {
    cursor = fs.statSync(input.transcript_path).size;
  } catch {
    // 新 session 的 transcript 可能尚未落盘 → 从 0 起
  }

  writeState(sessionId, {
    active: true,
    trace_id: traceId,
    root_span_id: rootSpanId,
    session_id: sessionId,
    ml_app: mlApp,
    prompt: typeof input.prompt === "string" ? input.prompt : "",
    started_at: new Date().toISOString(),
    transcript_path: input.transcript_path ?? null,
    cursor,
    root_emitted: false,
  });
});

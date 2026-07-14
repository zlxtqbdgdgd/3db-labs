// 共用工具：状态文件、spans 落盘、stdin 解析。零依赖（node 内建）。
// 纪律与 src/telemetry.ts 相同：hook 绝不打断会话——所有错误吞掉、exit 0。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 状态/产物目录（每 session 一个状态文件 + 共享 spans.jsonl）。 */
export function obsDir() {
  return process.env.TDB_OBS_DIR?.trim() || path.join(os.homedir(), ".claude", "3db-obs");
}

export function statePath(sessionId) {
  return path.join(obsDir(), `${sessionId}.json`);
}

/** spans 输出（Phase A 本地 JSONL；Phase C 起改 POST 上报，见 ADR-0008/课题 §5）。 */
export function spansPath() {
  return process.env.TDB_OBS_SPANS?.trim() || path.join(obsDir(), "spans.jsonl");
}

export function readState(sessionId) {
  try {
    return JSON.parse(fs.readFileSync(statePath(sessionId), "utf8"));
  } catch {
    return null;
  }
}

export function writeState(sessionId, state) {
  fs.mkdirSync(obsDir(), { recursive: true });
  fs.writeFileSync(statePath(sessionId), JSON.stringify(state));
}

export function appendSpans(spans) {
  if (!spans.length) return;
  fs.mkdirSync(path.dirname(spansPath()), { recursive: true });
  fs.appendFileSync(spansPath(), spans.map((s) => JSON.stringify(s)).join("\n") + "\n");
}

/**
 * 上报 3db（Phase C，课题 §5 信道①）：POST 到 mcp 边缘代理（或 server 直连），
 * DD-API-KEY 鉴权（server 侧 key→org 租户路由）。两个 env 齐备才发；短超时、
 * 吞错——本地 JSONL 永远先落（真相源），上报失败不丢数据、不打扰会话。
 *   TDB_OBS_REPORT_URL  填 3db-mcp 的边缘口：http://<mcp地址>/api/v2/llmobs/spans
 *                       （mcp 原样转发内网 3db-server；用户机器不直连 server。
 *                        server 直连仅限内网部署场景。）
 *   TDB_OBS_API_KEY     3db API key（控制台 settings/api-keys 签发）
 */
export async function reportSpans(spans) {
  const url = process.env.TDB_OBS_REPORT_URL?.trim();
  const key = process.env.TDB_OBS_API_KEY?.trim();
  if (!url || !key || !spans.length) return false;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "DD-API-KEY": key },
      body: JSON.stringify({ spans }),
      signal: AbortSignal.timeout(3000),
    });
    return response.ok;
  } catch {
    // best-effort：上报不可达不影响本地沉淀
    return false;
  }
}

/** 内容截断上限（对齐 mcp 的 TDB_TELEMETRY_OUTPUT_CHARS 先例，默认 8000）。 */
export function contentCap() {
  const n = Number(process.env.TDB_OBS_CONTENT_CHARS ?? "");
  return Number.isFinite(n) && n > 0 ? n : 8000;
}

export function cap(s) {
  if (typeof s !== "string") return null;
  const c = contentCap();
  return s.length > c ? s.slice(0, c) : s;
}

export async function readStdinJson() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** 顶层包装：出错只写 stderr、永远 exit 0（hook 不得打断会话）。 */
export function run(main) {
  main().catch((err) => {
    process.stderr.write(`[3db-obs hook] ${err?.stack ?? err}\n`);
    process.exit(0);
  });
}

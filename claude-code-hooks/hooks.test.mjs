import { afterEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOOK_DIR = path.dirname(fileURLToPath(import.meta.url));
const tempDirs = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempObsDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "3db-obs-hooks-"));
  tempDirs.push(dir);
  return dir;
}

function runHook(script, input, obsDir, extraEnv = {}) {
  const result = spawnSync(process.execPath, [path.join(HOOK_DIR, script)], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: {
      ...process.env,
      TDB_OBS_MODE: "triggered",
      TDB_OBS_TRIGGER: "诊断:",
      TDB_OBS_DIR: obsDir,
      TDB_OBS_SPANS: path.join(obsDir, "spans.jsonl"),
      ...extraEnv,
    },
  });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout;
}

function readState(obsDir, sessionId) {
  return JSON.parse(fs.readFileSync(path.join(obsDir, sessionId + ".json"), "utf8"));
}

describe("Agent Obs hook trigger", () => {
  it("does not create trace state for an ordinary prompt in triggered mode", () => {
    const dir = tempObsDir();
    runHook("user-prompt-submit.mjs", { session_id: "plain", prompt: "看看数据库", cwd: "/tmp" }, dir);
    expect(fs.existsSync(path.join(dir, "plain.json"))).toBe(false);
  });

  it.each(["诊断: 看看数据库", "诊断：看看数据库", "diag: inspect database"])(
    "creates an active trace for %s",
    (prompt) => {
      const dir = tempObsDir();
      runHook("user-prompt-submit.mjs", { session_id: "triggered", prompt, cwd: "/tmp" }, dir);
      const state = readState(dir, "triggered");
      expect(state.active).toBe(true);
      expect(state.trace_id).toMatch(/^[0-9a-f]{32}$/);
      expect(state.root_span_id).toBe(state.trace_id.slice(0, 16));
    },
  );

  it("honors always and off modes", () => {
    const alwaysDir = tempObsDir();
    runHook(
      "user-prompt-submit.mjs",
      { session_id: "always", prompt: "ordinary", cwd: "/tmp" },
      alwaysDir,
      { TDB_OBS_MODE: "always" },
    );
    expect(readState(alwaysDir, "always").active).toBe(true);

    const offDir = tempObsDir();
    runHook(
      "user-prompt-submit.mjs",
      { session_id: "off", prompt: "诊断: should stay off", cwd: "/tmp" },
      offDir,
      { TDB_OBS_MODE: "off" },
    );
    expect(fs.existsSync(path.join(offDir, "off.json"))).toBe(false);
  });

  it("deactivates a previous trace and stops injecting context on an untriggered turn", () => {
    const dir = tempObsDir();
    runHook(
      "user-prompt-submit.mjs",
      { session_id: "same", prompt: "诊断: first", cwd: "/tmp" },
      dir,
    );
    const active = readState(dir, "same");
    const activeOutput = runHook(
      "pre-tool-use.mjs",
      { session_id: "same", tool_name: "mcp__3db__metric", tool_input: { telemetry: { intent: "inspect" } } },
      dir,
    );
    const updated = JSON.parse(activeOutput).hookSpecificOutput.updatedInput;
    expect(updated.telemetry).toEqual({
      intent: "inspect",
      trace_id: active.trace_id,
      parent_span_id: active.root_span_id,
    });

    runHook(
      "user-prompt-submit.mjs",
      { session_id: "same", prompt: "ordinary follow-up", cwd: "/tmp" },
      dir,
    );
    expect(readState(dir, "same").active).toBe(false);
    const inactiveOutput = runHook(
      "pre-tool-use.mjs",
      { session_id: "same", tool_name: "mcp__3db__metric", tool_input: { telemetry: { intent: "inspect" } } },
      dir,
    );
    expect(inactiveOutput).toBe("");
  });
});

// —— Stop 合成（llm + tool span；2026-07-15 起 tool span 客户端合成，服务端双写退役）——

function writeTranscript(dir, name, entries) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, entries.map((e) => JSON.stringify(e)).join("\n") + "\n");
  return p;
}

function seedState(dir, sessionId, transcriptPath, extra = {}) {
  const traceId = "a".repeat(32);
  const state = {
    active: true,
    trace_id: traceId,
    root_span_id: traceId.slice(0, 16),
    session_id: sessionId,
    ml_app: "testapp",
    prompt: "诊断: 为什么卡住",
    started_at: "2026-07-15T00:00:00.000Z",
    transcript_path: transcriptPath,
    cursor: 0,
    root_emitted: false,
    ...extra,
  };
  fs.writeFileSync(path.join(dir, sessionId + ".json"), JSON.stringify(state));
  return state;
}

function readSpans(dir) {
  return fs
    .readFileSync(path.join(dir, "spans.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const T = (s) => `2026-07-15T00:00:${s}Z`;

describe("Stop hook span synthesis", () => {
  it("synthesizes llm spans (estimated duration) and tool spans (local + mcp + failed) from the transcript", () => {
    const dir = tempObsDir();
    const transcript = writeTranscript(dir, "t.jsonl", [
      { type: "user", timestamp: T("00.000"), message: { role: "user", content: "诊断: 为什么卡住" } },
      {
        type: "assistant",
        timestamp: T("05.000"),
        requestId: "req_1",
        isSidechain: false,
        message: {
          model: "claude-fable-5",
          usage: { input_tokens: 3, output_tokens: 50, cache_read_input_tokens: 7, cache_creation_input_tokens: 9 },
          content: [
            { type: "text", text: "先看进程" },
            { type: "tool_use", id: "tu_local", name: "Bash", input: { command: "ls" } },
            {
              type: "tool_use",
              id: "tu_mcp",
              name: "mcp__3db-mcp__get_llmobs_trace",
              input: {
                trace_id: "beef",
                telemetry: { intent: "look up trace", trace_id: "a".repeat(32), parent_span_id: "a".repeat(16) },
              },
            },
          ],
        },
      },
      {
        type: "user",
        timestamp: T("07.500"),
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_local", content: "file1\nfile2" }],
        },
      },
      {
        type: "user",
        timestamp: T("09.000"),
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_mcp",
              is_error: true,
              content: [{ type: "text", text: "Streamable HTTP error: socket dropped" }],
            },
          ],
        },
      },
      {
        type: "assistant",
        timestamp: T("20.000"),
        requestId: "req_2",
        isSidechain: false,
        message: {
          model: "claude-fable-5",
          usage: { input_tokens: 2, output_tokens: 80 },
          content: [{ type: "text", text: "结论如下" }],
        },
      },
    ]);
    seedState(dir, "s1", transcript);

    runHook("stop.mjs", { session_id: "s1", transcript_path: transcript, hook_event_name: "Stop", last_assistant_message: "结论如下" }, dir);
    const spans = readSpans(dir);

    const llm = spans.filter((s) => s.kind === "llm");
    expect(llm).toHaveLength(2);
    // 时长近似：前一条 entry 落盘 → 组内末行落盘，且打估算标
    expect(llm[0].duration_ms).toBe(5000);
    expect(llm[0].tags.duration_estimated).toBe("1");
    expect(llm[1].duration_ms).toBe(11000);

    const tools = spans.filter((s) => s.kind === "tool");
    expect(tools).toHaveLength(2);
    const local = tools.find((s) => s.name === "Bash");
    expect(local.status).toBe("ok");
    expect(local.duration_ms).toBe(2500);
    expect(local.input).toBe(JSON.stringify({ command: "ls" }));
    expect(local.output).toBe("file1\nfile2");
    expect(local.parent_id).toBe("a".repeat(16));
    expect(local.session_id).toBe("s1");
    expect(local.tags.ml_app).toBe("testapp");

    // MCP 工具：名字剥前缀、telemetry 块剥离、intent 提为一等字段；失败调用也留 span
    const mcp = tools.find((s) => s.name === "get_llmobs_trace");
    expect(mcp.status).toBe("error");
    expect(mcp.tags.mcp_server).toBe("3db-mcp");
    expect(mcp.intent).toBe("look up trace");
    expect(mcp.input).toBe(JSON.stringify({ trace_id: "beef" }));
    expect(mcp.output).toContain("socket dropped");

    // 全部 span 同一 session（缺口④a：不再出现服务端会话号）
    expect(new Set(spans.map((s) => s.session_id))).toEqual(new Set(["s1"]));
    const root = spans.find((s) => s.kind === "agent");
    expect(root.output).toBe("结论如下");
  });

  it("pairs a tool_use with a tool_result that arrives in a later batch", () => {
    const dir = tempObsDir();
    const use = {
      type: "assistant",
      timestamp: T("01.000"),
      requestId: "req_1",
      message: {
        model: "m",
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [{ type: "tool_use", id: "tu_x", name: "Read", input: { file_path: "/a" } }],
      },
    };
    const result = {
      type: "user",
      timestamp: T("04.000"),
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tu_x", content: "data" }] },
    };
    const transcript = writeTranscript(dir, "t.jsonl", [use]);
    seedState(dir, "s2", transcript);

    runHook("stop.mjs", { session_id: "s2", transcript_path: transcript, hook_event_name: "SubagentStop" }, dir);
    expect(readSpans(dir).filter((s) => s.kind === "tool")).toHaveLength(0);
    expect(Object.keys(readState(dir, "s2").pending_tool_uses)).toEqual(["tu_x"]);

    fs.appendFileSync(transcript, JSON.stringify(result) + "\n");
    runHook("stop.mjs", { session_id: "s2", transcript_path: transcript, hook_event_name: "SubagentStop" }, dir);
    const tool = readSpans(dir).find((s) => s.kind === "tool");
    expect(tool.name).toBe("Read");
    expect(tool.duration_ms).toBe(3000);
    expect(tool.status).toBe("ok");
  });
});


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

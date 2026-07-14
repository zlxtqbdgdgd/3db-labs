#!/usr/bin/env node
// PreToolUse（matcher: mcp__3db.*）— trace 传播点：出站前把已铸的 trace 上下文
// 经 updatedInput 盖到 telemetry 块上（traceparent 语义：trace_id + parent_span_id）。
// 模型填的 intent 原样保留；mcp 侧 schema 已放行这两个可选字段（ADR-0008，先于本 hook 上线）。
// 不设 permissionDecision——只改入参，权限流照常走。
import { readStdinJson, readState, run } from "./lib.mjs";

run(async () => {
  const input = await readStdinJson();
  // 防御：matcher 已过滤，这里再兜一层。前缀放宽到 mcp__3db——MCP server 在客户端
  // 配置里的名字不固定（日常装 "3db-mcp"、e2e/runner 的 mcp.json 叫 "3db"），
  // 写死 mcp__3db-mcp__ 会让 runner 的工具调用被静默跳过、tool span 挂不进 trace。
  if (!String(input.tool_name ?? "").startsWith("mcp__3db")) return;

  const state = readState(input.session_id);
  // 无 trace（hook 装好前已开的会话）或本轮未触发（TDB_OBS_MODE 触发门）→ 原样放行
  if (!state?.trace_id || state.active === false) return;

  const toolInput = input.tool_input && typeof input.tool_input === "object" ? input.tool_input : {};
  const telemetry = toolInput.telemetry && typeof toolInput.telemetry === "object" ? toolInput.telemetry : {};

  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        updatedInput: {
          ...toolInput,
          telemetry: { ...telemetry, trace_id: state.trace_id, parent_span_id: state.root_span_id },
        },
      },
    }) + "\n",
  );
});

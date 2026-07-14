# 3db-labs · 客户端分发仓

3db 面向**最终用户**的客户端组件固定分发点。用户不需要任何 3db 私有仓库——本仓公开、
位置稳定，文档与安装命令永远指这里。当前内容：**Claude Code Agent Observability hooks**
（`claude-code-hooks/`，研发说明见其中 README）。

> **默认没有——要装（插件，两条命令）**。装完后：普通消息零足迹；以「诊断:」/「diag:」开头的
> 消息自动记录成可检查的 trace 树（配 `TDB_OBS_MODE=always` 则全量记录）。完整用户文档见
> 3db 控制台 **/docs/llmobs 第三部分（接入与命令参考）**。

## 前提

| 组件 | 验证命令 |
|------|---------|
| Claude Code | `claude --version` |
| node ≥ 18 | `node --version` |
| 已连接 3db-mcp | `claude mcp list`（没有就 `claude mcp add --transport http 3db-mcp http://<mcp地址>/mcp`） |

## 安装（插件，2026-07-14 起唯一推荐方式）

```sh
claude plugin marketplace add zlxtqbdgdgd/3db-labs
claude plugin install 3db-agent-obs@3db-labs        # 或会话里 /plugin install 3db-agent-obs@3db-labs
claude plugin list                                  # 应看到 3db-agent-obs@3db-labs
```

hooks 路径由插件机制（`${CLAUDE_PLUGIN_ROOT}`）自动解析，不改任何文件；升级随 marketplace
自动更新；hooks 在**下一个会话**生效。无插件环境或研发调试需要手动接线时，clone 本仓后按
`claude-code-hooks/README.md` 操作（settings-snippet 合并法，历史方式，不再出现在用户文档）。

## 配置（环境变量）

| 变量 | 作用 | 必须？ |
|------|------|--------|
| `TDB_OBS_REPORT_URL` | 上报口：`http://<mcp地址>/api/v2/llmobs/spans` | 想在控制台看树就必须 |
| `TDB_OBS_API_KEY` | 个人 key（控制台 settings → api-keys 签发，`3db_` 前缀，只显示一次） | 同上 |
| `TDB_OBS_MODE` | `triggered`（默认，「诊断:」触发）/ `always`（全记）/ `off` | 否 |
| `TDB_OBS_ML_APP` | trace 分桶名，缺省 = 目录名 | 否 |

前两个放进个人 `~/.claude/settings.json` 的 `env` 块（个人文件，不进 git）：

```json
{ "env": { "TDB_OBS_REPORT_URL": "http://<mcp地址>/api/v2/llmobs/spans", "TDB_OBS_API_KEY": "3db_xxxxxxxx" } }
```

某个目录要全量记录：该目录 `.claude/settings.json` 加 `{ "env": { "TDB_OBS_MODE": "always" } }`。

## 验证（端到端）

**开新会话** → 问题以「诊断:」开头正常提问 → 别中途打断 → 控制台
LLM Observability · Traces 刷新，应看到完整的树（根 🌳 + 推理 🧠 + 工具 🔧）。
排查见控制台 /docs/llmobs（第三部分与附录）或 `claude-code-hooks/README.md`。

## 仓库结构

```
.claude-plugin/     marketplace.json + plugin.json（插件安装通道）
hooks/hooks.json    插件 hooks 定义（${CLAUDE_PLUGIN_ROOT} 引用脚本）
claude-code-hooks/  脚本本体 + 研发 README（含手动接线的历史方式与自检命令）
```

母版历史：2026-07-14 从 3db-mcp `clients/claude-code-hooks/` 迁入并固定于此。

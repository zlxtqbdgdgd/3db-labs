# 3db-labs · 客户端分发仓

3db 面向**最终用户**的客户端组件固定分发点。用户不需要任何 3db 私有仓库——本仓公开、
位置稳定，文档与下载链接永远指这里。当前内容：**Claude Code Agent Observability hooks**
（`claude-code-hooks/`，研发说明见其中 README）。

> **默认没有——要装**。装完后：普通消息零足迹；以「诊断:」/「diag:」开头的消息自动记录成
> 可检查的 trace 树（配 `TDB_OBS_MODE=always` 则全量记录）。完整用户文档见 3db 控制台
> **/docs/llmobs 第三部分（接入与命令参考）**。

## 前提

| 组件 | 验证命令 |
|------|---------|
| Claude Code | `claude --version` |
| node ≥ 18 | `node --version` |
| 已连接 3db-mcp | `claude mcp list`（没有就 `claude mcp add --transport http 3db-mcp http://<mcp地址>/mcp`） |

## 安装（二选一，别两个都装——会重复上报）

### 方式一 · Claude Code 插件（推荐，一条命令）

```sh
claude marketplace add zlxtqbdgdgd/3db-labs
claude plugin install 3db-agent-obs@3db-labs        # 或会话里 /plugin install 3db-agent-obs@3db-labs
```

hooks 路径由 `${CLAUDE_PLUGIN_ROOT}` 自动解析，无需改任何文件；升级 = marketplace 自动更新。

### 方式二 · 手动装（无插件环境 / 想精确控制作用域）

```sh
mkdir -p ~/.claude/3db-client-kit
curl -fsSL http://<3db控制台地址>/downloads/client-kit/claude-code-hooks.tar.gz | tar xz -C ~/.claude/3db-client-kit
KIT=~/.claude/3db-client-kit/claude-code-hooks
sed "s|/ABSOLUTE/PATH/TO/3db-client-kit/claude-code-hooks|$KIT|g" "$KIT/settings-snippet.json" > /tmp/3db-hooks.json
cd <你的目录> && mkdir -p .claude && S=.claude/settings.local.json
[ -f "$S" ] || echo '{}' > "$S"
jq --slurpfile snip /tmp/3db-hooks.json '.hooks = ((.hooks // {}) + $snip[0].hooks)' "$S" > "$S.new" && mv "$S.new" "$S"
```

（也可直接 git clone 本仓代替 curl；settings-snippet.json 的占位路径同样用 sed 换成 clone 路径。）

## 配置（环境变量，插件/手动两种方式通用）

| 变量 | 作用 | 必须？ |
|------|------|--------|
| `TDB_OBS_REPORT_URL` | 上报口：`http://<mcp地址>/api/v2/llmobs/spans` | 想在控制台看树就必须 |
| `TDB_OBS_API_KEY` | 个人 key（控制台 settings → api-keys 签发，`3db_` 前缀，只显示一次） | 同上 |
| `TDB_OBS_MODE` | `triggered`（默认，「诊断:」触发）/ `always`（全记）/ `off` | 否 |
| `TDB_OBS_ML_APP` | trace 分桶名，缺省 = 目录名 | 否 |

插件方式把前两个放进 `~/.claude/settings.json` 的 `env` 块（个人文件，不进 git）：

```json
{ "env": { "TDB_OBS_REPORT_URL": "http://<mcp地址>/api/v2/llmobs/spans", "TDB_OBS_API_KEY": "3db_xxxxxxxx" } }
```

某个目录要全量记录：该目录 `.claude/settings.json` 加 `{ "env": { "TDB_OBS_MODE": "always" } }`。
手动方式则按 settings-snippet.json 注释直接写在 Stop/SubagentStop 命令前（见 kit README）。

## 30 秒自检 + 端到端验证

```sh
# 本地自检：应打印含 trace_id / root_span_id 的一行 JSON（插件方式把 $KIT 换成插件缓存路径，
# 或跳过本步直接做端到端）
D=$(mktemp -d); echo '{"session_id":"t","prompt":"诊断: 自检","transcript_path":"/dev/null"}' \
  | TDB_OBS_DIR=$D node "$KIT/user-prompt-submit.mjs"; cat "$D/t.json"; echo
```

端到端：**开新会话** → 问题以「诊断:」开头正常提问 → 别中途打断 → 控制台
LLM Observability · Traces 刷新，应看到完整的树（根 🌳 + 推理 🧠 + 工具 🔧）。
排查见控制台 /docs/llmobs（第三部分与附录）或 `claude-code-hooks/README.md`。

## 仓库结构

```
.claude-plugin/   marketplace.json + plugin.json（插件安装通道）
hooks/hooks.json  插件 hooks 定义（${CLAUDE_PLUGIN_ROOT} 引用脚本）
claude-code-hooks/  脚本本体 + settings-snippet.json + 研发 README（手动安装通道的母版）
```

母版历史：2026-07-14 从 3db-mcp `clients/claude-code-hooks/` 迁入并固定于此；
3db 控制台 `/downloads/client-kit/` 的 tarball 由部署脚本从本仓同步。

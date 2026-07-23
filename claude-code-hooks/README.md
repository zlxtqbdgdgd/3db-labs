# Claude Code hooks adapter kit（agent 可观测性 · Phase A）

把 Claude Code 从"不进入 Agent Observability"升到"半受控档（全 trace）"的
三个 hook 脚本。零依赖（node 内建），不改 Claude Code 本体、不嵌 SDK。
该目录是可单独分发的 client kit；用户不需要取得或克隆 dbdog-mcp 仓库。

> **默认没有——必须安装**（见下文《安装》，5 步，每步有命令）。
> **装好后怎么触发**：给 Claude Code 发一条以 `诊断:`（或 `diag:`，冒号全半角都认）开头的消息
> ——一条消息 = 一棵 trace 树；普通消息零足迹。全量记录用 `DBDOG_OBS_MODE=always`。

设计总纲：dbdog-web `docs/design/topic-agent-observability.md`；mcp 侧契约：`docs/adr/0008`。

## 前提组件清单（缺一即"静默无树"）

| # | 组件 | 默认就有？ | 怎么办 | 验证命令 |
|---|------|-----------|--------|---------|
| 1 | node ≥ 18（`fetch` 内建） | 通常有 | `brew install node` | `node --version` |
| 2 | dbdog-mcp server 已在 Claude Code 配置 | 否 | `claude mcp add --transport http dbdog-mcp http://<mcp地址>/mcp` | `claude mcp list` |
| 3 | mcp 侧 schema 已放行 trace 字段（ADR-0008） | 服务端 ≥2026-07-09 即有 | 升级服务端 | 见《60 秒自检》第 3 步 |
| 4 | 本 kit 的 4 个 hook 进 settings.json | **否 ← 最常缺的就是这步** | 《安装》Step 2–3 | `jq '.hooks \| keys' ~/.claude/settings.json` |
| 5 | 上报通道（llm/root span 入库用） | 否（不配=只落本地） | 《安装》Step 4 | `curl -s -o /dev/null -w '%{http_code}' -X POST http://<mcp地址>/api/v2/llmobs/spans -H "DD-API-KEY: $DBDOG_OBS_API_KEY" -d '{"spans":[]}'` |

## 分工（mint → propagate → synthesize）

| hook | 角色 |
|------|------|
| `user-prompt-submit.mjs` | **铸**：一条用户消息 = 一条 trace；铸 trace_id（32 hex）+ root_span_id（前 16 hex 确定性派生），写状态文件 |
| `pre-tool-use.mjs` | **传播**：matcher `mcp__dbdog.*`，出站前经 `updatedInput` 把 `telemetry.trace_id/parent_span_id` 盖上（intent 仍由模型填）；不设 permissionDecision，权限流照常 |
| `stop.mjs` | **合成**：增量读 transcript，每条 assistant 消息 → llm span（model/usage/全文，`isSidechain` 标记子代理）；主线 Stop 另出 root agent span（input=用户问题，output=最终回答）。Stop 与 SubagentStop 共用 |

tool span 不在本地合成——mcp 侧 `recordToolCall` 就是它的服务端视角，经注入的 trace_id
与本地 span 同 trace 归属。**注意（ADR-0008，2026-07-14 收紧）：没有客户端注入的完整
trace context，服务端不上报 tool span**——所以第 4 项前提不装，连 tool span 都没有。

## 安装（5 步，全带命令）

**Step 1 — 取 kit，定路径**（本目录随公开仓 `zlxtqbdgdgd/dbdog-labs` 分发：clone 本仓、或从
dbdog 控制台 `/downloads/client-kit/claude-code-hooks.tar.gz` 下载解包；更省事的插件安装
方式见仓根 README——插件方式无需下面的 Step 2–3）：

```sh
KIT=/absolute/path/to/claude-code-hooks   # ← 换成实际绝对路径
ls "$KIT"/{user-prompt-submit,pre-tool-use,stop}.mjs   # 三个文件都在才继续
```

**Step 2 — 渲染 settings 片段**（把模板占位路径换成真路径）：

```sh
sed "s|/ABSOLUTE/PATH/TO/dbdog-client-kit/claude-code-hooks|$KIT|g" "$KIT/settings-snippet.json"
```

**Step 3 — 合并进 settings.json。** 选作用域（想清楚再选，"换个目录就失效"多半是选错了这层）：

| 放哪 | 生效范围 | 适用 |
|------|---------|------|
| `~/.claude/settings.json` | **所有项目、所有新目录** | 个人机器，推荐 |
| `<项目>/.claude/settings.json` | 单项目（可提交共享） | 团队仓 |
| `<项目>/.claude/settings.local.json` | 单项目（gitignore） | 个人试验 |

一键合并（有 jq；已存在同名事件的 hooks 会被覆盖，自查 `jq '.hooks|keys'` 后再跑）：

```sh
S=~/.claude/settings.json
cp "$S" "$S.bak"
jq --slurpfile snip <(sed "s|/ABSOLUTE/PATH/TO/dbdog-client-kit/claude-code-hooks|$KIT|g" "$KIT/settings-snippet.json") \
   '.hooks = ((.hooks // {}) + $snip[0].hooks)' "$S" > "$S.new" && mv "$S.new" "$S"
jq -e '.hooks | keys' "$S"   # 应含 UserPromptSubmit / PreToolUse / Stop / SubagentStop
```

**Step 4 — 配上报通道**（不配也能跑：span 只落本地 JSONL）。dbdog 控制台 **settings → api-keys**
签发 `dbdog_` 前缀 key，然后把 `Stop`/`SubagentStop` 两处命令里的占位换掉：

```sh
sed -i.bak \
  -e "s|http://<dbdog-mcp地址>/api/v2/llmobs/spans|http://<实际mcp地址>/api/v2/llmobs/spans|g" \
  -e "s|<填入dbdog_开头的API key>|dbdog_xxxxxxxx|g" ~/.claude/settings.json
```

**Step 5 — 生效**：hooks 在**下一个** Claude Code 会话生效；当前会话要立即生效，
输入 `/hooks` 回车一次（触发配置重载）。

## 60 秒自检（装完必跑）

```sh
# 1) 铸造点：全角冒号触发词应产出 state 文件（用临时目录，不污染真实 state）
export DBDOG_OBS_DIR=$(mktemp -d)
echo '{"session_id":"selftest","prompt":"诊断：自检","cwd":"'$PWD'","transcript_path":"/dev/null"}' \
  | node "$KIT/user-prompt-submit.mjs" && cat "$DBDOG_OBS_DIR/selftest.json"
# 预期：{"active":true,"trace_id":"<32hex>","root_span_id":"<前16hex>",...}

# 2) 注入点：telemetry 应被盖上同一 trace 上下文
echo '{"session_id":"selftest","tool_name":"mcp__dbdog-mcp__list_llmobs_projects","tool_input":{"telemetry":{"intent":"t"}}}' \
  | node "$KIT/pre-tool-use.mjs"
# 预期：updatedInput.telemetry 含 trace_id + parent_span_id，且 parent = trace 前 16 位
unset DBDOG_OBS_DIR

# 3) 端到端：给 Claude Code 发一条「诊断: 随便问点什么」，跑完后——
ls ~/.claude/dbdog-obs/                 # 应出现 <session_id>.json
tail -3 ~/.claude/dbdog-obs/spans.jsonl # 应有 kind:"agent"(root) 与 kind:"llm" 的行
# LLM Obs UI 按 ml_app:<目录名> 过滤 traces，应看到完整树（root → llm/tool span）
```

## 产物与配置

- 状态：`~/.claude/dbdog-obs/<session_id>.json`（trace 上下文 + transcript 游标）
- span：`~/.claude/dbdog-obs/spans.jsonl`（每行一个 span，本地真相源永远先落）
- **上报 dbdog**（Phase C，ADR-0034）：设 `DBDOG_OBS_REPORT_URL`（`http://<dbdog-mcp 地址>/api/v2/llmobs/spans`）
  + `DBDOG_OBS_API_KEY`（控制台 settings/api-keys 签发）后，Stop 合成的 span 会 best-effort
  从 MCP 边缘口 POST 入库；未设两 env = 只落本地，行为与 Phase A 相同
- env：`DBDOG_OBS_DIR`（状态/产物目录）、`DBDOG_OBS_SPANS`（spans 路径）、
  `DBDOG_OBS_CONTENT_CHARS`（内容截断，默认 8000，对齐 `DBDOG_TELEMETRY_OUTPUT_CHARS` 先例）、
  `DBDOG_OBS_ML_APP`（应用名标签，打进 root/llm span 的 `tags.ml_app`；缺省 = 项目目录名。
  复盘按它过滤——同一台机器上编码会话与真诊断靠它分开）

## 触发门（DBDOG_OBS_MODE，2026-07-11）

默认**不再全量记录**——触发了才建 trace，不触发全链零足迹（不铸号、不注入、
mcp 不双写、不上报，跟没装一样）：

| 模式 | 行为 | 用在哪 |
|------|------|--------|
| `triggered`（默认） | prompt 以触发词开头才记（`DBDOG_OBS_TRIGGER`，默认 `诊断:`；`diag:` 恒收；**冒号全半角都认**——中文输入法的「：」照样触发） | 日常工作仓（如 dbdog-web） |
| `always` | 每条消息都记 | 诊断专用目录（如 dbdog-test，配在 UserPromptSubmit 命令前） |
| `off` | 彻底关闭 | — |

实现细节：未触发的 prompt 会把会话 state 置 `active:false`——否则该轮的工具调用会被
注入**上一条** trace 的 id、模型消息被合成进上一条 trace（错误归属）。

## 故障排查（症状 → 原因 → 处置）

| 症状 | 最可能原因 | 处置 |
|------|-----------|------|
| 一个 span 都没有 | 消息没带触发词 | 以 `诊断:` 开头重发；或 `DBDOG_OBS_MODE=always` |
| hook 完全不触发（state 文件不出现） | 会话早于安装 / settings 没合对 | `/hooks` 回车重载或开新会话；`jq -e '.hooks\|keys' ~/.claude/settings.json` |
| 只有 llm/root span，没有 tool span | mcp 会话失效（`no valid session; expected an initialize request first`）或旧版 mcp 剥掉了 trace 字段 | Claude Code 里 `/mcp` → reconnect（客户端不会自动重连）；确认服务端 ≥ ADR-0008 |
| tool span 有，llm/root span 只在本地 `spans.jsonl` | 上报 env 没配齐（两个都要） | 补 `DBDOG_OBS_REPORT_URL` + `DBDOG_OBS_API_KEY`（安装 Step 4），用前提清单第 5 行的 curl 验证 |
| 自写注入器，span 被服务端拒收 | `parent_span_id` 不合派生约定 | 必须 = `trace_id` 前 16 hex；建议直接用本 kit 的 `pre-tool-use.mjs` |
| settings 里有 `curl → localhost:8126/claude/hooks` 一类 hook | 历史遗留实验，**不属于本 kit**，静默空转 | 删除；本 kit 全链路不经过 8126 |

## span 形状（v1 平铺树）

所有 llm span 的 `parent_id` = root_span_id（DD llmobs agent trace 常见形状），
tool↔llm 邻接靠时间戳；深嵌套留待后续（transcript 的 tool_use 块足以重建，不丢信息）。
**一次模型调用 = 一个 llm span**：transcript 把一次 API 响应按内容块拆成多条 assistant 行
（requestId 相同、usage 重复），合成器按 requestId 归并——逐行出 span 会虚增轮数 2-3 倍
（首轮闭环实测坑）。
llm span 的 `input` 置空（每轮完整 prompt = 之前全部对话，逐轮重复入盘不划算）；
任务级 in/out 在 root span。`duration_ms` 单轮不可得（transcript 只有落盘时刻），如实置空。

## 已知语义（读侧须知）

- **root span 会重发**：同一 trace 多次 Stop（如用户中断后继续）时 root 以同 span_id
  重新追加（output/duration 刷新）——读侧按 span_id"后写赢"去重。
- **hook 装好前已开的会话**：无状态文件 → 全部 hook 静默放行，不产 span。
- **纪律**：任何错误只写 stderr、exit 0——hook 绝不打断会话（同 `src/telemetry.ts`）。

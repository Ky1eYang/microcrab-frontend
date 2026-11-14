import type { NativeMessage } from "../src/client/types";

// A richer transcript for the beautify acceptance specs (Part B): user Markdown
// with a list and a table, three tool calls with output, and an assistant
// answer with a heading, a quote, a code block, a table and a task list.
const SHELL_OUTPUT = Array.from(
  { length: 30 },
  (_, i) => `   Compiling microcrab-crate-${i} v0.1.6 (crates/crate-${i})`,
).join("\n");

export const RICH_TITLE = "路由整理与 WS 收敛";

export const richMessages: NativeMessage[] = [
  {
    id: "m1",
    role: "user",
    parts: [],
    tool_calls: [],
    text: `帮我检查一下 \`crates/server/src/route.rs\` 的路由组织，并给出改进建议：

1. 列出所有 \`/api/v1\` 路由
2. 标注哪些仍走 WS

| 列 | 说明 |
|---|---|
| A | 示例 |`,
  },
  {
    id: "m2",
    role: "assistant",
    parts: [],
    text: "我先读取路由文件，再搜索 WS 相关的处理函数。",
    tool_calls: [
      {
        id: "c1",
        name: "read",
        arguments: {
          path: "crates/server/src/route.rs",
          offset: 1,
          limit: 200,
        },
      },
      {
        id: "c2",
        name: "grep",
        arguments: {
          pattern: "ws_handler|WebSocketUpgrade",
          path: "crates/server",
        },
      },
      {
        id: "c3",
        name: "shell",
        arguments: { command: "cargo metadata --format-version 1 --no-deps" },
      },
    ],
  },
  {
    id: "t1",
    role: "tool",
    call_id: "c1",
    tool_name: "read",
    parts: [],
    tool_calls: [],
    text: `//! Central route tree for the native server.
pub(crate) fn router(state: AppState) -> Router {
    Router::new().nest("/api/v1", v1::router()).with_state(state)
}`,
  },
  {
    id: "t2",
    role: "tool",
    call_id: "c2",
    tool_name: "grep",
    parts: [],
    tool_calls: [],
    text: `{"matches":[{"file":"crates/server/src/route/ws.rs","line":42}],"truncated":false}`,
  },
  {
    id: "t3",
    role: "tool",
    call_id: "c3",
    tool_name: "shell",
    parts: [],
    tool_calls: [],
    text: SHELL_OUTPUT,
  },
  {
    id: "m3",
    role: "assistant",
    parts: [],
    tool_calls: [],
    text: `## 路由现状

\`/api/v1\` 下共有 **14** 条 HTTP 路由，WS 只保留在 \`/api/v1/ws\`：

- 会话生命周期：\`create / open / close / archive\`
- 设置与历史：\`permission\`、\`history\`、\`mode\`

> 建议把 \`auth\` 也挂到 \`route/\` 目录下，保持「一处登记」。

\`\`\`rust
pub(crate) fn router() -> Router<AppState> {
    Router::new().route("/sessions", get(list).post(create)).route("/sessions/:id", get(open))
}
\`\`\`

| 路由 | 方法 | 通道 |
|---|---|---|
| /api/v1/sessions | GET/POST | HTTP |
| /api/v1/ws | GET | WS |

- [x] 路由集中
- [ ] auth 迁移`,
  },
];

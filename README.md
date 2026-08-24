# TaskMux

TaskMux V1 是一个本地、纯文本的 Codex 会话工作台。它通过 Codex App Server 保存原生会话历史，在浏览器里提供多会话切换、流式文本、工具状态、审批和取消。

## 前置条件

- Node.js 24 或更高版本
- pnpm 9
- 已安装并登录可用的 Codex CLI（`codex --help` 应成功）

## 安装

```bash
pnpm install
```

## 开发运行

`--workspace` 必须是已存在目录的绝对路径；一次进程只绑定一个工作区，运行期间不可变更。

```bash
TASKMUX_DATA_DIR=/绝对路径/taskmux-data \
  pnpm dev -- --workspace /绝对路径/your-workspace --port 4317
```

打开 `http://127.0.0.1:4317`。服务固定绑定回环地址，不对局域网或公网监听。

## 生产运行

```bash
pnpm build
NODE_ENV=production TASKMUX_DATA_DIR=/绝对路径/taskmux-data \
  pnpm start -- --workspace /绝对路径/your-workspace --port 4317
```

生产模式由 Fastify 提供构建后的静态资源，未知的非 API 导航回退到工作台；未知 API 保持 JSON 404。

## 数据

会话索引保存在 `TASKMUX_DATA_DIR/taskmux.sqlite`，完整消息历史仍由 Codex App Server 管理。未设置 `TASKMUX_DATA_DIR` 时，默认位置为：

- macOS：`~/Library/Application Support/TaskMux`
- Linux：`${XDG_DATA_HOME:-~/.local/share}/taskmux`
- Windows：`%LOCALAPPDATA%/TaskMux`

备份、迁移或清理数据前先停止 TaskMux。不要把数据库、Playwright 报告或测试结果提交到仓库；这些路径已加入 `.gitignore`。

## 测试

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

单元测试和 E2E 都使用临时目录与 fake App Server；E2E 走真实 HTTP、SSE、JSON-RPC client 和 adapter 边界，但不会启动真实 Codex，也不会读取用户主目录下的 Codex 状态。`pnpm test:e2e` 需要 Playwright Chromium；缺失时运行 `pnpm exec playwright install chromium`。

## 手动真实 Codex smoke

这项检查不属于正常测试或 CI，只能针对明确可丢弃的目录手动运行。脚本会直接启动 Codex App Server，发送固定提示词，禁止工具调用，并始终停止子进程。

```bash
TASKMUX_SMOKE_WORKSPACE=/绝对路径/disposable-workspace \
TASKMUX_SMOKE_DISPOSABLE=YES \
pnpm smoke:codex
```

不要把真实项目、含未提交改动的目录或用户主目录作为 smoke workspace。

## 安全边界

- HTTP 服务只绑定 `127.0.0.1`。
- workspace 在启动时确定，运行中不可切换。
- Codex 进程使用参数数组启动，不经过 shell。
- 未知工具或未知交互不会被自动批准；界面只展示稳定诊断操作，不泄露 stderr、环境变量或协议原文。
- E2E 的 workspace、数据库和 fake 状态均在独立临时目录中创建并在测试后清理。

## V1 限制

- 只支持纯文本消息；不包含附件、富文本、diff、终端或 MCP 管理界面。
- 同一时刻全局只允许一个运行中的 turn。
- 单进程只支持一个固定 workspace，不提供远程访问、多用户或鉴权服务。
- V1 只实现第一个 Agent（Codex）的专用 adapter。ACP 兼容层推迟到接入第二个 Agent 时再抽象，避免在尚无第二种真实协议前提前设计。

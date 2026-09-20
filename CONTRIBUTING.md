# 贡献指南

感谢你愿意为 CommerceAgent 提交代码、文档或 Issue。本指南说明**怎么在本机跑起来、改完怎么验证、PR 需要包含什么**，照着做就能让 review 快很多。

> 提交前请先阅读 [行为准则](CODE_OF_CONDUCT.md) 与 [安全策略](SECURITY.md)。发现安全问题时请按 SECURITY.md 私下报告，不要开公开 Issue。

## 环境要求

| 项      | 要求                                                      |
| ------- | --------------------------------------------------------- |
| Node.js | **≥ 20**（CI 使用 24，建议对齐）                          |
| 包管理  | npm（仓库使用 `package-lock.json`，请勿改用其它包管理器） |
| Docker  | **可选**，只有需要容器沙箱模式时才要装                    |
| 系统    | macOS / Linux / Windows 均可；CI 覆盖 Linux 与 Windows    |

## 快速开始

```bash
git clone https://github.com/<你的账号>/commerceagent.git
cd commerceagent

# 三个独立的 npm 工程都要装依赖
npm ci
npm --prefix web ci
npm --prefix container/agent-runner ci

# 启动前后端（首次会自动补齐依赖）
make dev
```

## 常用命令

| 命令                                | 作用                                       |
| ----------------------------------- | ------------------------------------------ |
| `make dev`                          | 启动前后端开发环境                         |
| `make dev-backend` / `make dev-web` | 只启动后端 / 只启动前端                    |
| `make build`                        | 编译后端、前端与 agent-runner              |
| `make typecheck`                    | 全量类型检查（后端 + 前端 + agent-runner） |
| `make test`                         | 运行单元测试（Vitest）                     |
| `make format` / `make format-check` | 格式化 / 检查格式（Prettier + Ruff）       |
| `make clean`                        | 清理构建产物                               |

前端 E2E（Playwright，需要浏览器）：

```bash
npm --prefix web run test:e2e
```

## 代码规范

- **格式化与 lint**：提交前跑 `make format`，并确保 `make format-check` 通过。CI 会检查**本次改动涉及的文件**是否已格式化。
- **类型**：`make typecheck` 必须通过；新增公开函数请写类型注解与 docstring。
- **测试**：行为变化请补测试。修 bug 时建议先写一条能复现问题的测试（它会先失败），再改代码。
- **跨平台**：仓库的 CI 同时跑 Linux 与 Windows，测试里不要假设 POSIX 路径或 Unix 专有行为；涉及终端的地方注意 Windows 使用 ConPTY。
- **依赖**：新增运行时依赖前请先开 Issue 讨论；`shared/` 下的类型定义由 `make sync-types` 生成，不要手改生成结果。

## 提交信息

沿用仓库现有风格（`type(scope): 描述`，描述用中文）：

```
fix(tasks): 修复定时任务在时区切换后重复触发
feat(desktop): 支持从托盘快速打开工作台
docs(readme): 补充桌面端下载说明
```

常用 type：`feat` / `fix` / `docs` / `refactor` / `chore` / `ci` / `test`。

## 提交 Pull Request

1. **Fork 本仓库**，从 `main` 创建分支，分支名建议 `fix/<简述>` 或 `feat/<简述>`。
2. **保持改动聚焦**：一个 PR 只解决一个问题；不要把无关格式化、重构或依赖升级混进来。
3. **本地验证**并记录命令与结果：

   ```bash
   make typecheck && make test && make format-check
   ```

   改动 `desktop/` 时，另外确认打包仍然可用：

   ```bash
   npm run build:all
   npm --prefix desktop run fetch-node     # 首次
   npm --prefix desktop run stage
   npm --prefix desktop run dist:dir
   ```

4. **提交 PR 并填写模板**：说明改了什么、为什么、怎么验证、是否影响兼容性；关联的 Issue 用 `Closes #<编号>` 引用。
5. **等待 CI**：首次贡献者的 workflow 需要维护者批准后才会运行（GitHub 的默认安全策略），请耐心等一会儿；CI 红的时候先看日志，区分是代码问题、配置问题还是环境阻塞。
6. **响应 review**：请在同一分支上追加提交，不要为修改意见另开 PR。

## 不要提交

- 任何密钥、Token、`~/.commerceagent` 或 `data/` 下的运行时数据、日志。
- 构建产物：`dist/`、`web/dist/`、`desktop/release/`、`desktop/.runtime*/`、`desktop/vendor/`、`node_modules/`（均已在 `.gitignore` 中）。
- 与本次改动无关的格式化结果（会让 diff 难以 review）。

## 桌面端说明

`desktop/` 是 Electron 外壳，后端作为 sidecar 子进程运行：

- 后端与 agent-runner 的生产依赖由 `desktop/scripts/stage-runtime.mjs` 用 **vendor 的 Node 运行时**安装，以保证 `better-sqlite3`、`node-pty` 的 ABI 与运行时一致；不要把 `node_modules` 直接拷进产物。
- 打包请用 `npm --prefix desktop run dist:mac` / `dist:win`，它会先拉取对应架构的 Node 运行时再打包。
- 更多细节（架构、路径、未签名包的放行方式）见 [`desktop/README.md`](desktop/README.md)。

## 问题反馈

- **Bug**：使用 [Bug 报告模板](https://github.com/sclfcz/commerceagent/issues/new?template=bug_report.yml)，尽量附上复现步骤、期望行为与实际行为、相关日志（记得脱敏）。
- **功能建议**：使用 [功能建议模板](https://github.com/sclfcz/commerceagent/issues/new?template=feature_request.yml)。
- **提问 / 讨论**：开 Issue 说明你的场景与已尝试的做法即可。

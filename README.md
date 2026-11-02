# Project State Workbench

Project State Workbench 是一个本地项目状态工作台。它把任务、验收条件、决策、文件观察结果和操作记录保存成可核对的结构化状态，让使用者在网页里查看和修改，也让 AI 通过工具登记自己的工作。这让不同对话共享项目状态与行为动机，从而形成跨对话、去中心化的组织结构。

当前开源整合版本为 `0.1.1`，包含源内核 `0.5.1` 与 Windows 工作台 `1.3.3`。功能和接口仍会继续更新。

## 它的意义

对于一个项目，跨对话协作常见的困难在于——agent工作的基本单元是对话，但我们需要上下文结束后，任务是否完成、为什么这样决定、哪些文件被改过、某次操作结果如何，这些都散落在聊天记录里，并没有以项目本身的结构组织起来。——工作台把这些内容放进每个工作区独立的 SQLite 记录中，让使用者与ai在对话的自然推进中形成关于项目的对话的组织（使用者与AI事先未必知晓项目可以或应当以哪种结构组织，但伴随着工作的推进与记录，结构便会自然涌现）。这里对于相关记录，提供两种入口：

- **使用者查看和修改**：在本地网页工作台编辑任务、讨论与决策、原则和设置，查看历史。
- **AI 登记和读取**：通过 MCP stdio 工具打开会话，读取当前状态摘要，登记任务、认领、决策、观察结果和完成情况。

支持MCP的Agent大部分均可接入，对dsh有专门适配器。

## 快速开始

需要 Node.js `24.2.0` 或更高版本。开发环境使用 `24.18.1` 实测；安装依赖使用仓库锁文件：

```powershell
npm ci --ignore-scripts
npm start
```

`npm start` 会启动本地后台并打开系统浏览器。后台需要停止时运行 `npm run stop`；它会先核验实例与数据目录。当前启动器面向 Windows；默认编辑入口为 `127.0.0.1:8769`。端口被占用时，启动器会尝试避让；同一数据目录已有实例运行时，会复用该实例。

也可以双击仓库根目录的 `启动工作台.cmd`。若找不到合适的 Node.js，它会给出明确提示，不会自动下载运行时。

在 Windows 之外，可以用前台方式启动：

```powershell
npm run serve
```

然后手动访问启动输出中的 URL。文件夹选择器、桌面入口和 WSL 集成仍只适用于 Windows，因此这里不宣称完整跨平台支持。

## 让 AI 与使用者读同一份状态

MCP 入口是：

```text
node server/src/mcp-server.js
```

为共享状态选择一个稳定目录，并通过 `PROJECT_STATE_ROOT` 显式传给 MCP 宿主。工作台的 `workbench/workbench.json` 中，`storageRoot` 必须指向同一目录，双方才会读到同一批工作区记录。

`workbench/workbench.json` 是本地配置，不应提交。可从 `workbench/workbench.example.json` 开始复制，再改成自己的绝对路径。不同配置、不同副本或默认目录不一致时，可能各自产生独立数据库；不要假设它们天然共用状态。

用户在当前对话明确启用共享状态后，AI 应先调用 `project_open_session`。会话返回一个仅存于内存的令牌；后续读写都在该令牌和任务作用域内进行，调用 `project_close_session` 后失效。`actorId` 是声明的协作身份，用于区分记录来源，不是可信身份认证。服务器也无法判断模型是否真的获得了用户同意，这依赖宿主权限和双方遵守的协作纪律。

主要工具包括：

- 会话与读取：`project_open_session`、`project_close_session`、`project_get_surface`
- 批量写入：`project_apply_batch`
- 任务：`project_create_task`、`project_claim_task`、`project_release_task`、`project_complete_task`
- 记录：`project_observe_artifact`、`project_record_operation`、`project_get_operation`、`project_record_decision`

批量调用可以减少工具往返；记录带有版本号，用于处理并发修改冲突。详细约定见 [AI 协作说明](docs/ai-collaboration.md)。

## 工作台里有什么

工作台可以编辑任务和验收条件，记录讨论与决策，登记协作原则、调整设置并查看事件历史。页面在可见时每 15 秒轮询一次，不使用服务器推送，因此看到的不是实时协作画面，而是最近一次刷新后的状态。

工作台还会在项目目录生成可读的状态镜像。镜像包含用户登记的任务、决策、路径和历史内容，仍属于隐私数据，不应随意提交到公开仓库或发给第三方。

## 数据放在哪里

每个工作区使用独立的 SQLite 存储，保存任务与验收条件、认领关系、决策、文件哈希观察、操作结果和事件历史。同一个共享根目录可以包含多个工作区，但各工作区不是同一张全局数据库。

WSL 中运行的程序使用 Linux 原生路径读写自己的 SQLite。Windows 与 WSL 的“统一列表”不意味着两边共用一个数据库。可选辅助脚本为：

```text
python workbench/app/connect-wsl.py ...
```

它要求显式提供 Linux 路径，目标目录须包含 `data/workspaces`；使用前请运行 `--help` 查看当前参数。示例里的路径应替换为实际位置，不要照搬虚构值。

## 私网只读查看（可选）

需要从可信设备查看工作台时，可以让 Tailscale Serve 把本机查看入口 `8770` 暴露在私网中。不要转发编辑入口 `8769`，也不要在默认配置中启用公网 Funnel。

Serve 会清洗并插入 Tailscale 身份头；查看器校验指定用户、只允许白名单内的 GET 请求，并阻断写入。该身份头本身不能证明请求一定来自 Serve，可信边界是本机回环加上正确的 Serve 配置；本机同一用户不被当作隔离的攻击者。远程是否使用 TLS 取决于 Serve 配置，不能保证浏览器侧一定有 TLS。原文会显示路径、任务和历史，只应授权给可信设备和账号。具体说明见 [私网只读访问](docs/private-viewing.md)。

## 隐私与安全边界

软件默认只在本机运行，没有内置项目云同步、AI 模型调用、API Key 要求、分析遥测或第三方前端 CDN。下载 npm 依赖、访问 GitHub 或启用 Tailscale 仍会接触第三方服务。SQLite 数据库和工作日志没有内置静态加密。

依赖由锁文件安装；第三方组件继续遵循各自许可。

MCP 会把所读取的状态交给 AI 宿主，宿主可能将内容发送给所选模型服务商；本地存储并不保证 AI 协作内容始终留在本机。

请阅读 [隐私说明](PRIVACY.md) 和 [安全说明](SECURITY.md) 后再决定共享目录和远程访问范围。

## 项目结构

```text
core/                与宿主无关的 SQLite 状态内核
server/              MCP stdio 服务与 JSON CLI
dsh/                 可选的 DeepSeek Harness 适配
workbench/app/       本地网页工作台与 Windows 入口
docs/                使用、架构和协作说明
```

## 验证与当前状态

仓库提供以下命令：

```powershell
npm test
npm run test:workbench
npm run check:release
```

Windows 上的 65 项核心、MCP 与真实 Harness 适配器测试、22 项工作台检查和 19 项只读查看检查已通过。完整依赖审计报告为 0 个已知漏洞。检查范围与可复现命令见 [RELEASE_CHECKS.md](RELEASE_CHECKS.md)，这不代表所有环境或未来依赖版本都已验证。

## 继续阅读

- [详细上手](docs/getting-started.md)：安装、共享目录、MCP 配置和常见问题
- [架构说明](docs/architecture.md)：组件、数据流、版本冲突与信任边界
- [AI 协作说明](docs/ai-collaboration.md)：会话、工具、记录习惯和责任边界
- [私网只读访问](docs/private-viewing.md)：Tailscale Serve 配置范围与风险
- [贡献说明](CONTRIBUTING.md)：开发、测试、文档和提交约定

本项目采用 MIT 许可证，详见 [LICENSE](LICENSE) 与 [第三方依赖清单](THIRD_PARTY_NOTICES.md)。

# 快速上手

Project State Workbench 是本地项目状态工作台。当前公开整合版 0.1.0，内核 0.5.0，Windows 工作台 1.3.2。系统要求 Node.js 24.2.0 或更高；开发与回归在 Windows Node 24.18.1 上完成。公开源码见 [GitHub 仓库](https://github.com/abcdef-user/project-state-workbench)。此版本提供源码，不提供预编译安装包。

## 安装与启动

在源码目录执行 `npm ci --ignore-scripts`，再用 `npm start`。锁文件安装路径可复现；`--ignore-scripts` 跳过依赖生命周期脚本，适合当前回归。Windows 也可双击根目录 `启动工作台.cmd`；找不到合适 Node 时它会提示，不会自动下载运行时。可选运行 `powershell -File workbench/build-launcher.ps1` 在本机编译 GUI 启动器；仓库未分发 `node.exe` 或 exe。

`npm start` 会读取本地配置并打开系统浏览器；默认编辑入口为 `127.0.0.1:8769`。端口占用时启动器会尝试避让；同一数据目录已有实例时会复用。非 Windows 或需要前台调试时运行 `npm run serve`，然后手动打开输出中打印的 URL。系统文件夹按钮和 WSL 集成仅适用于 Windows，不宣称完整跨平台支持。

## 配置共享目录

复制 `workbench/workbench.example.json` 为 `workbench/workbench.json`，把 `storageRoot` 和 `dataDirectory` 改成自己的绝对目录。`workbench.json` 是本地文件，不应提交。注意：`npm start` 会读取该配置；`npm run serve` 如果需要读取配置，要显式加参数，例如 `npm run serve -- --config-file workbench/workbench.json --data-dir <目录> --storage-root <目录>`。当前 `--config-file` 仅导入 `wslSources` 和 `remoteView`，`storageRoot`/`dataDirectory` 仍要用参数，不要假设它会自动读取全部配置。

## 让 AI 读同一份状态

MCP 入口是 `node server/src/mcp-server.js`。为 MCP 宿主设置环境变量 `PROJECT_STATE_ROOT`，并让它与工作台的 `storageRoot` 指向同一绝对目录。通用 JSON 示例见 `examples/mcp-config.json`。不同配置、副本或默认目录可能各自生成数据库，不要假设天然共享。用户需在当前对话明确开启共享状态，AI 再调用 `project_open_session`；令牌仅存内存，关闭会话后失效。

## 验证与排障

可运行 `npm test`、`npm run test:workbench`、`npm run check:release`。在 Windows Node 24.18.1 上，64 项核心/MCP/真实 DSH 宿主测试、22 项工作台场景、19 项只读入口场景均通过；`npm audit`（含开发依赖）报告 0 个已知漏洞。具体报告见根 [RELEASE_CHECKS.md](../RELEASE_CHECKS.md)。常见问题是 MCP 与工作台指向不同目录、`npm run serve` 未显式传配置参数，或把 Windows 与 WSL 的列表汇总误当成同一数据库。WSL 使用 Linux 原生路径和 worker，需要单独确认。

后台运行时，可执行 `npm run stop` 核验并停止当前配置数据目录的工作台；修改配置后再执行 `npm start`。如果改了 `dataDirectory`，应先停止旧实例，再修改该目录值。前台运行则用终端的 Ctrl+C 停止。单纯再次运行 `npm start` 会复用现有实例，不会应用新配置。

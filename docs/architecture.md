# 架构说明

Project State Workbench 0.1.1 由源内核 0.5.1、MCP/CLI 服务、可选 DSH 适配和 Windows 工作台 1.3.3 组成。`core/` 提供与宿主无关的 SQLite 状态内核，保存任务与验收条件、认领、决策、文件观察、操作结果和事件历史。`server/` 提供 MCP stdio 入口 `server/src/mcp-server.js` 与 JSON CLI。`dsh/` 是可选适配层。`workbench/app/` 是本地网页工作台和 Windows 启动入口。

数据以工作区为边界：每个工作区使用独立 SQLite，同一共享根目录可包含多个工作区，但不是一张全局数据库。人通过网页编辑状态，AI 通过 MCP 会话读取摘要并登记任务、决策、观察和操作；两类入口必须指向同一 `storageRoot`/`PROJECT_STATE_ROOT` 才共享记录。网页每 15 秒轮询，不提供服务器推送。写入带版本号，用于发现并发修改冲突；版本号不是权限系统。SQLite 历史可帮助核对，但不是防篡改审计。

WSL 使用 Linux 原生路径和 worker 读写自己的数据库；Windows 与 WSL 的列表汇总不合并存储，不能据此认为两边共库。只读查看是可选部署：Tailscale Serve 仅转发查看端口 8770，查看器校验指定账号、只允许白名单 GET 并拒绝写入；不可转发编辑端口 8769。可信边界是本机回环加正确 Serve 配置，Tailscale 身份头只有经 Serve 清洗注入后才可信，本机其他进程不在隔离边界内。

系统要求 Node.js 24.2.0+。Windows Node 24.18.1 上，65 项核心/MCP/真实 DSH 宿主测试、22 项工作台场景、19 项只读入口场景均通过；具体报告见根 `RELEASE_CHECKS.md`。测试通过说明当前回归状态，不构成安全认证或对现实任务执行的证明。
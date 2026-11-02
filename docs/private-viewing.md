# 私网只读查看

这是可选功能，用于从可信设备查看工作台，不用于公网发布。启用前先确认：只读入口仍会显示任务、项目绝对路径与历史，SQLite 和日志未加密；只授权给可信设备、账号和私网。

## 配置工作台

1. 复制 `workbench/workbench.example.json` 为 `workbench/workbench.json`，该本地文件不应提交。
2. 按自身需要设置 `storageRoot` 与 `dataDirectory` 为绝对目录。
3. 在 `remoteView` 中设 `enabled` 为 `true`，`port` 为 `8770`，`scheme` 为 `https`，`publicHost` 改为自己的设备完整 `.ts.net` 域名并加 `:8443`，`allowedLogin` 填自己的 Tailscale 账号。
4. 初次启动前完成配置，然后运行 `npm start`。如果后台工作台已经运行，先在修改配置前执行 `npm run stop`，再保存配置并执行 `npm start`；再次启动不会自动重载已有实例的配置。
5. 安装官方 Tailscale 并登录，运行 `tailscale serve --bg --https=8443 http://127.0.0.1:8770`。首次按官方提示完成授权。
6. 在平板上用同一 Tailscale 账号连接，打开 `https://<设备完整域名>:8443/index.html`。

只转发 8770；不要转发编辑入口 8769；不要启用 Funnel。HTTPS 依赖私网服务开通和正确证书设置，不能以关闭证书验证作为修复。若确实使用 HTTP，只在加密私网内使用，并显式设置 `scheme`、`publicHost` 和 Serve 对应端口；不要把 HTTP 作为默认教程推荐。

## 信任边界

账号限制在服务端执行。Tailscale 身份头只有经过 Serve 清洗和注入后才可信；客户端自填的同类头不能当认证。本机其他进程不在隔离边界内，不能把同一台机器上的恶意进程当作已隔离。查看器拒绝写入，但列表和详情仍含任务、项目绝对路径与历史。公开版在 Windows Node 24.18.1 上通过 19 项只读入口场景；这表示当前回归结果，不等于安全认证。配置或证书不确定时，先停用远程查看，保留本地 8769 编辑入口，再查 Tailscale 官方文档。
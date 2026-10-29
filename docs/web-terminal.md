# 网页终端 API 与连接协议

端点为 `POST /api/accounts/{accountId}/machines/{machineId}/terminal`。先验证面板密码与请求 Origin，再以所属账号 Key 读取机器详情，并申请 `/v1/machines/{machineId}/access` 的 `{kind:"terminal", requireTicket:true}`。仅返回 url、token、protocol；验证 WSS、官方 instabox.sh 域、目标机器路径和票据格式，不传账号 Key。所有 JSON 响应 no-store，不记录终端输入输出或票据。

协议依据当前官方控制台发布资源 `da13db929344dc9c` 的终端实现：subprotocol 为 `instabox-access.v1` 与 `instabox-access-token.<token>`，输入/输出为二进制，resize 为 JSON 文本，session/exit/taken/error 为控制帧。浏览器直接连接官方终端，Worker 不维护长连接。参数 `wake=0`；会话 ID 是当前页内按账号+机器随机生成的 `panel-` 加 26 位 UUID 十六进制，共 32 字符。实连发现上游要求 `[a-z0-9-]{1,32}`，已据此限制长度并补充回归检查，避免与官方 main 会话或其他浏览器抢占。是否持久化由 session.persistent 决定，不承诺刷新或冷却后的 Shell 保留。

按需加载固定版本 xterm 5.5.0 与 FitAddon 0.10.0，JS/CSS 使用下载校验得到的 SHA-384 SRI。这样无需额外构建或机器内终端守护进程，仍可单文件粘贴部署；CDN 故障只影响终端加载。上游 /access 和终端协议来自官方控制台，尚非公开 SDK 稳定接口，部署时必须实连验收。

断开不自动重试，避免冷却/权限错误时不断申请票据；手动重连复用当前页的独立会话。关闭、退出登录、页面离开释放 WebSocket、ResizeObserver、timer 和 xterm；迟到的票据响应不能打开隐藏 Shell。Escape 不关闭 dialog，保持终端程序键盘行为。

验证包括账号路由、认证与 Origin、状态保护、上游错误与票据验证；真实 workerd 请求路径；真实 xterm 资源的浏览器测试（模拟 PTY）覆盖二进制/中文输入、Ctrl+C、缩放、重连、关闭竞争、登录失效和桌面/手机布局。已在两个账号的真实实例上验证 hostname/id/pwd 输出、stty size 缩放、Ctrl+C、同会话重连和正常退出。生产部署时仍需使用自己的账号再次验收；本地模拟测试不替代真实权限与网络检查。

界面约定见 [DESIGN.md](../DESIGN.md)。

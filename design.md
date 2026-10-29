# 多账号保活与网页终端

## 目标与兼容性

- 用途为开发、测试和 Agent 临时任务的机器管理。不部署或整合反向代理、通用流量转发、代理节点。Worker 只调用官方控制 API；如后续接入监控，Agent 单向上报指标，第三方主题资源代理不纳入整合。
- 临时任务按需保活，完成后关闭保活再暂停／停止或删除机器。网页终端支持手动交互命令，自动 Agent 任务调度仍由外部工具负责；CLI／其他控制台停机不会自动关闭本面板的保活开关。
- 继续用单文件 ES Module Worker 部署，不增加运行时依赖。
- 首次部署推荐每个账号一个 Secret：`INSTABOX_API_KEY_1`、`INSTABOX_API_KEY_2`，后缀作为稳定账号 ID；可选文本变量 `INSTABOX_ACCOUNT_NAME_1` 等设置名称。机器由各账号 API 自动发现，不逐台配置 ID。面板内不保存或编辑凭据，凭据由 Cloudflare Secrets 管理。
- 保留 `INSTABOX_API_KEY`（账号 ID `default`）及 `INSTABOX_ACCOUNTS` JSON 数组。三种形式可组合，ID 和 Key 必须唯一；轮换 Key 时保持 ID。JSON 迁移到单独 Secret 时保留同一后缀，例如 `id: second` 使用 `INSTABOX_API_KEY_second`。
- 各账号分别分页列举机器；单个账号失败不隐藏其他账号的机器。API Key 只用于服务端请求，不出现在页面、API 响应、Redis 配置或日志中。
- 机器操作路由为 `/api/accounts/{accountId}/machines/{machineId}/{action}`。旧 `/api/machines/{machineId}` 路由仅对应 `default`，不猜测账号。
- Redis hash 字段使用 `accountId:machineId`。旧 `m_...` 字段仅映射到 `default`，首次写入后迁移；如果已存在新字段，以新字段为准。移除账号后保留其配置，Cron 不会改用其他 Key。

## 状态处理

每次保活先读取机器详情。有效的未来 `cooldownUntil` 阻止续租、start 和 resume；冷却期结束后在下轮 Cron 重试。过渡状态和正在执行的 operation 只等待。运行中的机器续 3600 秒租约；停止的机器 start，暂停的机器 resume，有限次数查询启动结果，确认 running 后才续租。异步操作受理不计为租约成功。

409 触发一次状态重查，不一律当成 stopped；未知状态与失败都记录具体结果。单台失败不阻断后续机器。每台机器使用 Redis 短期互斥锁，序列化 Cron、保活开关和手动生命周期操作，避免关掉保活后被旧任务覆盖；锁以随机 token 比较后释放，异常退出后自动到期。

## 界面与调度

保持现有布局；多账号时在机器与日志中显示账号名称。冷却结束时间、等待启动和失败原因明确显示。冷却中禁用启动／唤醒，保留关闭保活等操作。

默认 `*/15 * * * *`，每小时四轮，1 小时租约为短暂失败留余量。可通过 `KEEPALIVE_INTERVAL_MINUTES` 与 Cron 同时调整；`*/9` 在每小时 54 分到下个整点只有 6 分钟间隔，页面按 Cron 的分钟字段计算，不能用从 epoch 起每 9 分钟的算法。下次时间从当前时间和冷却截止时间推算，不复用过期的 lastAt。活动租约不解除平台运行时长上限或冷却。

一个 Cron 覆盖所有开启保活的机器。通过每次调用独立的请求计数器约束 HTTP 和定时请求；`WORKER_SUBREQUEST_LIMIT` 默认 50，不跟随会额外消耗额度的重定向。锁获取与当前配置读取使用同一 Redis pipeline，状态和日志写回也合并。定时正常每台 5 个请求，异常最坏路径为每台 11 个请求（包括三次启动确认、409 重查、写回、释放及额外失败日志）。每轮有 1 个初始 pipeline；若不足以处理一台的最坏路径，留给下轮。

按 `accountId:machineId` 稳定排序，读取 `instabox:scheduler-cursor` 后从其下一项开始，尾部绕回。游标与锁获取在同一 pipeline 中推进，失败或本轮终止不让尾部机器永久饿死。移除账号与关闭保活时不再调度该项。游标仅用于公平调度，不替代单机锁；重复 Cron 可能跳过占用的机器，但不会并发操作同一台。

定时执行设置 13 分钟截止时间，并在进入下一台前为最坏超时路径预留足够时间；每次 fetch 的超时不超过剩余时间。长时间失败可能减少单轮处理数量，因此容量估算不构成可用性保证。

免费预算一轮保守按 4 台，正常可处理 8 台。默认 15 分钟间隔时按 12 台规划，3 轮 45 分钟覆盖一次。页面以当前预算和启用数量估算保守轮巡周期，超过 45 分钟时建议调整间隔或拆分面板。CPU、Redis、平台 API 限制与运行冷却仍独立生效。

## 验证

使用 Node 内置测试与模拟 InstaBox／Redis，覆盖账号路由、旧配置迁移、分页、账号失败隔离、租约、冷却、409、启动确认、并发互斥和每台失败隔离。浏览器通过模拟数据检查双账号、冷却、错误与移动端布局。不使用真实 API Key，也不启动／暂停用户的实际机器。

新增验证首次部署多 Secret、同 ID 轮换、请求预算、12 台跨轮覆盖、复杂恢复与写回失败路径的请求上限、游标移除容错、超容量提示及多页列表预算。不把模拟吞吐视为真实云端 CPU／网络负载验证。

## Workers 运行时修复（2026-10-28）

线上暴露出 `redirect: "error"` 不受 Workers/workerd 支持，导致 Redis 与 InstaBox 在发请求前同时失败。统一请求封装现改为 `manual`，3xx 仍由原有 HTTP 非成功分支报告，不自动跟随重定向。账号解析、凭据和 Redis 数据格式不变。

单元测试的 fetch mock 现在拒绝 Workers 不支持的 redirect 值，并新增 API/Redis 302 错误与不跟随目标的回归检查。真实 workerd 本地验证先复现相同故障，再验证两个账号、Redis 配置/日志、配额及 302 处理；外部服务响应在测试中模拟，不使用线上凭据。

## 网页终端（2026-10-29）

从每台机器卡片直接打开 xterm，减少多账号 CLI 操作。保留现有页面，仅增加终端按钮和原生 dialog；桌面为大窗口，手机为全屏。标题显示机器与账号，提供粘贴、Ctrl+C、重连、关闭。运行前检查 state、runtime.ready、operationId 和冷却，终端入口不自动启动或唤醒机器，不修改保活开关。

端点为 `POST /api/accounts/{accountId}/machines/{machineId}/terminal`。先验证面板密码与请求 Origin，再以所属账号 Key 读取机器详情，并申请 `/v1/machines/{machineId}/access` 的 `{kind:"terminal", requireTicket:true}`。仅返回 url、token、protocol；验证 WSS、官方 instabox.sh 域、目标机器路径和票据格式，不传账号 Key。所有 JSON 响应 no-store，不记录终端输入输出或票据。

协议依据当前官方控制台发布资源 `da13db929344dc9c` 的终端实现：subprotocol 为 `instabox-access.v1` 与 `instabox-access-token.<token>`，输入/输出为二进制，resize 为 JSON 文本，session/exit/taken/error 为控制帧。浏览器直接连接官方终端，Worker 不维护长连接。参数 `wake=0`；会话 ID 是当前页内按账号+机器随机生成的 `panel-` 加 26 位 UUID 十六进制，共 32 字符。实连发现上游要求 `[a-z0-9-]{1,32}`，已据此限制长度并补充回归检查，避免与官方 main 会话或其他浏览器抢占。是否持久化由 session.persistent 决定，不承诺刷新或冷却后的 Shell 保留。

按需加载固定版本 xterm 5.5.0 与 FitAddon 0.10.0，JS/CSS 使用下载校验得到的 SHA-384 SRI。这样无需额外构建或机器内终端守护进程，仍可单文件粘贴部署；CDN 故障只影响终端加载。上游 /access 和终端协议来自官方控制台，尚非公开 SDK 稳定接口，部署时必须实连验收。

断开不自动重试，避免冷却/权限错误时不断申请票据；手动重连复用当前页的独立会话。关闭、退出登录、页面离开释放 WebSocket、ResizeObserver、timer 和 xterm；迟到的票据响应不能打开隐藏 Shell。Escape 不关闭 dialog，保持终端程序键盘行为。

验证包括账号路由、认证与 Origin、状态保护、上游错误与票据验证；真实 workerd 请求路径；真实 xterm 资源的浏览器测试（模拟 PTY）覆盖二进制/中文输入、Ctrl+C、缩放、重连、关闭竞争、登录失效和桌面/手机布局。已在两个账号的真实实例上验证 hostname/id/pwd 输出、stty size 缩放、Ctrl+C、同会话重连和正常退出。生产部署时仍需使用自己的账号再次验收；本地模拟测试不替代真实权限与网络检查。

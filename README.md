# InstaBox 保活面板

给多个 InstaBox 账号的云机器做活动租约保活的可视化管理面板。单文件 Cloudflare Worker，前端页面、InstaBox API 调用、定时保活全部内嵌在 `worker.js` 里，配置与日志存放在 Upstash Redis。

适用于开发、测试和 Agent 临时任务的机器管理；不部署反向代理、通用流量转发或代理节点。面板提供官方网页终端，可手动运行命令；自动 Agent 任务调度仍由外部工具负责。任务完成后关闭保活，再暂停、停止或删除机器。

## 为什么需要它

InstaBox 免费机器默认空闲 30 分钟后自动暂停；是否可以调整或关闭空闲暂停取决于账号权限和套餐。

本面板通过 **activity lease（活动租约）** 保活：租约有效期内机器不会进入空闲暂停，定时续期可避免空闲暂停。**租约不能解除平台的运行时长上限、冷却期或其他限制，不保证永不暂停。**租约单次最长 3600 秒，配合 15 分钟一次的定时任务，可为短暂续租失败留出缓冲。

## 功能

- 每个账号配置一个 Cloudflare Secret，首次部署即可接入多个账号
- 多账号机器列表与实时状态（运行中 / 已暂停 / 已停止 / 操作过渡态），自动读取全部分页
- 每台机器显示所属账号；一个账号请求失败不影响其他账号
- 冷却截止时间与自动重试状态，冷却中不调用启动、唤醒或续租
- 启动、唤醒、暂停、停止、删除
- 每台运行中机器可打开 xterm.js 交互终端，自动使用所属账号，支持粘贴、Ctrl+C、缩放和重连
- 每台机器独立开关自动保活，显示检查时间、冷却状态与租约剩余时间
- 保活日志，保留最近 200 条
- 面板密码保护，所有接口需鉴权
- 操作按钮防重复点击，操作期间整张卡片锁定

## 界面预览

登录后进入控制台，顶部可在「机器」与「日志」之间切换。

**登录**

![登录页](images/panel-login.png)

**机器列表**：每张卡片显示状态、规格、操作按钮，以及自动保活的上次/下次保活时间与租约剩余。

![机器列表](images/panel-machines.png)

**保活日志**：记录每次续期与手动操作，存于 Upstash Redis，可一键清空。

![保活日志](images/panel-logs.png)

## 保活效果

![连续运行时长](images/komari-uptime.png)

**历史监控示例**：以下资源曲线来自另行部署的监控系统，不是保活面板自带功能，也不代表当前账号可以绕过暂停或运行时长限制。

![近 24 小时历史曲线](images/komari-24h-history.png)

## 前置条件

| 依赖 | 获取方式 |
|---|---|
| InstaBox API Key | 登录 [InstaBox 控制台](https://dashboard.instabox.sh/dashboard/machines)，进入 **Profile → API keys** 创建，`ibk_` 开头；每个账号各取一个 Key |
| Upstash Redis | 在 [Upstash](https://upstash.com) 创建，步骤见下方 |
| Cloudflare 账号 | 免费注册，登录 [Cloudflare Dashboard](https://dash.cloudflare.com) |

## 准备 Upstash Redis

1. 打开 <https://upstash.com>，点 **Sign In**，选择 **Continue with GitHub** 直接登录，不需要单独注册。
2. 进入控制台选择 Redis 进行创建，区域挑离你较近的节点，计划保持 **Free**。
3. 创建完成后进入数据库详情页，在 **REST API** 区域复制两个值，稍后填入 Worker 环境变量：
   - `UPSTASH_REDIS_REST_URL`
   - `UPSTASH_REDIS_REST_TOKEN`

URL 使用 `https://…upstash.io` 形式的 REST 根地址，不填 `redis://` 地址，不附加 `/pipeline` 或结尾 `/`。Token 应属于同一个数据库并允许读写；只读 Token 无法保存保活开关、锁和日志。

免费额度为每月 **500,000 次命令**、**250 MB 存储**、**10 GB 带宽**。本面板每 15 分钟续期一次，一天约 96 轮，每轮命令数随开启保活的机器数量增长；多账号、互斥锁、手动操作和页面刷新也会消耗额度。请以 Upstash 的实际用量统计为准。

![Upstash 免费额度](images/upstash-free-tier.png)

## 部署：一次配置全部账号

**一个账号填一个 API Key，面板自动发现该账号下所有机器。** 不用填写机器 ID、SSH 地址或代理信息，也不用先部署单账号版本。账号的机器数量由 InstaBox 套餐决定。

部署前先区分新建与升级，避免改变第一账号的身份：

| 场景 | 第一账号 | 第二账号 |
|---|---|---|
| 全新面板，没有旧保活数据 | `INSTABOX_API_KEY_1` | `INSTABOX_API_KEY_2` |
| 已有单账号面板升级 | 保留 `INSTABOX_API_KEY` | 新增 `INSTABOX_API_KEY_2` |

已有面板不要同时保留第一账号的 `INSTABOX_API_KEY` 与 `_1` 两份配置，也不要为了统一编号而改名：旧名对应账号 ID `default`，原保活设置属于它；`_1` 对应新的账号 ID `1`。

**代码和变量必须配套更新。** 旧单账号代码只读取 `INSTABOX_API_KEY`，仅添加 `_1`、`_2` 不会获得多账号能力。使用本说明同版本的完整 `worker.js`；当前请求封装使用 Workers 支持的 `redirect: "manual"`，不要使用曾导致所有外部请求失败的 `redirect: "error"` 版本。

### 全新部署：Cloudflare 网页控制台

1. 在 **Workers & Pages** 创建 Worker，在 **Edit code** 粘贴 `worker.js` 全文并部署，保持 ES Module 格式。
2. 在 **Settings → Variables and Secrets** 添加下面的 **Secret**。以两个账号为例：

   | Secret 名称 | 填写内容 |
   |---|---|
   | `ADMIN_PASSWORD` | 自己设置的面板登录密码 |
   | `UPSTASH_REDIS_REST_URL` | Upstash 的 REST 地址 |
   | `UPSTASH_REDIS_REST_TOKEN` | Upstash 的 REST 令牌 |
   | `INSTABOX_API_KEY_1` | 第一个 InstaBox 账号的 API Key |
   | `INSTABOX_API_KEY_2` | 第二个 InstaBox 账号的 API Key |

   只有一个账号就只填 `_1`；三个账号继续加 `_3`。不需要 JSON，也不需要同时填写旧的 `INSTABOX_API_KEY`。
3. 保存并部署变量，在 **Trigger Events → Cron Triggers** 添加 **一个** `*/15 * * * *`。如果配置了普通文本变量 `KEEPALIVE_INTERVAL_MINUTES`，填 `15`。定时任务统一处理所有账号下已开启保活的机器。
4. 在 Worker 的 **Observability / Logs** 开启日志记录，以便查看定时执行结果。
5. 打开面板，输入 `ADMIN_PASSWORD` 登录。确认机器列表、配额和日志加载正常，再为需要保持运行的机器开启「自动保活」。

以后增加账号，只需在同一个 Worker 增加 `INSTABOX_API_KEY_3` 等 Secret，保存部署后刷新面板。同一账号下增加机器时，Key 不变，刷新即可发现；新机器默认不开启保活。添加 Key 本身不会创建机器，账号下没有机器时不会出现新机器卡片。

可选的普通文本变量 `INSTABOX_ACCOUNT_NAME_1`、`INSTABOX_ACCOUNT_NAME_2` 用于自定义显示名称，未设置时显示「账号 1」「账号 2」。Key 始终使用 **Secret** 类型。

### 已有单账号面板：保留设置升级

1. 保留原 `INSTABOX_API_KEY`、`ADMIN_PASSWORD` 和 Redis 的两个 Secret；新增第二账号的 `INSTABOX_API_KEY_2`。如果已把第一账号复制到 `_1`，确认有效 Key 仍在旧名后移除重复的 `_1`。
2. 在原 Worker 的 **Edit code** 中完整替换为新版 `worker.js` 并部署。不要新建一套 Redis，也不要清空 `instabox:machines`。
3. 核对 Cron 为 `*/15 * * * *`；已有 15 分钟 Cron 不再重复添加。若原来为 `*/9`，将 Cron 和 `KEEPALIVE_INTERVAL_MINUTES` 一起调整到 15。
4. 刷新面板，确认「默认账号」与「账号 2」的机器都能列出，第一账号原来的保活状态仍正确。再按需开启第二账号机器的保活。

一个账号只配置一个 Key；同一账号生成的两个不同 Key 也不应当成两个账号添加。真正轮换 Key 时只更换原变量的值，保留变量名和账号 ID。

### Wrangler CLI：全新部署

需要 Node.js 22 或更新版本。使用项目根目录的 `worker.js` 和配置，先检查本地代码：

```bash
npm run check
npm test
npm install -g wrangler
wrangler --version
wrangler login
wrangler whoami
cp wrangler.example.toml wrangler.toml
```

编辑 `wrangler.toml` 中的 Worker 名称，确认目标账号和 Cron，然后执行：

```bash
wrangler deploy --config wrangler.toml --keep-vars

wrangler secret put ADMIN_PASSWORD
wrangler secret put UPSTASH_REDIS_REST_URL
wrangler secret put UPSTASH_REDIS_REST_TOKEN
wrangler secret put INSTABOX_API_KEY_1
wrangler secret put INSTABOX_API_KEY_2
```

命令会交互读取 Secret；不要把 Key 放进命令行或提交进仓库。模板已配置一个 15 分钟 Cron 和 `keep_vars = true`。登录成功后若仍提示 Token 无效，检查当前终端是否设置了过期的 `CF_API_TOKEN` / `CLOUDFLARE_API_TOKEN`；这些变量会优先于 OAuth 登录。选择一种有效认证方式后再发布。

CLI 首次部署完成后，同样在控制台开启 Observability / Logs 并完成下方上线验收。

### Wrangler CLI：只升级代码

已有部署优先复用现有配置，不要直接用示例覆盖。把控制台当前的 Worker 名称、账号、兼容日期、日志、预览等设置同步到本地；`--keep-vars` 只保留变量，不会替你保留所有其他配置。

```bash
wrangler versions upload --config wrangler.toml --keep-vars --dry-run
wrangler versions upload --config wrangler.toml --keep-vars
# 将下行的 VERSION_ID 替换为上一步返回的版本 ID。
wrangler versions deploy VERSION_ID@100 --config wrangler.toml
```

上传仅生成候选版本，最后一步才切换生产流量。保持默认打包；不要对含调试工具和临时文件的整个仓库使用 `--no-bundle`。只更新代码时不运行 `wrangler triggers deploy`；Cron、路由和自定义域名不需要重建。Cloudflare Secrets 在部署时保留，避免重新录入或复制出旧密钥。

### 上线验收

- 使用原面板密码登录，刷新机器列表、配额与日志；公开首页能打开不等于真实 API 已通。
- 两个账号各自显示正确的机器，账号错误和 Redis 读取错误均消失。
- 已有部署的第一账号仍为 `default`，旧保活状态正确；新机器按需启用。
- 立即保活检查或后续 Cron 日志出现明确结果；冷却、启动等待、失败须按实际状态显示，不能视为续租成功。
- 在 Worker 日志中查看 `keepalive_tick_ok` 的处理统计；不要仅凭事件名称判断每台机器都已续租，还要查看面板逐机结果。

### 能否在面板中填写 Key

当前版本通过 Cloudflare Secrets 管理 Key；面板负责发现机器、开关保活和查看状态，没有网页输入 Key 的表单。面板内保存 Key 需要另外增加加密存储和账号管理，本版本使用 Cloudflare 已提供的凭据管理功能。

## 配置参考与旧版本兼容

日常只需使用上面的编号 Secret。下面是可选配置和旧部署迁移规则。

| 变量 | 用途 |
|---|---|
| `INSTABOX_API_KEY_1`、`_2`… | 推荐配置，每个账号一个 Secret |
| `INSTABOX_ACCOUNT_NAME_1`、`_2`… | 可选，普通文本，自定义账号名称 |
| `INSTABOX_API_KEY` | 兼容旧版，对应稳定账号 ID `default` |
| `INSTABOX_ACCOUNTS` | 可选 Secret，JSON 账号数组，与旧配置兼容 |
| `KEEPALIVE_INTERVAL_MINUTES` | 可选，默认 `15`，范围 1–30；与 Cron 的分钟步长一致 |
| `WORKER_SUBREQUEST_LIMIT` | 高级配置，默认 `50`；只能在套餐实际允许时提高，修改变量本身不会提升 Cloudflare 额度 |

按当前官方 CLI 的 scope 名称，日常列举、执行命令、SSH 和生命周期操作使用 `machines:read`、`machines:write`；其中 write 包含 exec/SSH。需要面板删除机器功能时才额外授予 `machines:delete`。具体权限以当前账号控制台和 `instabox keys create --help` 为准。

已有单账号部署可保留 `INSTABOX_API_KEY`，直接增加 `INSTABOX_API_KEY_2`。旧账号仍是 `default`，旧保活设置继续生效，不需要改名为 `_1`。

已有 JSON 配置同样可以保留。例如：

```json
[
  { "id": "default", "name": "账号一", "apiKey": "ibk_REPLACE_WITH_FIRST_ACCOUNT_KEY" },
  { "id": "second", "name": "账号二", "apiKey": "ibk_REPLACE_WITH_SECOND_ACCOUNT_KEY" }
]
```

三种写法可组合，但账号 ID 和 Key 都不能重复。编号 Secret 的后缀就是账号 ID，例如 `_1` 对应 `1`，`_second` 对应 `second`。ID 使用 1–32 位小写字母、数字、`_` 或 `-`，以字母或数字开头。轮换 Key 保持变量名不变；如果把 JSON 中 `id: "second"` 改成单独 Secret，使用 `INSTABOX_API_KEY_second` 并移除原 JSON 条目，可保留原设置。

移除账号会停止其保活，但保留 Redis 设置；用相同 ID 添加回来后原设置重新生效。不要把同一 Key 用多种形式重复配置。不同独立面板应使用独立 Redis 数据，避免相同账号 ID 指向不同账号。

## 定时任务与机器数量

只需一个 Cron。每轮处理所有已开启保活的账号／机器，达到请求预算时自动分批，下轮从上次处理位置继续。关闭保活的机器不消耗定时续租请求。

默认 **`*/15 * * * *`**，成功续租有效 3600 秒。冷却结束后也要等待调度；少量机器通常等下一轮，分批情况下可能要等后续轮次。频率更高不能解除平台冷却或运行上限。

**机器数没有写死的总上限，但不代表可以无限保活。** 需要同时满足 Worker 子请求／CPU／执行时间、Redis 配额及 InstaBox API 限制。以下是默认免费 Worker 的请求预算规划，不是可用性保证：

| 场景 | 请求预算与规划 |
|---|---|
| 单次执行 | 默认限制 50 个子请求，与 Workers Free 对齐；面板接口也应用预算 |
| 每轮正常续租 | 约 1 个初始请求 + 每台 5 个请求，保留恢复和错误路径余量后可处理 8 台 |
| 冷启动、冲突等复杂路径 | 为每台预留最多 11 个请求，一轮保守按 4 台规划 |
| 15 分钟 Cron | 建议先按 **最多 12 台已开启保活的机器**规划，3 轮约 45 分钟覆盖一次，给 1 小时租约留余量 |
| 更多机器 | 可改成 5 分钟 Cron、拆分独立面板，或在付费 Worker 上调预算；仍须检查实际 CPU、耗时和 Redis 用量 |

本地模拟验证了 12 台正常机器跨两轮全部续租，每轮 41 个请求；也验证了恢复、409 与写回失败同时发生时每轮最多 45 个请求，游标继续前进。尚未在真实云端验证满负载 CPU／网络耗时。长时间超时、CPU 超限、冷却或续租失败会使上述覆盖估算失效；运行日志中的 `processed`、`deferred`、`requests` 可用于判断实际情况。页面在保守覆盖周期超过 45 分钟时给出提示。

程序合并锁与配置读取、合并状态与日志写回，以减少请求；执行时间也预留边界，防止一轮一直运行到平台强制终止。请求预算不足不会把后面的机器永久饿死，游标在处理前持久保存。

若改为 `*/5 * * * *`，同时设置 `KEEPALIVE_INTERVAL_MINUTES=5`。`*/9` 在每小时 `00、09、18、27、36、45、54` 分触发，54 分到整点只有 6 分钟，不是严格每 9 分钟；这里仍推荐 15 分钟，机器较多或希望更快恢复时选 5 分钟。仅改变量不会修改 Cloudflare Cron。

Cloudflare 当前官方限制为 Free 每次 50 个子请求、Paid 默认每次 10,000 个；Free 的 CPU 配额、单次 Cron 的 15 分钟时长仍独立生效。环境变量（含 Secret）也有数量限制：Free 64 项、Paid 128 项，每项 5 KB，因此账号数与机器数不能混为一谈。以 [Cloudflare Limits](https://developers.cloudflare.com/workers/platform/limits/) 和你的实际套餐为准。

## 使用

**终端**：点击机器卡片的「终端」按钮，即可在页面内打开 xterm.js。页面会显示当前机器与账号，无需在本机切换 CLI 登录，也无需将 InstaBox API Key 复制到浏览器。暂停、冷却、操作中或尚未就绪时不能连接，先使用卡片上的启动/唤醒操作。

Worker 用对应账号的 Key 调用官方控制台当前使用的 `/v1/machines/{id}/access`（`kind: terminal`、`requireTicket: true`），浏览器仅取得官方终端票据，通过 WebSocket subprotocol 传递，直接连接官方 PTY。账号 Key、面板密码均不放进 WebSocket URL；票据响应不缓存、不写日志。面板管理员因此可以操作所有已配置账号的终端，请按机器管理凭据保管面板密码。

当前页面按「账号 + 机器 ID」分配独立会话，手动重连复用该会话 ID；上游支持持久会话时可恢复。刷新页面会分配新会话，不保证复原旧 Shell。关闭窗口或退出登录会断开浏览器连接，但不等于停止机器或结束所有任务；长任务建议用 tmux 或后台任务，并核对退出状态。Escape 保留给 vim 等终端程序，关闭使用窗口按钮。

终端按需加载 jsDelivr 上固定版本的 `@xterm/xterm@5.5.0` 与 `@xterm/addon-fit@0.10.0`，JS/CSS 带 SHA-384 SRI 校验；保留单文件 Worker 部署。浏览器须能访问该 CDN 和官方 WSS 服务。组件加载失败时可重连，保活 Cron 不受影响。官方终端接口尚未列入公开 SDK 稳定契约，如上游改变协议需跟进适配。

**机器页**：卡片展示机器名称、状态、机器 ID、规格与模板。操作按钮随状态变化：

- 运行中 → 暂停、停止
- 已暂停 → 唤醒
- 已停止 → 启动

暂停和停止都会弹出确认。两者的区别：

| 操作 | 效果 |
|---|---|
| 暂停 | 保留内存和运行中的进程，唤醒后从原地继续 |
| 停止 | 相当于关机，磁盘文件保留，内存和进程结束，下次启动是冷启动 |

**自动保活开关**：打开后立即检查一次，符合状态条件才续租；冷却中等待到期，启动中等待确认。卡片显示上次检查、下轮全局调度、冷却结束时间或租约状态；分批时本机可能在后续轮次处理。首次失败仍保留开关开启，后续 Cron 继续重试。

通过本面板手动暂停、停止或删除时，会先持久化关闭保活，再下发机器操作。即使请求超时、无法确认是否已受理，也保持保活关闭，避免下一轮意外拉起；请检查机器状态后自行决定是否重新开启。其他控制台或 CLI 的停机不会自动修改这里的开关，需要先在面板关闭保活。

**日志页**：查看最近 50 条保活与操作记录，可一键清空。日志存放在 Redis，与浏览器无关。

## 保活机制

1. Cloudflare Cron 触发 `scheduled()`，读取所有已启用的 `accountId:machineId` 配置，使用对应账号的 Key。
2. 每台机器先查询状态。未来的 `cooldownUntil` 阻止所有保活写请求；有进行中的操作或过渡状态则等待下一轮。
3. `running` 调用 `PUT /v1/machines/{id}/activity-leases/keepalive`，租约时长 3600 秒。返回正确机器 ID 和有效的未来到期时间才算续租成功。
4. `stopped` 调用 start，`suspended` 调用 resume，然后有限次数确认状态；确认为 running 后立即续租，尚未就绪则记录等待，不冒充成功。
5. 409 会重查机器状态，区分冷却／进行中的操作；不能识别的冲突记录失败，不盲目 start。单台失败不阻断其余机器。
6. 请求按默认 50 个的预算分批，游标在每台处理前持久化，后续轮次继续。合并 Redis 请求，减少开销。
7. Cron 和手动操作共享每台机器的 Redis 互斥锁，避免互相覆盖；若锁被占用，本轮跳过或提示稍后重试。锁在完成后释放，异常中断最多 10 分钟后到期。

`fetch()` 处理页面与 API，`scheduled()` 负责定时任务。租约只解决空闲暂停；续期请求成功不代表绕过平台限制。

## 存储结构

| Key | 类型 | 内容 |
|---|---|---|
| `instabox:machines` | Hash | field 为 `账号ID:机器ID`，value 为 JSON：名称、保活开关、租约／冷却到期时间、上次执行结果 |
| `instabox:lock:<账号ID>:<机器ID>` | String | 操作锁的随机 token，最多保留 600 秒 |
| `instabox:scheduler-cursor` | String | 最近尝试处理的 `账号ID:机器ID`，让下轮从后面的机器继续 |
| `instabox:logs` | List | 保活与操作日志，`LPUSH` + `LTRIM` 保留最近 200 条 |

## 常见问题

**添加了第二账号 Key，却仍只有一台机器**

先确认已经部署支持编号 Secrets 的完整新版代码，再检查第二账号是否已有机器。Key 属于账号而不是单台机器；同账号新增机器只需刷新列表。

**账号 ID 或 API Key 重复**

检查旧 `INSTABOX_API_KEY`、编号 Secrets 和 `INSTABOX_ACCOUNTS` 是否同时包含同一 Key 或同一账号 ID。已有单账号升级时通常保留旧名与 `_2`，移除重复的 `_1`。不要为了修复重复错误删除 Redis 数据。

**InstaBox 报 Invalid redirect value，同时 Redis 连接失败**

这是旧修订使用 `redirect: "error"` 的 Workers 运行时兼容问题，请部署使用 `redirect: "manual"` 的修复版。此时请求在发出前就失败，不应先轮换 API Key 或 Redis Token。`manual` 不自动跟随 3xx；若修复后出现具体 HTTP 301/302，请核对配置的地址。

**Redis 连接失败 / HTTP 401、403 / 命令权限错误**

先按上条排除代码兼容错误，再核对 REST 根地址、同库 Token 和读写权限。HTTP 鉴权错误、DNS/超时与命令权限错误是不同故障；按实际提示排查。不要填 Redis TCP 地址，也不要把 `/pipeline` 写进根地址。

**定时任务没有生效**

确认 **Trigger Events → Cron Triggers** 已添加并保存。可在 Worker 的 **Logs** 中查看 `scheduled` 事件，成功时输出 `{"event":"keepalive_tick_ok",...}`。

**保活开关打开后状态没有更新**

检查 `UPSTASH_REDIS_REST_URL` 与 `UPSTASH_REDIS_REST_TOKEN` 是否正确。面板顶部会显示 Redis 读取失败的提示。

**机器仍然会暂停**

确认该机器的保活开关为开启状态，且日志页有持续的「自动保活」记录。若显示冷却期，等待截止时间后的下一轮检查；若出现 `HTTP 404 not_found`，检查机器是否已删除或 Key 是否仍有访问权限。不要为单台异常清空整个 Redis。

**能否直接把空闲暂停关掉**

取决于套餐和账号权限，免费套餐默认不能关闭。请以 InstaBox 官方规则为准；租约方案也不能解除运行时长或冷却限制。

**面板如何连接 InstaBox**

Cloudflare Worker 通过 HTTPS 调用官方控制 API，管理机器状态和活动租约；不会把 InstaBox 虚拟机用作流量转发节点。

## 本地验证

需要 Node.js 22 或更新版本，没有 npm 依赖要安装：

```bash
npm run check
npm test
```

测试使用模拟 InstaBox API 和 Redis，不连接实际账号，也不会启动、暂停或删除真实机器。GitHub Actions 对 PR 运行相同检查。界面仍内嵌在 `worker.js`，网页部署只需该文件，`package.json` 和测试不影响部署方式。

Node 测试不能代替 Workers 运行时验证。本次 redirect 修复还用真实 workerd 复现原错误，并验证了正常请求与 302 不跟随行为；后续修改 fetch/Request/Response 等平台接口时，应继续在 Wrangler dev 或 Miniflare 中用测试数据验证，再做实际部署验收。

## 可选：独立监控面板

CPU、内存、磁盘与网络速率可另行使用 [CF-Server-Monitor](https://github.com/huilang-me/CF-Server-Monitor)：Cloudflare 部署一套服务端，每台机器安装一个探针。它与本保活 Worker 是两个部署，不共用管理员密码、上报密钥或 Redis。

添加 InstaBox API Key 不会自动安装探针。新机器可用官方 `instabox create --setup-file … --wait-setup` 执行初始化脚本；探针原生上报地址须包含监控站点的 `/update` 路径。已有探针的快照克隆还需处理独立节点身份，不能直接共用原服务器 ID。

## 相关链接

**InstaBox**

- 官网 <https://instabox.sh>
- 控制台 <https://dashboard.instabox.sh/dashboard/machines> —— API Key 在 **Profile → API keys** 创建
- 文档 <https://instabox.sh/docs>
- API 地址 `https://api.instabox.sh`

**Upstash**

- 官网 <https://upstash.com> —— 支持 GitHub 账号直接登录
- 控制台 <https://console.upstash.com/redis> —— 创建 Redis 后在此复制 REST URL 与 REST Token
- Redis 文档 <https://upstash.com/docs/redis>

**Cloudflare**

- Dashboard <https://dash.cloudflare.com>
- Workers 文档 <https://developers.cloudflare.com/workers/>
- Cron 触发器 <https://developers.cloudflare.com/workers/configuration/cron-triggers/>

## 社区支持

学 AI , 上 L 站：[LinuxDO](https://linux.do)

## Star History

<a href="https://www.star-history.com/?repos=lizhenmiao%2Finstabox-keepalive&type=timeline&logscale=&legend=bottom-right">
 <picture>
   <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/chart?repos=lizhenmiao/instabox-keepalive&type=timeline&theme=dark&logscale&legend=bottom-right" />
   <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/chart?repos=lizhenmiao/instabox-keepalive&type=timeline&logscale&legend=bottom-right" />
   <img alt="Star History Chart" src="https://api.star-history.com/chart?repos=lizhenmiao/instabox-keepalive&type=timeline&logscale&legend=bottom-right" />
 </picture>
</a>

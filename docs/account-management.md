# 账号配置与加密接入

## 兼容性与身份

- 用途为开发、测试和 Agent 临时任务的机器管理。不部署或整合反向代理、通用流量转发、代理节点。Worker 只调用官方控制 API；如后续接入监控，Agent 单向上报指标，第三方主题资源代理不纳入整合。
- 临时任务按需保活，完成后关闭保活再暂停／停止或删除机器。网页终端支持手动交互命令，自动 Agent 任务调度仍由外部工具负责；CLI／其他控制台停机不会自动关闭本面板的保活开关。
- 继续用单文件 ES Module Worker 部署，不增加运行时依赖。
- 首次部署推荐每个账号一个 Secret：`INSTABOX_API_KEY_1`、`INSTABOX_API_KEY_2`，后缀作为稳定账号 ID；可选文本变量 `INSTABOX_ACCOUNT_NAME_1` 等设置名称。机器由各账号 API 自动发现，不逐台配置 ID。这些凭据仍由 Cloudflare Secrets 管理；新增网页接入采用独立的加密注册表，详见下节。
- 保留 `INSTABOX_API_KEY`（账号 ID `default`）及 `INSTABOX_ACCOUNTS` JSON 数组。三种形式可组合，ID 和 Key 必须唯一；轮换 Key 时保持 ID。JSON 迁移到单独 Secret 时保留同一后缀，例如 `id: second` 使用 `INSTABOX_API_KEY_second`。
- 各账号分别分页列举机器；单个账号失败不隐藏其他账号的机器。API Key 仅在添加表单中由管理员输入并提交，不回传、不持久化在浏览器、不写入日志或明文 Redis；后续使用仅在服务端解密。
- 机器操作路由为 `/api/accounts/{accountId}/machines/{machineId}/{action}`。旧 `/api/machines/{machineId}` 路由仅对应 `default`，不猜测账号。
- Redis hash 字段使用 `accountId:machineId`。旧 `m_...` 字段仅映射到 `default`，首次写入后迁移；如果已存在新字段，以新字段为准。移除账号后保留其配置，Cron 不会改用其他 Key。

## 网页接入 API 与存储

`GET /api/accounts` 返回 `{canAdd}`；`POST /api/accounts` 接受 `{apiKey,name?}`，需要面板密码和同源 Origin（存在时），请求体最多 2048 字节。校验 Key 格式、名称及现有注册表后，通过官方 `GET /v1/orgs` 识别唯一工作区，比较已有账号，完整分页读取机器。官方文档说明 API Key 只看到自己的 org；与当前登录用户身份无关，可接入同一用户的不同工作区。校验失败不保存，成功返回 201、账号 ID／名称和发现机器数，不返回 Key。

账号 ID 为 `web_` 加 org ID SHA-256 的前 24 位，稳定用于机器配置、终端和 Cron。相同 Key 或同一 org 的不同 Key 不能重复接入；已有 Secrets 账号保留 `default`／编号等原 ID。新账号校验前读取 Secrets 账号的 org；读取失败阻止添加，避免绕过重复判断。已保存网页账号直接使用已校验 org。Key 至少需读取机器权限，写权限留到实际操作验证。

可选 Secret `ACCOUNT_ENCRYPTION_KEY` 是随机 32 字节的十六进制表示，独立于管理员密码。Redis `instabox:accounts:v1` 为 Hash，字段为稳定账号 ID，值为 `{version:1,iv,ciphertext}`。AES-256-GCM 每次生成 12 字节随机 IV；AAD 绑定注册表名和账号 ID；名称、Key、org ID 一起加密。解密时同时验证 ID、org 哈希和字段格式，不能交换密文所属字段。Redis 中不保存主密钥。原子 Lua 同时检查字段不存在和条目数小于 32 后 HSET，防止并发重复与覆盖。

未配置主密钥的部署不读取注册表，保持原请求开销。启用后，机器、配额、终端、生命周期和 Cron 合并两类账号；损坏／冲突的记录不加载，其余有效记录继续工作，并向页面报告错误；任何注册表错误都会阻止新增写入。注册表整体故障仍保留静态 Secrets 账号。Cron 增加一次注册表读取，预算和容量估算相应扣除；保活开关、锁、冷却及游标机制复用原实现。

主密钥和 Redis 数据须配对备份。移除主密钥会停用整个网页注册表，更换主密钥会导致旧记录无法解密；本版本不提供密钥迁移或网页账号编辑／删除。旧 Secrets 仍可原地换值。部署不会复制、导出或改名现有 Secrets，也不迁移旧机器配置。

## 验证

`tests/accounts.test.mjs` 覆盖加密保存与加载、Secrets 兼容、同工作区去重、并发添加、错误与分页拒绝、损坏密文隔离、请求预算和新账号终端／Cron 路由。真实 workerd、临时 Redis 和浏览器集成检查包含实际 Lua 并发去重，InstaBox 上游响应使用模拟数据。界面约定见 [DESIGN.md](../DESIGN.md)，部署步骤见 [README.md](../README.md)。

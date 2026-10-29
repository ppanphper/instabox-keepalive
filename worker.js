/**
 * InstaBox 机器管理面板 —— Cloudflare Worker 单文件版
 *
 * 功能：
 *   1. 可视化管理多个账号的 InstaBox 机器（启动 / 暂停 / 唤醒 / 停止 / 删除）
 *   2. 每台机器可独立开关「自动保活」
 *   3. Cron 续期活动租约（3600 秒），尊重冷却期与机器运行限制
 *   4. 保活配置与最近 200 条日志存放在 Upstash Redis（REST 接口，纯 fetch 无依赖）
 *
 * 环境变量（在 Worker 设置中配置）：
 *   INSTABOX_API_KEY        InstaBox 的 API 密钥（ibk_ 开头）
 *   INSTABOX_API_KEY_1 / _2 / ... 每个账号一个 Secret，自动发现其全部机器
 *   INSTABOX_ACCOUNTS       可选 JSON 数组：[{ id, name, apiKey }]
 *   ACCOUNT_ENCRYPTION_KEY 可选 64 位十六进制 Secret，开启网页添加账号并加密存储 Key
 *   KEEPALIVE_INTERVAL_MINUTES 定时任务分钟步长，默认 15，须与 Cron 一致
 *   WORKER_SUBREQUEST_LIMIT 单次执行请求预算，默认 50（免费套餐）
 *   ADMIN_PASSWORD          面板登录密码
 *   UPSTASH_REDIS_REST_URL  Upstash Redis 的 REST 地址
 *   UPSTASH_REDIS_REST_TOKEN Upstash Redis 的 REST 令牌
 *
 * Cron 触发器建议每 15 分钟一次（租约 1 小时，容错充足）
 */

const API_ORIGIN = "https://api.instabox.sh";
const REDIS_PREFIX = "instabox";
const LEASE_ID = "keepalive";
const LEASE_TTL_SECONDS = 3600;      // 活动租约时长，接口上限即 3600
const LOG_KEEP = 200;                // Redis 中保留的日志条数
const REQUEST_TIMEOUT_MS = 55_000;   // 稍大于 wake/lease 接口的最长等待时间
const KEY_RE = /^ibk_[A-Za-z0-9_-]+$/;
const MACHINE_RE = /^m_[A-Za-z0-9_-]+$/;
const ACCOUNT_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const PENDING_STATES = new Set(["creating", "starting", "stopping", "suspending", "resuming", "deleting"]);
const REQUEST_CONTEXT = Symbol("requestContext");
const MACHINE_REQUEST_RESERVE = 11; // 含最多三次启动查询、409 重查、写回、解锁及异常日志
const CURSOR_KEY = REDIS_PREFIX + ":scheduler-cursor";
const MANAGED_ACCOUNTS_KEY = REDIS_PREFIX + ":accounts:v1";
const MAX_MANAGED_ACCOUNTS = 32;

function getAccounts(env, allowEmpty = false) {
  const accounts = [];
  if (env.INSTABOX_API_KEY) accounts.push({ id: "default", name: "默认账号", apiKey: env.INSTABOX_API_KEY });
  for (const variable of Object.keys(env).filter((key) => key.startsWith("INSTABOX_API_KEY_")).sort()) {
    const id = variable.slice("INSTABOX_API_KEY_".length);
    if (!ACCOUNT_RE.test(id)) throw new Error("账号 Secret 后缀须为 1–32 位小写字母、数字、下划线或连字符");
    accounts.push({ id, name: env["INSTABOX_ACCOUNT_NAME_" + id] || "账号 " + id, apiKey: env[variable] });
  }
  if (env.INSTABOX_ACCOUNTS) {
    let configured;
    try { configured = JSON.parse(env.INSTABOX_ACCOUNTS); }
    catch { throw new Error("INSTABOX_ACCOUNTS 必须是 JSON 数组"); }
    if (!Array.isArray(configured)) throw new Error("INSTABOX_ACCOUNTS 必须是 JSON 数组");
    accounts.push(...configured);
  }
  if (!accounts.length && !allowEmpty) throw new Error("请在 Cloudflare Secrets 添加 INSTABOX_API_KEY_1，每个账号填写一个 Key");
  const ids = new Set(), keys = new Set();
  return accounts.map((account, index) => {
    if (!account || typeof account.id !== "string" || !ACCOUNT_RE.test(account.id) || typeof account.apiKey !== "string" || !KEY_RE.test(account.apiKey)) {
      throw new Error("第 " + (index + 1) + " 个账号的 id 或 apiKey 无效");
    }
    if (ids.has(account.id) || keys.has(account.apiKey)) throw new Error("账号 ID 或 API Key 重复，请检查配置");
    if (account.name != null && (typeof account.name !== "string" || account.name.length > 80)) throw new Error("账号名称须为不超过 80 字的文本");
    ids.add(account.id); keys.add(account.apiKey);
    return { id: account.id, name: account.name || account.id, apiKey: account.apiKey };
  });
}

function accountRegistrationEnabled(env) {
  return typeof env.ACCOUNT_ENCRYPTION_KEY === "string" && /^[a-fA-F0-9]{64}$/.test(env.ACCOUNT_ENCRYPTION_KEY);
}

async function accountCryptoKey(env) {
  if (!accountRegistrationEnabled(env)) throw new Error("网页账号存储的加密配置无效");
  const bytes = Uint8Array.from(env.ACCOUNT_ENCRYPTION_KEY.match(/../g), (hex) => parseInt(hex, 16));
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]);
}

function encodeBytes(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))); }
function decodeBytes(value, maxLength) {
  if (typeof value !== "string" || value.length > maxLength || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new Error("无效密文");
  return Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
}

async function managedAccountId(orgId) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(orgId));
  return "web_" + Array.from(new Uint8Array(bytes), (b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

async function encryptAccount(key, account) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const aad = new TextEncoder().encode(MANAGED_ACCOUNTS_KEY + ":" + account.id);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: aad }, key, new TextEncoder().encode(JSON.stringify(account)));
  return JSON.stringify({ version: 1, iv: encodeBytes(iv), ciphertext: encodeBytes(ciphertext) });
}

async function decryptAccount(key, id, encoded) {
  if (!/^web_[a-f0-9]{24}$/.test(id) || typeof encoded !== "string" || encoded.length > 4096) throw new Error("无效账号记录");
  const envelope = JSON.parse(encoded);
  const iv = decodeBytes(envelope.iv, 24);
  if (envelope.version !== 1 || iv.byteLength !== 12) throw new Error("无效账号密文");
  const aad = new TextEncoder().encode(MANAGED_ACCOUNTS_KEY + ":" + id);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv, additionalData: aad }, key, decodeBytes(envelope.ciphertext, 4000));
  const account = JSON.parse(new TextDecoder().decode(plain));
  if (account.id !== id || !/^org_[A-Za-z0-9_-]+$/.test(account.orgId) || await managedAccountId(account.orgId) !== id ||
      typeof account.apiKey !== "string" || !KEY_RE.test(account.apiKey) || account.apiKey.length > 256 ||
      typeof account.name !== "string" || !account.name.trim() || account.name.length > 80) throw new Error("无效账号内容");
  return { id, name: account.name, apiKey: account.apiKey, orgId: account.orgId, source: "panel" };
}

/** 未开启网页存储时不增加 Redis 请求，兼容原 Secrets-only 部署和请求预算。 */
async function loadAccounts(env) {
  const accounts = getAccounts(env, !!env.ACCOUNT_ENCRYPTION_KEY).map((a) => ({ ...a, source: "secret" }));
  const errors = [];
  if (!env.ACCOUNT_ENCRYPTION_KEY) return { accounts, errors };
  let key, entries;
  try {
    key = await accountCryptoKey(env);
    const [raw] = await redis(env, [["HGETALL", MANAGED_ACCOUNTS_KEY]]);
    entries = Object.entries(toHash(raw));
    if (entries.length > MAX_MANAGED_ACCOUNTS) throw new Error("账号存储超出限制");
  } catch (_) {
    return { accounts, errors: [{ accountId: "panel", accountName: "网页账号", error: "无法读取网页账号，请检查 Redis 和加密主密钥；原 Secrets 账号继续可用" }] };
  }
  for (const [id, encoded] of entries) {
    try {
      const account = await decryptAccount(key, id, encoded);
      if (accounts.some((a) => a.id === id || a.apiKey === account.apiKey)) throw new Error("账号重复");
      accounts.push(account);
    } catch (_) {
      errors.push({ accountId: "panel", accountName: "网页账号", error: "一条账号记录无法解密或存在配置冲突，请检查主密钥和存储记录" });
    }
  }
  return { accounts, errors };
}

async function readAccountInput(request) {
  if (!(request.headers.get("Content-Type") || "").toLowerCase().startsWith("application/json")) return null;
  const reader = request.body?.getReader();
  if (!reader) return null;
  let size = 0, text = "";
  const decoder = new TextDecoder();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2048) { await reader.cancel(); return null; }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } catch (_) { return null; }
  finally { reader.releaseLock(); }
}

async function accountOrg(env, account) {
  const r = await ib(env, account, "GET", "/v1/orgs");
  if (!r.ok) return { error: failure(r, "校验账号失败").detail };
  const orgs = r.data?.orgs;
  if (!Array.isArray(orgs) || orgs.length !== 1 || !/^org_[A-Za-z0-9_-]+$/.test(orgs[0]?.id)) {
    return { error: "无法确认 Key 所属的唯一工作区，请使用该账号或工作区自己的 API Key" };
  }
  return { id: orgs[0].id, name: orgs[0].name };
}

async function registerAccount(request, env) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return json({ error: "请从本面板添加账号" }, 403);
  if (!accountRegistrationEnabled(env)) return json({ error: "网页添加账号尚未启用，请先配置 ACCOUNT_ENCRYPTION_KEY" }, 503);
  const input = await readAccountInput(request);
  if (!input || typeof input !== "object" || Array.isArray(input) || typeof input.apiKey !== "string" ||
      (input.name !== undefined && typeof input.name !== "string")) return json({ error: "请填写有效的 API Key 和账号名称" }, 400);
  const apiKey = input.apiKey.trim(), name = (input.name || "").trim();
  if (!KEY_RE.test(apiKey) || apiKey.length > 256) return json({ error: "API Key 格式不正确，应以 ibk_ 开头" }, 400);
  if (name.length > 80 || /[\u0000-\u001f\u007f]/.test(name)) return json({ error: "账号名称须为不超过 80 字的普通文本" }, 400);
  const { accounts, errors } = await loadAccounts(env);
  if (errors.length) return json({ error: "账号存储暂不可用，未保存新账号；请先处理页面上的网页账号错误" }, 503);
  if (accounts.some((a) => a.apiKey === apiKey)) return json({ error: "这个 Key 已接入，请直接刷新机器列表" }, 409);
  const candidate = { apiKey };
  const org = await accountOrg(env, candidate);
  if (org.error) return json({ error: org.error }, 422);
  for (const account of accounts) {
    const existing = account.orgId ? { id: account.orgId } : await accountOrg(env, account);
    if (existing.error) return json({ error: "无法校验已有账号「" + account.name + "」的归属，请先修复它的 Key 后重试" }, 503);
    if (existing.id === org.id) return json({ error: "该账号已接入为「" + account.name + "」，无需重复添加；更换 Key 请保留原账号身份" }, 409);
  }
  const machines = await listMachines(env, candidate);
  if (machines.error) return json({ error: "未保存：" + machines.error }, 422);
  if (machines.machines.some((m) => m.orgId && m.orgId !== org.id)) return json({ error: "机器列表与账号归属不一致，未保存" }, 422);
  const id = await managedAccountId(org.id);
  if (accounts.some((a) => a.id === id)) return json({ error: "账号标识与现有配置冲突，未保存" }, 409);
  const suggestedName = typeof org.name === "string" ? org.name.replace(/[\u0000-\u001f\u007f]/g, "").trim() : "";
  const displayName = safeMessage(name || suggestedName || "账号 " + id.slice(-6)).slice(0, 80);
  const record = { id, name: displayName, apiKey, orgId: org.id };
  const ciphertext = await encryptAccount(await accountCryptoKey(env), record);
  // 同一工作区固定 ID；原子地拒绝并发重复提交，绝不覆盖现有 Key。
  const script = "if redis.call('HEXISTS',KEYS[1],ARGV[1]) == 1 then return 0 end; if redis.call('HLEN',KEYS[1]) >= tonumber(ARGV[3]) then return -1 end; redis.call('HSET',KEYS[1],ARGV[1],ARGV[2]); return 1";
  let saved;
  try { [saved] = await redis(env, [["EVAL", script, "1", MANAGED_ACCOUNTS_KEY, id, ciphertext, String(MAX_MANAGED_ACCOUNTS)]]); }
  catch (_) { return json({ error: "未能确认账号是否保存，请刷新面板后重试；重复提交不会覆盖已有账号" }, 503); }
  if (saved === 0) return json({ error: "该账号已添加，请刷新机器列表" }, 409);
  if (saved === -1) return json({ error: "网页账号已达 32 个，请整理已有账号或拆分面板" }, 409);
  if (saved !== 1) return json({ error: "账号存储返回异常，请刷新后检查" }, 503);
  return json({ ok: true, account: { id, name: displayName }, machineCount: machines.machines.length }, 201);
}

function intervalMinutes(env) {
  const value = Number(env.KEEPALIVE_INTERVAL_MINUTES || 15);
  if (!Number.isInteger(value) || value < 1 || value > 30) throw new Error("KEEPALIVE_INTERVAL_MINUTES 须为 1–30 的整数");
  return value;
}

function subrequestLimit(env) {
  const value = Number(env.WORKER_SUBREQUEST_LIMIT || 50);
  if (!Number.isInteger(value) || value < 20 || value > 10000) throw new Error("WORKER_SUBREQUEST_LIMIT 须为 20–10000 的整数，并且不超过套餐额度");
  return value;
}

function scopedEnv(env, scheduled = false) {
  return { ...env, [REQUEST_CONTEXT]: { used: 0, limit: subrequestLimit(env), deadline: scheduled ? Date.now() + 13 * 60000 : Infinity } };
}

async function budgetFetch(env, url, options) {
  const context = env[REQUEST_CONTEXT];
  if (context) {
    if (context.used >= context.limit) throw new Error("已达到本次请求预算，请减少账号／分页数量或使用更高额度的 Worker");
    if (Date.now() >= context.deadline) throw new Error("本轮执行时间已用尽，将在下轮继续");
    context.used++;
  }
  const timeout = Math.max(1, Math.min(REQUEST_TIMEOUT_MS, (context?.deadline ?? Infinity) - Date.now()));
  // Workers 仅支持 follow/manual；将 3xx 交给调用方按非成功状态处理，避免额外请求或转发凭据。
  return fetch(url, { ...options, redirect: "manual", signal: AbortSignal.timeout(timeout) });
}

function configKey(accountId, machineId) { return accountId + ":" + machineId; }

function safeMessage(value) { return String(value || "").replace(/ibk_[A-Za-z0-9_-]+/g, "[已隐藏密钥]"); }

// ---------- Upstash Redis（REST，pipeline 方式统一收发） ----------

/** 执行一组 Redis 命令，返回每条命令的结果数组；失败时整批抛错（带底层原因） */
async function redis(env, commands) {
  let res;
  try {
    res = await budgetFetch(env, env.UPSTASH_REDIS_REST_URL + "/pipeline", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + env.UPSTASH_REDIS_REST_TOKEN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(commands),
    });
  } catch (e) {
    const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
    const cause = (e && (e.cause?.code || e.code)) || "";
    throw new Error((timedOut ? "Redis 请求超时" : "Redis 连接失败") + (cause ? "（" + cause + "）" : ""));
  }
  if (!res.ok) throw new Error("Redis HTTP " + res.status);
  const data = await res.json().catch(() => { throw new Error("Redis 返回了无法解析的内容"); });
  for (const item of data) {
    if (item.error) throw new Error("Redis: " + item.error);
  }
  return data.map((item) => item.result);
}

/**
 * 把 HGETALL 的结果统一成 { field: value }。
 * Upstash 的 /pipeline 接口可能返回扁平数组 [f1,v1,f2,v2,...]，也可能返回对象，
 * 两种都要兼容，否则 key 会退化成数组下标。
 */
function toHash(raw) {
  const out = {};
  if (!raw) return out;
  if (Array.isArray(raw)) {
    for (let i = 0; i + 1 < raw.length; i += 2) out[raw[i]] = raw[i + 1];
    return out;
  }
  if (typeof raw === "object") {
    for (const [k, v] of Object.entries(raw)) out[k] = v;
  }
  return out;
}

/** 旧 machineId 字段只归属 default；新 accountId:machineId 字段优先。 */
async function loadConfigs(env) {
  const [raw] = await redis(env, [["HGETALL", REDIS_PREFIX + ":machines"]]);
  return parseConfigs(raw);
}

function parseConfig(raw) {
  try {
    const config = JSON.parse(raw);
    return config && typeof config === "object" && !Array.isArray(config) ? config : null;
  } catch { return null; }
}

function parseConfigs(raw) {
  const out = {};
  const entries = Object.entries(toHash(raw));
  for (const [id, value] of entries.sort(([a], [b]) => Number(a.includes(":")) - Number(b.includes(":")))) {
    const key = MACHINE_RE.test(id) ? configKey("default", id) : id;
    const [accountId, machineId, extra] = key.split(":");
    if (extra !== undefined || !ACCOUNT_RE.test(accountId) || !MACHINE_RE.test(machineId)) continue;
    const config = parseConfig(value);
    if (config) out[key] = config;
  }
  return out;
}

/** 写入单台机器的保活配置 */
function configCommands(accountId, machineId, config) {
  const commands = [["HSET", REDIS_PREFIX + ":machines", configKey(accountId, machineId), JSON.stringify(config)]];
  if (accountId === "default") commands.push(["HDEL", REDIS_PREFIX + ":machines", machineId]);
  return commands;
}

function saveConfig(env, accountId, machineId, config) {
  return redis(env, configCommands(accountId, machineId, config));
}

/** 删除某台机器的保活配置（机器被删除时调用） */
function dropConfig(env, accountId, machineId) {
  const fields = [configKey(accountId, machineId)];
  if (accountId === "default") fields.push(machineId);
  return redis(env, [["HDEL", REDIS_PREFIX + ":machines", ...fields]]);
}

/** Cron 与手动操作共享每台机器的锁；故障时自动过期，释放时校验归属。 */
async function withMachineLock(env, key, action, advanceCursor = false) {
  const lockKey = REDIS_PREFIX + ":lock:" + key;
  const token = crypto.randomUUID();
  const [accountId, machineId] = key.split(":");
  const commands = [["SET", lockKey, token, "NX", "EX", "600"], ["HGET", REDIS_PREFIX + ":machines", key]];
  if (accountId === "default") commands.push(["HGET", REDIS_PREFIX + ":machines", machineId]);
  // 在处理前推进游标；即使本轮超时或写回失败，后面的机器也不会一直饿死。
  if (advanceCursor) commands.push(["SET", CURSOR_KEY, key]);
  const [acquired, current, legacy] = await redis(env, commands);
  if (acquired !== "OK") return { locked: true };
  const config = parseConfig(current) || (accountId === "default" ? parseConfig(legacy) : null);
  try { return await action(config); }
  finally {
    await redis(env, [["EVAL", "if redis.call('GET',KEYS[1]) == ARGV[1] then return redis.call('DEL',KEYS[1]) else return 0 end", "1", lockKey, token]])
      .catch(() => console.warn("机器操作锁释放失败，将在到期后自动释放"));
  }
}

/** 追加一条日志并裁剪到最近 LOG_KEEP 条 */
function logCommands(entry) {
  return [
    ["LPUSH", REDIS_PREFIX + ":logs", JSON.stringify(entry)],
    ["LTRIM", REDIS_PREFIX + ":logs", "0", String(LOG_KEEP - 1)],
  ];
}

function addLog(env, entry) {
  return redis(env, logCommands(entry));
}

// ---------- InstaBox API ----------

/** 调用 InstaBox API；返回 { ok, status, data }，错误体自动解析出 code/message */
async function ib(env, account, method, path, body, idempotencyKey) {
  const headers = { "X-API-Key": account.apiKey, Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
  try {
    const res = await budgetFetch(env, (env.INSTABOX_API_ORIGIN || API_ORIGIN) + path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    return {
      ok: res.ok,
      status: res.status,
      data,
      code: data?.error?.code || null,
      message: safeMessage(data?.error?.message) || null,
    };
  } catch (e) {
    // 区分超时与连接失败，并带上底层错误码（如 ENOTFOUND=域名解析失败、ECONNRESET=连接被重置）
    const timedOut = e && (e.name === "TimeoutError" || e.name === "AbortError");
    const cause = (e && (e.cause?.code || e.code)) || "";
    const message = timedOut ? "请求超时" : safeMessage(e?.message || "网络错误");
    return { ok: false, status: 0, data: null, code: "network", message: cause ? message + "（" + cause + "）" : message };
  }
}

function failure(result, prefix) {
  return { state: "failed", detail: prefix + "：" + (result.status ? "HTTP " + result.status : "网络错误") +
    (result.code ? " " + safeMessage(result.code) : "") + (result.message ? " · " + result.message : "") };
}

function machineGuard(machine) {
  if (machine.cooldownUntil) {
    const until = Date.parse(machine.cooldownUntil);
    if (!Number.isFinite(until)) return { state: "failed", detail: "冷却截止时间无效，本轮未操作" };
    if (until > Date.now()) return { state: "cooldown", detail: "冷却至 " + machine.cooldownUntil, cooldownUntil: machine.cooldownUntil };
  }
  if (PENDING_STATES.has(machine.state) || machine.operationId) return { state: "waiting", detail: "机器正在执行操作，等待下一轮确认" };
  return null;
}

async function readMachine(env, account, machineId) {
  const r = await ib(env, account, "GET", "/v1/machines/" + machineId);
  if (!r.ok) return { error: failure(r, "读取机器状态失败") };
  if (r.data?.id !== machineId || typeof r.data?.state !== "string") return { error: { state: "failed", detail: "机器状态响应无效，本轮未操作" } };
  return { machine: r.data };
}

/** 冲突可能来自冷却或其他操作，重查状态，不把所有 409 都当作停止。 */
async function conflictResult(env, account, machineId, response, prefix) {
  if (response.status === 409) {
    const fresh = await readMachine(env, account, machineId);
    if (fresh.machine) {
      const guarded = machineGuard(fresh.machine);
      if (guarded) return guarded;
    }
  }
  return failure(response, prefix);
}

async function renewLease(env, account, machineId) {
  const initial = await readMachine(env, account, machineId);
  if (initial.error) return initial.error;
  const guarded = machineGuard(initial.machine);
  if (guarded) return guarded;
  let machine = initial.machine;
  if (machine.state === "stopped" || machine.state === "suspended") {
    const action = machine.state === "stopped" ? "start" : "resume";
    const started = await ib(env, account, "POST", "/v1/machines/" + machineId + "/" + action, undefined, crypto.randomUUID());
    if (!started.ok) return conflictResult(env, account, machineId, started, "恢复机器失败");
    // 有限轮询：受理不等于运行，也不等于续租成功。未就绪时留给下一轮。
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((resolve) => setTimeout(resolve, 2000));
      const fresh = await readMachine(env, account, machineId);
      if (fresh.error) return fresh.error;
      machine = fresh.machine;
      const state = machineGuard(machine);
      if (state && state.state !== "waiting") return state;
      if (machine.state === "running" && !state) break;
      if (attempt === 2) return { state: "waiting", detail: "恢复指令已受理，尚未确认运行；下轮重试" };
    }
  }
  if (machine.state !== "running") return { state: "failed", detail: "机器状态为 " + machine.state + "，未自动启动" };
  const r = await ib(env, account, "PUT", "/v1/machines/" + machineId + "/activity-leases/" + LEASE_ID, { ttlSeconds: LEASE_TTL_SECONDS });
  if (!r.ok) return conflictResult(env, account, machineId, r, "续租失败");
  if (r.data?.machineId !== machineId || !(Date.parse(r.data?.expiresAt) > Date.now())) {
    return { state: "failed", detail: "接口返回的租约信息异常" };
  }
  return { state: "ok", detail: "租约至 " + r.data.expiresAt, expiresAt: r.data.expiresAt };
}

async function keepAliveOnce(env, account, machineId, config, action) {
  const result = await renewLease(env, account, machineId);
  const now = new Date().toISOString();
  const updated = {
    ...config, lastStatus: result.state, lastDetail: result.detail,
    // 一次失败不抹掉仍有效的旧租约；机器冷却／等待恢复时不再声称持有租约。
    leaseExpiresAt: result.expiresAt || (result.state === "failed" ? config.leaseExpiresAt || null : null),
    cooldownUntil: result.cooldownUntil || null, lastAt: now,
  };
  const entry = { t: now, accountId: account.id, accountName: account.name, machineId,
    name: config.name || machineId, action, ok: result.state !== "failed", detail: result.detail };
  await redis(env, [...configCommands(account.id, machineId, updated), ...logCommands(entry)]);
  return result;
}

/** 分页失败时保留已取得的机器，同时给界面明确提示；检测重复 cursor。 */
async function listMachines(env, account) {
  const machines = new Map(), cursors = new Set();
  let cursor = null;
  do {
    const path = "/v1/machines" + (cursor ? "?cursor=" + encodeURIComponent(cursor) : "");
    const r = await ib(env, account, "GET", path);
    if (!r.ok || !Array.isArray(r.data?.machines)) return { machines: [...machines.values()], error: failure(r, "获取机器列表失败").detail };
    for (const machine of r.data.machines) if (machine && MACHINE_RE.test(machine.id)) machines.set(machine.id, machine);
    cursor = r.data.nextCursor;
    if (cursor && (typeof cursor !== "string" || cursors.has(cursor))) return { machines: [...machines.values()], error: "机器列表分页游标无效或重复" };
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return { machines: [...machines.values()], error: null };
}

// ---------- 鉴权与路由 ----------

/** 校验面板密码：所有 /api 请求都必须带 X-Panel-Auth 头 */
function authorized(request, env) {
  const provided = request.headers.get("X-Panel-Auth") || "";
  const expected = env.ADMIN_PASSWORD || "";
  return expected.length > 0 && provided.length === expected.length && timingSafeEqual(provided, expected);
}

/** 恒时字符串比较，避免时序侧信道 */
function timingSafeEqual(a, b) {
  let diff = 0;
  for (let i = 0; i < b.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/** 仅申请所选机器的官方终端票据；浏览器永远不接收账号 API Key。 */
async function terminalAccess(request, env, account, machineId) {
  const origin = request.headers.get("Origin");
  if (origin && origin !== new URL(request.url).origin) return json({ error: "请从本面板打开终端" }, 403);
  const current = await ib(env, account, "GET", "/v1/machines/" + machineId);
  if (!current.ok) return json({ error: failure(current, "读取终端机器失败").detail }, current.status === 404 ? 404 : current.status === 403 ? 403 : 502);
  if (current.data?.id !== machineId) return json({ error: "机器状态响应无效" }, 502);
  const guard = machineGuard(current.data);
  if (guard) return json({ error: guard.detail, cooldownUntil: guard.cooldownUntil || null }, 409);
  if (current.data.state !== "running" || current.data.runtime?.ready === false) {
    return json({ error: "机器尚未运行就绪，请先启动或唤醒后重试" }, 409);
  }
  const access = await ib(env, account, "POST", "/v1/machines/" + machineId + "/access", { kind: "terminal", requireTicket: true });
  if (!access.ok) return json({ error: failure(access, "申请终端会话失败").detail }, access.status === 403 ? 403 : access.status === 409 ? 409 : 502);
  const data = access.data;
  let target;
  try { target = new URL(data?.url); } catch { return json({ error: "官方终端返回了无效连接地址" }, 502); }
  // 只接受官方服务地址，不允许把凭据带到第三方或降级为明文 WebSocket。
  if (target.protocol !== "wss:" || !(target.hostname === "instabox.sh" || target.hostname.endsWith(".instabox.sh")) ||
      target.username || target.password || target.port || target.search || target.hash ||
      target.pathname !== "/v1/machines/" + machineId + "/terminal") {
    return json({ error: "官方终端连接地址不受支持" }, 502);
  }
  if (typeof data.token !== "string" || !/^[A-Za-z0-9._~-]{8,4096}$/.test(data.token) || data.token.startsWith("ibk_") ||
      (data.protocol && data.protocol !== "instabox-access.v1")) {
    return json({ error: "官方未返回可用的浏览器终端票据，请检查 API 权限或服务端版本" }, 502);
  }
  return json({ url: target.href, token: data.token, protocol: "instabox-access.v1" });
}

/** 处理面板的全部 API 请求 */
async function handleApi(request, env, url) {
  if (!authorized(request, env)) return json({ error: "未登录或密码错误" }, 401);
  const path = url.pathname.replace(/^\/api/, "");
  const method = request.method;
  if (path === "/auth" && method === "POST") return json({ ok: true });
  if (path === "/accounts") {
    if (method === "GET") return json({ canAdd: accountRegistrationEnabled(env) });
    if (method === "POST") return registerAccount(request, env);
    return json({ error: "账号接口仅支持读取能力或添加账号" }, 405);
  }

  if (path === "/logs" && method === "GET") {
    const [logs] = await redis(env, [["LRANGE", REDIS_PREFIX + ":logs", "0", "49"]]);
    return json({ logs: (logs || []).map((s) => { try { return JSON.parse(s); } catch { return null; } }).filter(Boolean) });
  }
  if (path === "/logs" && method === "DELETE") {
    await redis(env, [["DEL", REDIS_PREFIX + ":logs"]]);
    return json({ ok: true });
  }

  const { accounts, errors: registryErrors } = await loadAccounts(env);
  const terminal = path.match(/^\/accounts\/([a-z0-9][a-z0-9_-]{0,31})\/machines\/(m_[A-Za-z0-9_-]+)\/terminal$/);
  if (terminal) {
    if (method !== "POST") return json({ error: "终端会话须使用 POST 创建" }, 405);
    const account = accounts.find((a) => a.id === terminal[1]);
    if (!account) return json({ error: "账号未配置" }, 404);
    return terminalAccess(request, env, account, terminal[2]);
  }
  if (path === "/machines" && method === "GET") {
    let configs = {}, configError = null;
    try { configs = await loadConfigs(env); }
    catch (e) { configError = safeMessage(e.message); }
    const lists = await Promise.all(accounts.map((account) => listMachines(env, account)));
    const accountErrors = [...registryErrors];
    const machines = accounts.flatMap((account, index) => {
      const list = lists[index];
      if (list.error) accountErrors.push({ accountId: account.id, accountName: account.name, error: list.error });
      return list.machines.map((m) => ({
        id: m.id, key: configKey(account.id, m.id), accountId: account.id, accountName: account.name,
        name: m.name, state: m.state, spec: m.spec, template: m.template?.id || null,
        guestUser: m.guestUser || null, autoSuspendAfterSeconds: m.autoSuspendAfterSeconds ?? null,
        cooldownUntil: m.cooldownUntil || null, operationId: m.operationId || null,
        keepalive: configs[configKey(account.id, m.id)] || null,
      }));
    });
    const enabled = Object.entries(configs).filter(([key, config]) => config.keepalive === "on" && accounts.some((account) => key.startsWith(account.id + ":"))).length;
    const conservativeBatchSize = Math.floor((subrequestLimit(env) - (env.ACCOUNT_ENCRYPTION_KEY ? 2 : 1)) / MACHINE_REQUEST_RESERVE);
    const estimatedCycleMinutes = Math.ceil(enabled / conservativeBatchSize) * intervalMinutes(env);
    const capacityWarning = estimatedCycleMinutes > 45
      ? "已开启 " + enabled + " 台保活，按当前间隔分批检查可能需要 " + estimatedCycleMinutes + " 分钟；建议缩短 Cron 间隔或拆分面板，为 1 小时租约留出重试时间。" : null;
    return json({ machines, configError, accountErrors, accountCount: accounts.length, intervalMinutes: intervalMinutes(env),
      capacity: { enabled, conservativeBatchSize, estimatedCycleMinutes, warning: capacityWarning } });
  }

  if (path === "/usage" && method === "GET") {
    const results = await Promise.all(accounts.map((account) => ib(env, account, "GET", "/v1/usage")));
    const usage = {}, accountErrors = [...registryErrors];
    results.forEach((r, index) => {
      if (!r.ok || !r.data) { accountErrors.push({ accountName: accounts[index].name, error: failure(r, "读取配额失败").detail }); return; }
      for (const key of ["machines", "snapshots", "storageGiB"]) {
        if (typeof r.data[key] === "number") usage[key] = (usage[key] || 0) + r.data[key];
      }
    });
    return json({ usage, accountErrors });
  }

  // 兼容旧单账号接口；多账号接口显式携带账号 ID，不能回退到别的 Key。
  const match = path.match(/^\/(?:accounts\/([^/]+)\/)?machines\/([^/]+)(?:\/(start|stop|suspend|resume|keepalive))?$/);
  if (!match) return json({ error: "接口不存在" }, 404);
  const [, requestedAccount, machineId, action] = match;
  const account = accounts.find((a) => a.id === (requestedAccount || "default"));
  if (!account) return json({ error: "账号未配置" }, 404);
  if (!MACHINE_RE.test(machineId)) return json({ error: "机器 ID 不合法" }, 400);
  if (!((method === "POST" && action) || (method === "DELETE" && !action))) return json({ error: "接口不存在" }, 404);
  const input = method === "POST" ? await request.json().catch(() => ({})) : {};
  if (action === "keepalive" && typeof input?.enable !== "boolean") return json({ error: "enable 必须是布尔值" }, 400);
  const name = typeof input?.name === "string" && input.name ? input.name : machineId;
  const key = configKey(account.id, machineId);
  const result = await withMachineLock(env, key, async (latest) => {
    const config = latest || {};
    const log = (label, ok, detail) => addLog(env, {
      t: new Date().toISOString(), accountId: account.id, accountName: account.name,
      machineId, name, action: label, ok, detail,
    });

    if (action === "keepalive") {
      const updated = { ...config, name, keepalive: input.enable ? "on" : "off" };
      if (input.enable) {
        // 先保存开关，首次状态查询或续租失败时下一轮仍可重试。
        await saveConfig(env, account.id, machineId, updated);
        const renewed = await keepAliveOnce(env, account, machineId, updated, "保活");
        return json({ ok: true, detail: renewed.detail, warning: renewed.state === "failed" ? "保活已开启，但本次失败：" + renewed.detail : null });
      }
      await saveConfig(env, account.id, machineId, { ...updated, lastDetail: "保活已手动关闭", lastAt: new Date().toISOString() });
      await log("保活", true, "保活已关闭");
      return json({ ok: true });
    }

    const labels = { start: "启动", stop: "停止", suspend: "暂停", resume: "唤醒" };
    if (action === "start" || action === "resume") {
      const current = await readMachine(env, account, machineId);
      if (current.error) return json({ error: current.error.detail }, 502);
      const guard = machineGuard(current.machine);
      if (guard) return json({ error: guard.detail, cooldownUntil: guard.cooldownUntil || null }, 409);
    }

    // 在发出停止/暂停/删除前写入 off，持久化失败时不执行外部操作。
    const disables = !action || action === "stop" || action === "suspend";
    if (disables && config.keepalive === "on") {
      await saveConfig(env, account.id, machineId, { ...config, keepalive: "off", lastDetail: "手动操作，保活已关闭" });
    }
    const endpoint = "/v1/machines/" + machineId + (action ? "/" + action : "");
    const r = await ib(env, account, action ? "POST" : "DELETE", endpoint, undefined, action ? crypto.randomUUID() : undefined);
    const label = action ? labels[action] : "删除";
    if (!r.ok) {
      // 网络超时可能已被服务端受理，保持 off，避免下轮又启动机器。
      const detail = failure(r, label + "失败").detail + (disables && config.keepalive === "on" ? "；保活已关闭，请核对机器状态" : "");
      await log(label, false, detail).catch(() => {});
      return json({ error: detail }, 502);
    }
    if (!action) await dropConfig(env, account.id, machineId);
    await log(label, true, "指令已下发（" + (action || "delete") + "）").catch(() => {});
    return json({ ok: true, operationId: r.data?.operationId || r.data?.id || null }, 202);
  });
  return result.locked ? json({ error: "该机器正在执行其他操作，请稍后重试" }, 409) : result;
}

// ---------- Cron 保活任务 ----------

async function runKeepaliveTick(env) {
  const loaded = await loadAccounts(env);
  const accounts = new Map(loaded.accounts.map((account) => [account.id, account]));
  if (loaded.errors.length) console.warn("网页账号加载异常，跳过不可用账号；原 Secrets 账号继续处理");
  if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) throw new Error("未配置 Upstash Redis");
  const [raw, cursor] = await redis(env, [["HGETALL", REDIS_PREFIX + ":machines"], ["GET", CURSOR_KEY]]);
  const configs = parseConfigs(raw);
  const enabled = Object.entries(configs).filter(([, c]) => c.keepalive === "on");
  const targets = enabled.filter(([key]) => accounts.has(key.split(":")[0])).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  const start = targets.findIndex(([key]) => !cursor || key > cursor);
  const ordered = start > 0 ? [...targets.slice(start), ...targets.slice(0, start)] : targets;
  const counts = { renewed: 0, cooldown: 0, waiting: 0, skipped: enabled.length - targets.length,
    failed: 0, total: enabled.length, processed: 0, deferred: 0 };
  const context = env[REQUEST_CONTEXT];
  for (const [key] of ordered) {
    // 为一台机器的最坏请求路径预留额度；剩余任务由持久化游标交给下一轮。
    if (context.used + MACHINE_REQUEST_RESERVE > context.limit ||
        context.deadline - Date.now() < MACHINE_REQUEST_RESERVE * REQUEST_TIMEOUT_MS + 5000) break;
    const [accountId, machineId] = key.split(":");
    const account = accounts.get(accountId);
    counts.processed++;
    try {
      const result = await withMachineLock(env, key, async (latest) => {
        if (!latest || latest.keepalive !== "on") return { state: "skipped" };
        return keepAliveOnce(env, account, machineId, latest, "自动保活");
      }, true);
      if (result.locked || result.state === "skipped") counts.skipped++;
      else if (result.state === "ok") counts.renewed++;
      else if (result.state === "cooldown") counts.cooldown++;
      else if (result.state === "waiting") counts.waiting++;
      else counts.failed++;
    } catch (e) {
      counts.failed++;
      await addLog(env, { t: new Date().toISOString(), accountId, accountName: account.name,
        machineId, name: configs[key].name || machineId, action: "自动保活", ok: false, detail: safeMessage(e.message) }).catch(() => {});
    }
  }
  counts.deferred = targets.length - counts.processed;
  return { ...counts, requests: context.used };
}

// ---------- Worker 入口 ----------

export default {
  async fetch(request, env) {
    // 兜底：任何未预期的异常都以 JSON 返回，避免裸 500 页面
    try {
      const url = new URL(request.url);
      if (url.pathname.startsWith("/api")) return await handleApi(request, scopedEnv(env), url);
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return new Response(renderPage(), { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" } });
      }
      return new Response("Not found", { status: 404 });
    } catch (e) {
      return json({ error: "服务器内部错误：" + safeMessage((e && e.message) || e) }, 500);
    }
  },

  async scheduled(controller, env, ctx) {
    try {
      const expectedCron = "*/" + intervalMinutes(env) + " * * * *";
      if (controller.cron && controller.cron !== expectedCron) console.warn("Cron 与 KEEPALIVE_INTERVAL_MINUTES 不一致，页面预计时间可能不准确");
      const result = await runKeepaliveTick(scopedEnv(env, true));
      console.log(JSON.stringify({ event: "keepalive_tick_ok", ...result }));
    } catch (error) {
      console.error(JSON.stringify({ event: "keepalive_tick_failed", message: safeMessage(error.message) }));
    }
  },
};

// ---------- 前端面板（单页 HTML，内嵌样式与脚本） ----------

function renderPage() {
  return String.raw`<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>InstaBox 控制台</title>
<style>
  :root {
    --bg: #f5f5f7;
    --card: #ffffff;
    --text: #1d1d1f;
    --muted: #86868b;
    --line: #e8e8ed;
    --blue: #0071e3;
    --green: #34c759;
    --orange: #ff9500;
    --red: #ff3b30;
    --gray: #8e8e93;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; -webkit-font-smoothing: antialiased; }
  body {
    background: var(--bg);
    color: var(--text);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", "PingFang SC", "Microsoft YaHei", sans-serif;
    font-size: 15px;
    line-height: 1.5;
    min-height: 100vh;
  }
  h1, h2 { font-weight: 600; letter-spacing: -0.01em; }

  /* ---------- 登录 ---------- */
  .login-wrap { display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; }
  .login-card {
    width: 100%; max-width: 360px; background: var(--card); border-radius: 22px;
    padding: 36px 32px; text-align: center;
    box-shadow: 0 2px 8px rgba(0,0,0,.04), 0 20px 50px rgba(0,0,0,.08);
  }
  .logo {
    width: 56px; height: 56px; margin: 0 auto 18px; border-radius: 16px;
    background: linear-gradient(160deg, #0a84ff, #0055c4);
    display: flex; align-items: center; justify-content: center;
    color: #fff; font-size: 22px; font-weight: 700; letter-spacing: -0.5px;
    box-shadow: 0 6px 18px rgba(0,113,227,.3);
  }
  .login-card h1 { font-size: 24px; margin-bottom: 4px; }
  .login-card .sub { color: var(--muted); font-size: 13px; margin-bottom: 26px; }
  .field {
    width: 100%; font: inherit; font-size: 15px; color: var(--text);
    background: rgba(120,120,128,.08); border: 1px solid transparent;
    border-radius: 12px; padding: 12px 14px; outline: none;
    transition: border-color .2s, background .2s;
  }
  .field:focus { background: #fff; border-color: var(--blue); }
  .field::placeholder { color: var(--muted); }

  /* ---------- 按钮 ---------- */
  .btn {
    font: inherit; font-size: 13px; font-weight: 500; letter-spacing: 0;
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    min-height: 32px; padding: 7px 16px; border: none; border-radius: 980px;
    background: rgba(0,0,0,.05); color: var(--text); cursor: pointer;
    transition: background .2s ease, transform .1s ease, opacity .2s ease;
    white-space: nowrap; user-select: none;
  }
  .btn:hover:not(:disabled) { background: rgba(0,0,0,.08); }
  .btn:active:not(:disabled) { transform: scale(.97); }
  .btn:disabled { opacity: .45; cursor: default; }
  .btn.primary { background: var(--blue); color: #fff; }
  .btn.primary:hover:not(:disabled) { background: #0077ed; }
  .btn.danger { color: var(--red); background: rgba(255,59,48,.07); }
  .btn.danger:hover:not(:disabled) { background: rgba(255,59,48,.12); }
  .btn.block { width: 100%; min-height: 44px; font-size: 15px; margin-top: 16px; }

  .spinner {
    width: 13px; height: 13px; border-radius: 50%;
    border: 2px solid currentColor; border-top-color: transparent;
    animation: spin .7s linear infinite; display: inline-block;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  /* ---------- 顶栏 ---------- */
  .topbar {
    position: sticky; top: 0; z-index: 5;
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    padding: 12px 24px; flex-wrap: wrap;
    background: rgba(245,245,247,.75);
    backdrop-filter: saturate(180%) blur(20px);
    -webkit-backdrop-filter: saturate(180%) blur(20px);
    border-bottom: 1px solid rgba(0,0,0,.06);
  }
  .brand { display: flex; align-items: center; gap: 10px; }
  .brand .mark {
    width: 28px; height: 28px; border-radius: 8px;
    background: linear-gradient(160deg, #0a84ff, #0055c4);
    color: #fff; font-size: 12px; font-weight: 700;
    display: flex; align-items: center; justify-content: center;
  }
  .brand h1 { font-size: 17px; }
  .top-right { display: flex; align-items: center; gap: 12px; }
  .quota { color: var(--muted); font-size: 12.5px; }

  /* 分段导航 */
  .tabs {
    display: flex; gap: 2px; padding: 3px;
    background: rgba(120,120,128,.12); border-radius: 10px;
  }
  .tabs button {
    font: inherit; font-size: 13px; font-weight: 500;
    padding: 5px 20px; border: none; border-radius: 8px;
    background: transparent; color: var(--text); cursor: pointer;
    transition: background .2s ease, box-shadow .2s ease;
  }
  .tabs button.active {
    background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.1), 0 0 1px rgba(0,0,0,.06);
  }

  main { max-width: 1120px; margin: 0 auto; padding: 22px 24px 60px; }

  /* ---------- 机器卡片 ---------- */
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(330px, 1fr)); gap: 16px; }
  .card {
    background: var(--card); border-radius: 18px; padding: 20px;
    box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 6px 18px rgba(0,0,0,.045);
    transition: box-shadow .25s ease, transform .25s ease;
  }
  .card:hover { box-shadow: 0 2px 6px rgba(0,0,0,.06), 0 14px 32px rgba(0,0,0,.08); transform: translateY(-1px); }
  /* 操作进行中：整张卡片锁定，避免并发下发互相冲突 */
  .card.locked { opacity: .55; pointer-events: none; }
  .card-head { margin-bottom: 14px; }
  .card-head-top {
    display: flex; align-items: center; justify-content: space-between;
    gap: 12px; margin-bottom: 7px;
  }
  .card-title {
    font-size: 17px; font-weight: 600; letter-spacing: -0.01em;
    word-break: break-all; min-width: 0;
  }
  .card-meta { color: var(--muted); font-size: 12px; line-height: 1.7; word-break: break-all; }
  .card-meta .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; }

  .pill {
    display: inline-flex; align-items: center; gap: 5px;
    font-size: 12px; font-weight: 500; padding: 3px 10px; border-radius: 980px;
    white-space: nowrap; flex-shrink: 0;
  }
  .pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .pill.running { background: rgba(52,199,89,.12); color: #248a3d; }
  .pill.suspended { background: rgba(255,149,0,.14); color: #b25000; }
  .pill.stopped { background: rgba(142,142,147,.14); color: #6e6e73; }
  .pill.error { background: rgba(255,59,48,.12); color: #c4281c; }
  .pill.busy { background: rgba(0,113,227,.12); color: #0060c0; }

  .actions { display: flex; gap: 7px; flex-wrap: wrap; margin-bottom: 14px; }
  .hint { color: var(--muted); font-size: 11px; line-height: 1.6; margin: -6px 0 14px; }

  .keepalive {
    display: flex; align-items: flex-start; justify-content: space-between; gap: 14px;
    padding-top: 14px; border-top: 1px solid var(--line);
  }
  .ka-body { min-width: 0; flex: 1; }
  .keepalive .label { font-size: 13px; font-weight: 500; margin-bottom: 6px; }
  .time-row {
    display: flex; justify-content: space-between; gap: 10px;
    font-size: 11.5px; color: var(--muted); line-height: 1.8;
  }
  .time-row b {
    font-weight: 500; color: var(--text); white-space: nowrap;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 11px; font-variant-numeric: tabular-nums;
  }
  .keepalive .state { color: var(--muted); font-size: 11.5px; margin-top: 4px; line-height: 1.5; }
  .keepalive .state.active { color: #248a3d; }
  .keepalive .state.failed { color: #c4281c; }

  .switch {
    width: 51px; height: 31px; border-radius: 16px; border: none; padding: 0;
    background: rgba(120,120,128,.16); position: relative; cursor: pointer;
    transition: background .25s ease; flex-shrink: 0;
  }
  .switch::after {
    content: ""; position: absolute; top: 2px; left: 2px;
    width: 27px; height: 27px; border-radius: 50%; background: #fff;
    box-shadow: 0 3px 8px rgba(0,0,0,.15), 0 1px 1px rgba(0,0,0,.06);
    transition: transform .25s cubic-bezier(.4,0,.2,1);
  }
  .switch.on { background: var(--green); }
  .switch.on::after { transform: translateX(20px); }
  .switch:disabled { opacity: .55; cursor: default; }

  /* ---------- 日志 ---------- */
  .logs-card {
    background: var(--card); border-radius: 18px; padding: 20px; margin-top: 18px;
    box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 6px 18px rgba(0,0,0,.045);
  }
  .logs-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-bottom: 8px; }
  .logs-head h2 { font-size: 15px; }
  .logs-head .muted { color: var(--muted); font-size: 11.5px; }
  .log-list { max-height: 300px; overflow-y: auto; }
  #logsView .logs-card { margin-top: 0; }
  .log-list.tall { max-height: calc(100vh - 250px); }
  .log-item {
    display: flex; align-items: baseline; gap: 10px;
    padding: 9px 0; border-bottom: 1px solid var(--line);
    font-size: 12.5px; color: var(--muted);
  }
  .log-item:last-child { border-bottom: none; }
  .log-item .time { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 11px; flex-shrink: 0; color: var(--gray); }
  .log-item .who { color: var(--text); font-weight: 500; flex-shrink: 0; }
  .log-item .what { color: var(--muted); word-break: break-all; }
  .log-item.fail .what { color: #c4281c; }

  .empty {
    text-align: center; color: var(--muted); font-size: 13.5px;
    padding: 56px 20px; background: var(--card); border-radius: 18px;
  }
  .notice {
    display: none; background: rgba(255,149,0,.1); color: #8a4500;
    border-radius: 12px; padding: 10px 14px; font-size: 12.5px; margin-bottom: 16px;
  }
  .notice.show { display: block; }

  /* ---------- 加载骨架 ---------- */
  .skeleton {
    background: var(--card); border-radius: 18px; padding: 20px;
    box-shadow: 0 1px 2px rgba(0,0,0,.04), 0 6px 18px rgba(0,0,0,.045);
  }
  .sk-line {
    height: 12px; border-radius: 6px; margin-bottom: 10px;
    background: linear-gradient(90deg, #ededf1 25%, #f6f6f8 50%, #ededf1 75%);
    background-size: 200% 100%;
    animation: shimmer 1.3s ease-in-out infinite;
  }
  @keyframes shimmer { to { background-position: -200% 0; } }

  /* ---------- 确认弹窗 ---------- */
  .modal-mask {
    position: fixed; inset: 0; z-index: 30;
    display: flex; align-items: center; justify-content: center; padding: 20px;
    background: rgba(0,0,0,.32); backdrop-filter: blur(4px);
    opacity: 0; pointer-events: none; transition: opacity .2s ease;
  }
  .modal-mask.show { opacity: 1; pointer-events: auto; }
  .modal {
    width: 100%; max-width: 340px; background: #fff; border-radius: 18px;
    padding: 22px; text-align: center;
    box-shadow: 0 20px 60px rgba(0,0,0,.22);
    transform: scale(.94); transition: transform .22s cubic-bezier(.4,0,.2,1);
  }
  .modal-mask.show .modal { transform: scale(1); }
  .modal h3 { font-size: 16px; margin-bottom: 8px; letter-spacing: -0.01em; }
  .modal p { color: var(--muted); font-size: 13px; line-height: 1.6; margin-bottom: 20px; }
  .modal-actions { display: flex; gap: 8px; }
  .modal-actions .btn { flex: 1; min-height: 40px; font-size: 14px; }
  .btn.danger-solid { background: var(--red); color: #fff; }
  .btn.danger-solid:hover:not(:disabled) { background: #e0352b; }

  .account-dialog {
    width: min(420px, calc(100vw - 32px)); margin: auto; padding: 24px;
    border: 0; border-radius: 18px; color: var(--text); background: var(--card);
    box-shadow: 0 20px 60px rgba(0,0,0,.22);
  }
  .account-dialog::backdrop { background: rgba(0,0,0,.32); backdrop-filter: blur(3px); }
  .account-dialog h2 { font-size: 18px; margin-bottom: 8px; }
  .account-dialog .account-help { color: var(--muted); font-size: 13px; margin-bottom: 18px; }
  .account-dialog label { display: block; font-size: 13px; margin: 14px 0 7px; }
  .account-dialog .field { font-size: 14px; }
  .account-error { color: #b42318; font-size: 13px; overflow-wrap: anywhere; margin: 14px 0; }
  .account-error:empty { margin: 0; }
  .account-dialog .modal-actions { margin-top: 22px; }

  /* ---------- 机器终端 ---------- */
  .terminal-dialog {
    width: min(1120px, calc(100vw - 32px)); height: min(780px, calc(100dvh - 48px));
    max-width: none; max-height: none; margin: auto; padding: 0;
    border: 1px solid #34383f; border-radius: 14px; color: #e6edf3; background: #11151b;
    box-shadow: 0 24px 90px rgba(0,0,0,.4);
  }
  .terminal-dialog::backdrop { background: rgba(0,0,0,.45); backdrop-filter: blur(3px); }
  .terminal-layout { height: 100%; display: flex; flex-direction: column; min-height: 0; }
  .terminal-head { display: flex; align-items: center; gap: 12px; padding: 12px 16px; border-bottom: 1px solid #30363d; }
  .terminal-heading { min-width: 0; flex: 1; }
  .terminal-heading h2 { font-size: 15px; margin: 0 0 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .terminal-status { font-size: 12px; color: #adb8c5; overflow-wrap: anywhere; }
  .terminal-status.error { color: #ffaaa4; }
  .terminal-controls { display: flex; flex-wrap: wrap; gap: 7px; }
  .terminal-dialog .btn { background: #242b35; color: #e6edf3; }
  .terminal-dialog .btn:hover:not(:disabled) { background: #35404e; }
  .terminal-screen { flex: 1; min-width: 0; min-height: 0; padding: 12px 8px 8px 14px; overflow: hidden; }
  .terminal-foot { padding: 8px 16px; font-size: 11px; color: #adb8c5; border-top: 1px solid #30363d; }
  @media (max-width: 640px) {
    .terminal-dialog { width: 100vw; height: 100dvh; border-radius: 0; border: 0; }
    .terminal-head { flex-wrap: wrap; padding: 10px 12px; }
    .terminal-heading { flex-basis: 100%; }
    .terminal-screen { padding: 8px; }
  }

  .logs-head .tools { display: flex; align-items: center; gap: 10px; }
  .logs-head .btn { min-height: 26px; padding: 3px 11px; font-size: 11.5px; }

  .toast {
    position: fixed; left: 50%; bottom: 28px; transform: translate(-50%, 12px);
    background: rgba(29,29,31,.92); color: #fff; font-size: 13px;
    padding: 10px 18px; border-radius: 980px; opacity: 0; pointer-events: none;
    transition: opacity .22s ease, transform .22s ease; z-index: 20;
    max-width: 86vw; text-align: center;
    backdrop-filter: blur(10px);
  }
  .toast.show { opacity: 1; transform: translate(-50%, 0); }
  .toast.err { background: rgba(196,40,28,.95); }

  @media (max-width: 640px) {
    .topbar { padding: 10px 16px; }
    main { padding: 16px 16px 40px; }
    .grid { grid-template-columns: 1fr; }
    .quota { display: none; }
  }
</style>
</head>
<body>

<div id="loginView" class="login-wrap" style="display:none">
  <div class="login-card">
    <div class="logo">IB</div>
    <h1>InstaBox</h1>
    <p class="sub">机器控制台</p>
    <input id="pwd" class="field" type="password" placeholder="面板密码" autocomplete="current-password">
    <button id="loginBtn" class="btn primary block">登录</button>
  </div>
</div>

<div id="mainView" style="display:none">
  <header class="topbar">
    <div class="brand"><span class="mark">IB</span><h1>InstaBox</h1></div>
    <nav class="tabs">
      <button data-tab="machines" class="active">机器</button>
      <button data-tab="logs">日志</button>
    </nav>
    <div class="top-right">
      <span class="quota" id="quota"></span>
      <button id="addAccountBtn" class="btn primary">添加账号</button>
      <button id="refreshBtn" class="btn">刷新</button>
      <button id="logoutBtn" class="btn">退出</button>
    </div>
  </header>
  <main>
    <div id="notice" class="notice"></div>
    <section id="machinesView">
      <div class="grid" id="machines"></div>
    </section>
    <section id="logsView" style="display:none">
      <div class="logs-card">
        <div class="logs-head">
          <h2>保活日志</h2>
          <div class="tools">
            <span class="muted">最近 50 条 · 存于 Upstash Redis</span>
            <button id="clearLogsBtn" class="btn danger">清空</button>
          </div>
        </div>
        <div id="logList" class="log-list tall"></div>
      </div>
    </section>
  </main>
</div>

<div id="confirmMask" class="modal-mask">
  <div class="modal">
    <h3 id="cfTitle"></h3>
    <p id="cfMsg"></p>
    <div class="modal-actions">
      <button id="cfCancel" class="btn">取消</button>
      <button id="cfOk" class="btn primary">确定</button>
    </div>
  </div>
</div>

<div id="toast" class="toast"></div>

<dialog id="accountDialog" class="account-dialog" aria-labelledby="accountTitle">
  <form id="accountForm">
    <h2 id="accountTitle">添加账号</h2>
    <p class="account-help" id="accountHelp">验证 Key 后，自动发现该账号已有的机器。新机器默认不开启保活。</p>
    <label for="accountKey">API Key</label>
    <input id="accountKey" class="field" type="password" autocomplete="off" spellcheck="false" placeholder="ibk_…" maxlength="256" required aria-describedby="accountHelp accountError">
    <label for="accountName">名称（可选）</label>
    <input id="accountName" class="field" type="text" autocomplete="off" maxlength="80" placeholder="便于区分的账号名称">
    <p id="accountError" class="account-error" role="alert"></p>
    <div class="modal-actions">
      <button id="accountCancel" type="button" class="btn">取消</button>
      <button id="accountSubmit" type="submit" class="btn primary" disabled>验证并添加</button>
    </div>
  </form>
</dialog>

<dialog id="terminalDialog" class="terminal-dialog" aria-labelledby="terminalTitle">
  <div class="terminal-layout">
    <header class="terminal-head">
      <div class="terminal-heading">
        <h2 id="terminalTitle">终端</h2>
        <div id="terminalStatus" class="terminal-status" role="status" aria-live="polite">未连接</div>
      </div>
      <div class="terminal-controls">
        <button id="terminalPaste" class="btn" disabled>粘贴</button>
        <button id="terminalInterrupt" class="btn" disabled title="发送 Ctrl+C">Ctrl+C</button>
        <button id="terminalReconnect" class="btn" disabled>重连</button>
        <button id="terminalClose" class="btn" aria-label="关闭终端">关闭</button>
      </div>
    </header>
    <div id="terminalScreen" class="terminal-screen" aria-label="交互式终端"></div>
    <footer id="terminalFoot" class="terminal-foot">长任务建议使用 tmux；关闭窗口后请核对任务状态。</footer>
  </div>
</dialog>

<script>
"use strict";

var AUTH = localStorage.getItem("ib_auth") || "";
var DATA = { machines: [], logs: [], usage: null, accountCount: 1 };
var BUSY = {};            // 防重复点击：按操作维度加锁
var MACHINE_BUSY = {};    // 按机器加锁：一台机器操作中，卡片内所有按钮一并禁用
var toastTimer = null;

/** 目标状态映射：下发指令后先把卡片切到过渡态，界面立刻有反馈 */
var OPTIMISTIC = { start: "starting", resume: "resuming", suspend: "suspending", stop: "stopping" };

var STATE_TEXT = {
  creating: "创建中", starting: "启动中", running: "运行中", stopping: "停止中",
  stopped: "已停止", suspending: "暂停中", suspended: "已暂停", resuming: "恢复中",
  deleting: "删除中", error: "异常"
};
var STATE_PILL = {
  running: "running", suspended: "suspended", stopped: "stopped", error: "error",
  creating: "busy", starting: "busy", stopping: "busy", suspending: "busy",
  resuming: "busy", deleting: "busy"
};
var ACTION_TEXT = { start: "启动", resume: "唤醒", suspend: "暂停", stop: "停止" };

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function delay(ms) {
  return new Promise(function (resolve) { setTimeout(resolve, ms); });
}
var CRON_MINUTES = 15;   // 从 /api/machines 读取，须与 Cloudflare Cron 一致

/** 统一按中国时间（UTC+8）输出 xxxx-xx-xx xx:xx:xx，不受浏览器所在时区影响 */
function fmtCN(iso) {
  if (!iso) return "—";
  var d = new Date(iso);
  if (isNaN(d.getTime())) return "—";
  var parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23"
  }).formatToParts(d);
  var o = {};
  for (var i = 0; i < parts.length; i++) o[parts[i].type] = parts[i].value;
  return o.year + "-" + o.month + "-" + o.day + " " + o.hour + ":" + o.minute + ":" + o.second;
}

/** 按 Cron 的小时内分钟步长计算；*/
function nextTickAt(notBefore) {
  var boundary = Date.parse(notBefore);
  var base = Math.max(Date.now() + 1, isNaN(boundary) ? 0 : boundary);
  var next = new Date(base);
  next.setUTCSeconds(0, 0);
  if (next.getTime() < base) next.setUTCMinutes(next.getUTCMinutes() + 1);
  while (next.getUTCMinutes() % CRON_MINUTES !== 0) next.setUTCMinutes(next.getUTCMinutes() + 1);
  return next.toISOString();
}

function remainText(iso) {
  if (!iso) return "";
  var ms = new Date(iso).getTime() - Date.now();
  if (isNaN(ms)) return "";
  if (ms <= 0) return "租约已过期";
  var min = Math.round(ms / 60000);
  return "租约剩余 " + (min >= 60 ? Math.floor(min / 60) + " 小时 " + (min % 60) + " 分" : min + " 分钟");
}

/** 把文本里的 ISO 时间戳换成中国时间，日志详情更易读 */
function humanize(text) {
  return String(text == null ? "" : text).replace(
    /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z/g,
    function (m) { return fmtCN(m); }
  );
}

/** 通用确认弹窗，返回 Promise<boolean> */
function confirmDialog(opts) {
  return new Promise(function (resolve) {
    var mask = document.getElementById("confirmMask");
    var okBtn = document.getElementById("cfOk");
    var cancelBtn = document.getElementById("cfCancel");

    document.getElementById("cfTitle").textContent = opts.title || "确认操作";
    document.getElementById("cfMsg").textContent = opts.message || "";
    okBtn.textContent = opts.okText || "确定";
    okBtn.className = "btn " + (opts.danger ? "danger-solid" : "primary");
    mask.classList.add("show");

    function finish(value) {
      mask.classList.remove("show");
      okBtn.removeEventListener("click", onOk);
      cancelBtn.removeEventListener("click", onCancel);
      mask.removeEventListener("click", onMask);
      resolve(value);
    }
    function onOk() { finish(true); }
    function onCancel() { finish(false); }
    function onMask(e) { if (e.target === mask) finish(false); }

    okBtn.addEventListener("click", onOk);
    cancelBtn.addEventListener("click", onCancel);
    mask.addEventListener("click", onMask);
  });
}

function toast(msg, isErr) {
  var el = document.getElementById("toast");
  el.textContent = msg;
  el.className = "toast show" + (isErr ? " err" : "");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.className = "toast" + (isErr ? " err" : ""); }, 3400);
}

/** 统一的 API 封装：附带面板密码，非 2xx 抛错并带上服务端原因 */
function api(path, options) {
  options = options || {};
  options.headers = Object.assign({ "X-Panel-Auth": AUTH, "Content-Type": "application/json" }, options.headers || {});
  return fetch("/api" + path, options).then(function (res) {
    return res.json().catch(function () { return {}; }).then(function (data) {
      if (res.status === 401) { logout(); throw new Error("登录已失效，请重新登录"); }
      if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
      return data;
    });
  });
}

/** 锁定整张卡片：操作进行中，其他按钮与开关都不可点 */
function setMachineLocked(id, locked) {
  if (locked) MACHINE_BUSY[id] = true;
  else delete MACHINE_BUSY[id];
  var card = document.querySelector('[data-card="' + id + '"]');
  if (!card) return;
  card.classList.toggle("locked", locked);
  var els = card.querySelectorAll("button");
  for (var i = 0; i < els.length; i++) els[i].disabled = locked || els[i].hasAttribute("data-unavailable");
}

/** 按钮忙碌态：锁定宽度避免跳动，显示转圈，结束后恢复原文案 */
function setBtnBusy(btn, isBusy) {
  if (!btn) return;
  if (isBusy) {
    if (btn.dataset.text == null) btn.dataset.text = btn.textContent;
    if (!btn.style.width) btn.style.width = btn.offsetWidth + "px";
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span>';
  } else {
    btn.disabled = false;
    btn.textContent = btn.dataset.text || btn.textContent;
    btn.style.width = "";
  }
}

// ---------- 登录 ----------
function showLogin() {
  document.getElementById("loginView").style.display = "flex";
  document.getElementById("mainView").style.display = "none";
  setTimeout(function () { document.getElementById("pwd").focus(); }, 60);
}
function showMain() {
  document.getElementById("loginView").style.display = "none";
  document.getElementById("mainView").style.display = "block";
  // 重新登录后清掉可能残留的忙碌态
  setBtnBusy(document.getElementById("refreshBtn"), false);
  setBtnBusy(document.getElementById("clearLogsBtn"), false);
  switchTab(localStorage.getItem("ib_tab") || "machines", true);
  loadAll();
}

/** 切换「机器 / 日志」视图；切到日志时顺手刷新一次数据 */
function switchTab(name, skipReload) {
  var isMachines = name !== "logs";
  document.getElementById("machinesView").style.display = isMachines ? "" : "none";
  document.getElementById("logsView").style.display = isMachines ? "none" : "";
  var tabs = document.querySelectorAll("[data-tab]");
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].classList.toggle("active", tabs[i].getAttribute("data-tab") === (isMachines ? "machines" : "logs"));
  }
  try { localStorage.setItem("ib_tab", isMachines ? "machines" : "logs"); } catch (e) { /* 忽略隐私模式限制 */ }
  if (!isMachines && !skipReload) loadAll();
}
function logout() {
  closeAccountDialog();
  closeTerminal();
  localStorage.removeItem("ib_auth");
  AUTH = "";
  showLogin();
}
function login() {
  var btn = document.getElementById("loginBtn");
  var pwd = document.getElementById("pwd").value.trim();
  if (!pwd) { toast("请输入密码", true); return; }
  if (btn.disabled) return;
  AUTH = pwd;
  setBtnBusy(btn, true);
  api("/auth", { method: "POST" })
    .then(function () {
      localStorage.setItem("ib_auth", AUTH);
      document.getElementById("pwd").value = "";
      showMain();
    })
    .catch(function (e) { AUTH = ""; toast("登录失败：" + e.message, true); })
    .then(function () { setBtnBusy(btn, false); });
}

// ---------- 数据加载 ----------
var firstLoad = true;

/** 加载骨架：仅在还没有数据时展示，避免刷新时画面闪烁 */
function renderSkeleton() {
  var box = document.getElementById("machines");
  var one = '<div class="skeleton">' +
    '<div class="sk-line" style="width:42%;height:16px"></div>' +
    '<div class="sk-line" style="width:68%"></div>' +
    '<div class="sk-line" style="width:52%"></div>' +
    '<div class="sk-line" style="width:34%;margin-top:20px"></div>' +
    '</div>';
  box.innerHTML = one + one + one;
}

/** 三个请求互相独立：任一失败不影响其余内容渲染 */
function loadAll() {
  if (firstLoad) renderSkeleton();
  return Promise.allSettled([api("/machines"), api("/logs"), api("/usage")]).then(function (results) {
    firstLoad = false;
    var problems = [];
    var warnings = [];

    if (results[0].status === "fulfilled") {
      DATA.machines = results[0].value.machines || [];
      DATA.accountCount = typeof results[0].value.accountCount === "number" ? results[0].value.accountCount : 1;
      CRON_MINUTES = results[0].value.intervalMinutes || 15;
      DATA.capacity = results[0].value.capacity || null;
      if (DATA.capacity && DATA.capacity.warning) warnings.push(DATA.capacity.warning);
      (results[0].value.accountErrors || []).forEach(function (item) { problems.push(item.accountName + "：" + item.error); });
      if (results[0].value.configError) problems.push("保活配置读取失败：" + results[0].value.configError);
    } else {
      problems.push(results[0].reason.message);
    }
    if (results[1].status === "fulfilled") DATA.logs = results[1].value.logs || [];
    else problems.push("日志加载失败：" + results[1].reason.message);
    if (results[2].status === "fulfilled") {
      DATA.usage = results[2].value.usage;
      (results[2].value.accountErrors || []).forEach(function (item) { problems.push(item.accountName + "：" + item.error); });
    }
    else problems.push("配额加载失败：" + results[2].reason.message);

    render();

    var notice = document.getElementById("notice");
    var notices = problems.concat(warnings);
    if (notices.length) {
      notice.textContent = notices.join("；");
      notice.className = "notice show";
    } else {
      notice.className = "notice";
    }
    return problems;
  });
}

/** 操作下发后自动追状态：过渡态期间再多刷几次，直到稳定 */
var PENDING_RE = /^(creating|starting|stopping|suspending|resuming|deleting)$/;
function followUp(rounds) {
  var left = typeof rounds === "number" ? rounds : 3;
  // 首次很快，之后逐步放慢，避免频繁打接口
  var wait = left >= 3 ? 800 : 2000;
  return delay(wait).then(function () {
    return loadAll().then(function () {
      var pending = false;
      for (var i = 0; i < DATA.machines.length; i++) {
        if (PENDING_RE.test(DATA.machines[i].state)) { pending = true; break; }
      }
      if (pending && left > 0) return followUp(left - 1);
    });
  });
}

/** 按 ID 找当前列表里的机器 */
function findMachine(id) {
  for (var i = 0; i < DATA.machines.length; i++) {
    if (DATA.machines[i].key === id) return DATA.machines[i];
  }
  return null;
}

function machinePath(key) {
  var m = findMachine(key);
  if (!m) throw new Error("机器已不在列表中，请刷新");
  return "/accounts/" + encodeURIComponent(m.accountId) + "/machines/" + encodeURIComponent(m.id);
}

// ---------- 渲染 ----------
function render() {
  var u = DATA.usage || {};
  var parts = [];
  if (DATA.accountCount > 1) parts.push("账号 " + DATA.accountCount);
  if (u.machines != null) parts.push("机器 " + u.machines);
  if (u.snapshots != null) parts.push("快照 " + u.snapshots);
  if (u.storageGiB != null) parts.push("存储 " + u.storageGiB + " GB");
  document.getElementById("quota").textContent = parts.join(" · ");

  var box = document.getElementById("machines");
  if (!DATA.machines.length) {
    box.innerHTML = '<div class="empty">暂无机器</div>';
  } else {
    box.innerHTML = DATA.machines.map(renderCard).join("");
  }

  var list = document.getElementById("logList");
  if (!DATA.logs.length) {
    list.innerHTML = '<div class="log-item"><span class="what">暂无日志</span></div>';
  } else {
    list.innerHTML = DATA.logs.map(function (l) {
      return '<div class="log-item' + (l.ok ? "" : " fail") + '">' +
        '<span class="time">' + esc(fmtCN(l.t)) + '</span>' +
        '<span class="who">' + esc((DATA.accountCount > 1 && l.accountName ? l.accountName + " · " : "") + (l.name || l.machineId)) + '</span>' +
        '<span class="what">' + esc(l.action) + ' · ' + esc(humanize(l.detail)) + '</span>' +
        '</div>';
    }).join("");
  }
}

function renderCard(m) {
  var ka = m.keepalive || {};
  var on = ka.keepalive === "on";
  var cooling = Date.parse(m.cooldownUntil) > Date.now();
  var stateText = cooling ? "冷却中" : (STATE_TEXT[m.state] || m.state);
  var pillClass = cooling ? "suspended" : (STATE_PILL[m.state] || "busy");

  // 显示上一轮结果及下一轮全局调度；分批时本机可能在后续轮次处理
  var timeRows = "";
  if (ka.lastAt) {
    timeRows += '<div class="time-row"><span>上次检查</span><b>' + esc(fmtCN(ka.lastAt)) + '</b></div>';
  }
  if (cooling) {
    timeRows += '<div class="time-row"><span>冷却结束</span><b>' + esc(fmtCN(m.cooldownUntil)) + '</b></div>';
  }
  if (on) {
    timeRows += '<div class="time-row"><span>' + (cooling ? '冷却后首轮' : '下轮调度') + '</span><b>' + esc(fmtCN(nextTickAt(cooling ? m.cooldownUntil : null))) + '</b></div>';
  }

  var stateLine;
  var stateClass = "";
  if (on) {
    if (cooling) stateLine = "冷却结束后自动重试";
    else if (ka.lastStatus === "failed") { stateLine = ka.lastDetail || "上次保活失败"; stateClass = " failed"; }
    else if (ka.lastStatus === "waiting") stateLine = ka.lastDetail;
    else { stateLine = remainText(ka.leaseExpiresAt) || "等待检查"; stateClass = Date.parse(ka.leaseExpiresAt) > Date.now() ? " active" : ""; }
  } else if (ka.lastAt) {
    stateLine = "已关闭 · " + (ka.lastDetail || "");
  } else {
    stateLine = "未开启";
  }

  // 按当前状态给出可用操作；卡片被锁定时全部禁用
  var locked = !!MACHINE_BUSY[m.key];
  var dis = locked ? " disabled" : "";
  var acts = [];
  if (m.state === "suspended") acts.push(["resume", "唤醒"]);
  if (m.state === "stopped") acts.push(["start", "启动"]);
  if (m.state === "running") { acts.push(["suspend", "暂停"]); acts.push(["stop", "停止"]); }

  var btns = acts.map(function (a) {
    var unavailable = !!m.operationId || (cooling && (a[0] === "start" || a[0] === "resume"));
    return '<button class="btn" data-act="' + a[0] + '" data-id="' + esc(m.key) + '"' +
      (unavailable ? ' disabled data-unavailable title="等待冷却或当前操作结束"' : dis) + '>' + a[1] + '</button>';
  }).join("");
  var terminalDisabled = m.state !== "running" || cooling || !!m.operationId;
  btns = '<button class="btn" data-terminal="' + esc(m.key) + '"' +
    (terminalDisabled ? ' disabled data-unavailable title="机器运行就绪后可连接终端"' : dis) + '>终端</button>' + btns;
  btns += '<button class="btn danger" data-del="' + esc(m.key) + '" data-name="' + esc(m.name) + '"' + dis + '>删除</button>';

  var spec = "";
  if (m.spec) {
    spec = m.spec.vcpus + " 核 · " + Math.round(m.spec.memMiB / 1024) + " GB 内存" +
      (m.spec.persistentDiskGiB ? " · " + m.spec.persistentDiskGiB + " GB 磁盘" : "");
  }

  return '<div class="card' + (locked ? " locked" : "") + '" data-card="' + esc(m.key) + '">' +
    '<div class="card-head">' +
      '<div class="card-head-top">' +
        '<div class="card-title">' + esc(m.name) + '</div>' +
        '<span class="pill ' + pillClass + '">' + esc(stateText) + '</span>' +
      '</div>' +
      '<div class="card-meta">' + (DATA.accountCount > 1 ? esc(m.accountName) + '<br>' : '') + '<span class="mono">' + esc(m.id) + '</span><br>' +
      esc(spec) + (m.template ? " · " + esc(m.template) : "") + '</div>' +
    '</div>' +
    '<div class="actions">' + btns + '</div>' +
    (m.state === "running" ? '<div class="hint">暂停保留内存与进程，可原地继续；停止等于关机，只保留文件。</div>' : "") +
    '<div class="keepalive">' +
      '<div class="ka-body">' +
        '<div class="label">自动保活</div>' +
        timeRows +
        '<div class="state' + stateClass + '">' + esc(stateLine) + '</div>' +
      '</div>' +
      '<button class="switch' + (on ? " on" : "") + '" data-toggle="' + esc(m.key) + '" aria-pressed="' + (on ? "true" : "false") + '" aria-label="自动保活"' + dis + '></button>' +
    '</div>' +
  '</div>';
}

// ---------- 官方 PTY 终端（按需加载 xterm.js） ----------
var TERMINAL = null;
var TERMINAL_IDS = {};
var terminalAssets = null;

function loadTerminalAsset(url, integrity, style) {
  return new Promise(function (resolve, reject) {
    var el = document.createElement(style ? "link" : "script");
    if (style) { el.rel = "stylesheet"; el.href = url; } else { el.src = url; el.async = true; }
    el.integrity = integrity;
    el.crossOrigin = "anonymous";
    var timer = setTimeout(function () { fail(); }, 20000);
    function fail() {
      clearTimeout(timer); el.remove();
      reject(new Error("终端组件加载失败，请检查网络后重连"));
    }
    el.onload = function () { clearTimeout(timer); resolve(); };
    el.onerror = fail;
    document.head.appendChild(el);
  });
}

function loadTerminalAssets() {
  if (!terminalAssets) {
    terminalAssets = Promise.all([
      loadTerminalAsset("https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.js", "sha384-M169f14mRZOXm3hD/v2Ti0ThIT/RnAQagXA9nlE15yHAtrW19gdePJh/HaTzUOe/", false),
      loadTerminalAsset("https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.css", "sha384-8Xk9wy/gzEDUKrXtrmCFa2bBuK3BpjpDuL/p0SeKQX19Khl/M+lHOgD/CyYf7efP", true),
      loadTerminalAsset("https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.js", "sha384-iF+jqbuti4XlB64clWgFWYEscb+UnSRv3VgVikGYZu+otNFnSHr7y7NcKfBnGizn", false)
    ]).then(function () {
      if (!window.Terminal || !window.FitAddon) throw new Error("终端组件不可用，请重连");
    }).catch(function (error) { terminalAssets = null; throw error; });
  }
  return terminalAssets;
}

function terminalStatus(s, text, error, connecting) {
  if (TERMINAL !== s) return;
  var status = document.getElementById("terminalStatus");
  status.textContent = text;
  status.className = "terminal-status" + (error ? " error" : "");
  document.getElementById("terminalReconnect").disabled = !!connecting;
  var connected = !!s.ws && s.ws.readyState === WebSocket.OPEN;
  document.getElementById("terminalPaste").disabled = !connected;
  document.getElementById("terminalInterrupt").disabled = !connected;
}

function terminalSend(s, data) {
  if (TERMINAL !== s || !s.ws || s.ws.readyState !== WebSocket.OPEN) return;
  if (s.ws.bufferedAmount > 1024 * 1024 || data.length > 1024 * 1024) {
    terminalStatus(s, "输入过快或粘贴过大，请稍后分段输入", true, false); return;
  }
  s.ws.send(data);
}

function terminalSize(s) {
  if (s.term) terminalSend(s, JSON.stringify({ type: "resize", cols: s.term.cols, rows: s.term.rows }));
}

function closeTerminal() {
  var s = TERMINAL;
  TERMINAL = null;
  if (s) {
    s.seq++;
    clearTimeout(s.timeout); clearTimeout(s.resizeTimer);
    if (s.observer) s.observer.disconnect();
    if (s.ws) { s.ws.onclose = s.ws.onmessage = s.ws.onopen = s.ws.onerror = null; s.ws.close(); }
    if (s.term) s.term.dispose();
  }
  var dialog = document.getElementById("terminalDialog");
  if (dialog.open) dialog.close();
  document.getElementById("terminalScreen").textContent = "";
  if (s && s.returnFocus && s.returnFocus.isConnected) s.returnFocus.focus();
}

function connectTerminal(s) {
  var seq = ++s.seq;
  clearTimeout(s.timeout);
  if (s.ws) { s.ws.onclose = s.ws.onmessage = s.ws.onopen = s.ws.onerror = null; s.ws.close(); s.ws = null; }
  terminalStatus(s, "连接中…", false, true);
  loadTerminalAssets().then(function () {
    if (TERMINAL !== s || seq !== s.seq) return null;
    if (!s.term) {
      s.term = new window.Terminal({ cursorBlink: true, scrollback: 3000, fontSize: 13,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        theme: { background: "#11151b", foreground: "#e6edf3", cursor: "#ffffff", selectionBackground: "#3b4d66" } });
      s.fit = new window.FitAddon.FitAddon();
      s.term.loadAddon(s.fit);
      s.term.open(document.getElementById("terminalScreen"));
      s.term.onData(function (data) { terminalSend(s, new TextEncoder().encode(data)); });
      s.term.onBinary(function (data) { terminalSend(s, Uint8Array.from(data, function (c) { return c.charCodeAt(0) & 255; })); });
      s.term.onResize(function () { terminalSize(s); });
      s.term.attachCustomKeyEventHandler(function (event) {
        if (event.type === "keydown" && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c" && s.term.hasSelection()) {
          if (navigator.clipboard) navigator.clipboard.writeText(s.term.getSelection()).catch(function () {});
          return false;
        }
        return true;
      });
      s.observer = new ResizeObserver(function () {
        clearTimeout(s.resizeTimer);
        s.resizeTimer = setTimeout(function () {
          if (TERMINAL === s && s.fit) { try { s.fit.fit(); } catch (_) {} }
        }, 80);
      });
      s.observer.observe(document.getElementById("terminalScreen"));
    }
    s.fit.fit();
    return api(machinePath(s.key) + "/terminal", { method: "POST", body: "{}" });
  }).then(function (access) {
    if (!access || TERMINAL !== s || seq !== s.seq) return;
    var url = new URL(access.url);
    url.searchParams.set("cols", s.term.cols);
    url.searchParams.set("rows", s.term.rows);
    url.searchParams.set("session", s.session);
    // 终端不改变机器生命周期；暂停或冷却时由用户回到卡片操作。
    url.searchParams.set("wake", "0");
    var ws = new WebSocket(url.href, [access.protocol, "instabox-access-token." + access.token]);
    s.ws = ws;
    ws.binaryType = "arraybuffer";
    var note = "连接已断开，请检查机器状态后重连";
    var failed = true;
    function live() { return TERMINAL === s && seq === s.seq && s.ws === ws; }
    s.timeout = setTimeout(function () {
      if (!live() || ws.readyState === WebSocket.OPEN) return;
      note = "连接超时，请检查机器状态后重连";
      ws.close(); terminalStatus(s, note, true, false);
    }, 20000);
    ws.onopen = function () {
      if (!live()) { ws.close(); return; }
      clearTimeout(s.timeout);
      s.term.reset(); terminalSize(s);
      terminalStatus(s, "已连接", false, false); s.term.focus();
    };
    ws.onmessage = function (event) {
      if (!live()) return;
      if (typeof event.data !== "string") { s.term.write(new Uint8Array(event.data)); return; }
      var message;
      try { message = JSON.parse(event.data); } catch (_) { return; }
      if (message.type === "session") {
        s.term.reset();
        document.getElementById("terminalFoot").textContent = message.persistent
          ? "此页重连可恢复会话；长任务仍建议使用 tmux。"
          : "此会话不保留；长任务建议使用 tmux 或后台任务。";
      }
      if (message.type === "exit") { note = "Shell 已退出（" + (message.code || 0) + "）"; failed = false; }
      if (message.type === "taken") { note = "会话已在其他连接中打开"; failed = false; }
      if (message.type === "error") { note = typeof message.message === "string" ? message.message.slice(0,300) : "终端服务返回错误"; }
      if (["exit", "taken", "error"].indexOf(message.type) !== -1) { ws.close(); terminalStatus(s, note, failed, false); }
    };
    ws.onerror = function () { if (live()) terminalStatus(s, "终端连接失败，请检查网络、机器状态或票据权限", true, false); };
    ws.onclose = function () {
      if (!live()) return;
      clearTimeout(s.timeout); s.ws = null;
      terminalStatus(s, note, failed, false);
    };
  }).catch(function (error) {
    if (TERMINAL === s && seq === s.seq) terminalStatus(s, error.message || "终端连接失败", true, false);
  });
}

function openTerminal(key, button) {
  var machine = DATA.machines.find(function (m) { return m.key === key; });
  if (!machine || machine.state !== "running" || machine.operationId || Date.parse(machine.cooldownUntil) > Date.now()) {
    toast("请等待机器运行就绪后再打开终端", true); return;
  }
  closeTerminal();
  if (!TERMINAL_IDS[key]) TERMINAL_IDS[key] = "panel-" + crypto.randomUUID().split("-").join("").slice(0, 26);
  var s = { key: key, session: TERMINAL_IDS[key], seq: 0, ws: null, term: null, returnFocus: button };
  TERMINAL = s;
  document.getElementById("terminalTitle").textContent = machine.name + " · " + machine.accountName;
  document.getElementById("terminalFoot").textContent = "长任务建议使用 tmux；关闭窗口后请核对任务状态。";
  document.getElementById("terminalDialog").showModal();
  connectTerminal(s);
}

document.getElementById("machines").addEventListener("click", function (event) {
  var button = event.target.closest("[data-terminal]");
  if (button && !button.disabled) openTerminal(button.dataset.terminal, button);
});
document.getElementById("terminalClose").addEventListener("click", closeTerminal);
document.getElementById("terminalDialog").addEventListener("close", closeTerminal);
// Escape 属于终端程序（例如 vim），不把它解释为关闭弹窗。
document.getElementById("terminalDialog").addEventListener("cancel", function (event) { event.preventDefault(); });
document.getElementById("terminalReconnect").addEventListener("click", function () { if (TERMINAL) connectTerminal(TERMINAL); });
document.getElementById("terminalInterrupt").addEventListener("click", function () {
  if (TERMINAL) { terminalSend(TERMINAL, new Uint8Array([3])); TERMINAL.term.focus(); }
});
document.getElementById("terminalPaste").addEventListener("click", function () {
  var s = TERMINAL;
  if (!s || !s.term) return;
  if (!navigator.clipboard) { terminalStatus(s, "请使用系统粘贴快捷键", true, false); return; }
  navigator.clipboard.readText().then(function (text) {
    if (TERMINAL === s) { s.term.paste(text); s.term.focus(); }
  }).catch(function () { terminalStatus(s, "无法读取剪贴板，请使用系统粘贴快捷键", true, false); });
});
if (typeof window !== "undefined") window.addEventListener("pagehide", closeTerminal);

// ---------- 添加已有账号 ----------
var ACCOUNT_FORM_BUSY = false;
var ACCOUNT_FORM_GENERATION = 0;

function closeAccountDialog() {
  var dialog = document.getElementById("accountDialog");
  if (dialog.open) dialog.close();
  document.getElementById("accountKey").value = "";
  document.getElementById("accountName").value = "";
  ACCOUNT_FORM_GENERATION++;
}

function openAccountDialog() {
  if (ACCOUNT_FORM_BUSY) { toast("账号仍在验证，请稍候", true); return; }
  var generation = ++ACCOUNT_FORM_GENERATION;
  document.getElementById("accountError").textContent = "";
  document.getElementById("accountSubmit").disabled = true;
  document.getElementById("accountKey").value = "";
  document.getElementById("accountName").value = "";
  document.getElementById("accountDialog").showModal();
  document.getElementById("accountKey").focus();
  api("/accounts").then(function (result) {
    if (generation !== ACCOUNT_FORM_GENERATION) return;
    document.getElementById("accountSubmit").disabled = !result.canAdd;
    if (!result.canAdd) document.getElementById("accountError").textContent = "网页添加账号尚未启用，请联系面板管理员完成配置。";
  }).catch(function (error) {
    if (generation === ACCOUNT_FORM_GENERATION) document.getElementById("accountError").textContent = error.message;
  });
}

document.getElementById("addAccountBtn").addEventListener("click", openAccountDialog);
document.getElementById("accountCancel").addEventListener("click", closeAccountDialog);
document.getElementById("accountDialog").addEventListener("cancel", function (event) {
  if (ACCOUNT_FORM_BUSY) { event.preventDefault(); return; }
  closeAccountDialog();
});
document.getElementById("accountDialog").addEventListener("close", function () {
  document.getElementById("accountKey").value = "";
  document.getElementById("accountName").value = "";
  ACCOUNT_FORM_GENERATION++;
});
document.getElementById("accountForm").addEventListener("submit", function (event) {
  event.preventDefault();
  var submit = document.getElementById("accountSubmit");
  if (ACCOUNT_FORM_BUSY || submit.disabled) return;
  var apiKey = document.getElementById("accountKey").value.trim();
  var name = document.getElementById("accountName").value.trim();
  if (!/^ibk_[A-Za-z0-9_-]+$/.test(apiKey)) {
    document.getElementById("accountError").textContent = "请输入以 ibk_ 开头的 API Key"; return;
  }
  ACCOUNT_FORM_BUSY = true;
  var generation = ACCOUNT_FORM_GENERATION;
  setBtnBusy(submit, true);
  document.getElementById("accountCancel").disabled = true;
  document.getElementById("accountKey").disabled = true;
  document.getElementById("accountName").disabled = true;
  document.getElementById("accountError").textContent = "";
  var pending = api("/accounts", { method: "POST", body: JSON.stringify({ apiKey: apiKey, name: name }) });
  apiKey = "";
  pending.then(function (result) {
    if (generation !== ACCOUNT_FORM_GENERATION || !AUTH) return;
    closeAccountDialog();
    toast("已添加「" + result.account.name + "」，发现 " + result.machineCount + " 台机器");
    return loadAll();
  }).catch(function (error) {
    if (generation === ACCOUNT_FORM_GENERATION && AUTH) document.getElementById("accountError").textContent = error.message;
  }).finally(function () {
    ACCOUNT_FORM_BUSY = false;
    setBtnBusy(submit, false);
    document.getElementById("accountCancel").disabled = false;
    document.getElementById("accountKey").disabled = false;
    document.getElementById("accountName").disabled = false;
  });
});

// ---------- 操作 ----------
function lifecycle(id, action, btn) {
  var key = "act:" + id + ":" + action;
  if (BUSY[key] || MACHINE_BUSY[id]) return;

  var run = function () {
    var m = findMachine(id);
    var label = m ? m.name : id;
    BUSY[key] = true;
    setMachineLocked(id, true);
    setBtnBusy(btn, true);
    api(machinePath(id) + "/" + action, { method: "POST", body: JSON.stringify({ name: label }) })
      .then(function () {
        // 先把本地状态切到过渡态，界面立刻有反馈，不必等下一次轮询
        var current = findMachine(id);
        if (current && OPTIMISTIC[action]) {
          current.state = OPTIMISTIC[action];
          render();
        }
        toast("已下发" + ACTION_TEXT[action] + "指令 · " + label);
        return followUp(3);
      })
      .catch(function (e) { toast(ACTION_TEXT[action] + "失败：" + e.message, true); })
      .then(function () {
        BUSY[key] = false;
        setMachineLocked(id, false);
        setBtnBusy(btn, false);
      });
  };

  // 停止丢失内存与进程，暂停会中断当前会话，两者都先确认
  if (action === "stop" || action === "suspend") {
    var isStop = action === "stop";
    confirmDialog({
      title: isStop ? "停止这台机器？" : "暂停这台机器？",
      message: isStop
        ? "停止等于关机：内存和运行中的进程都会丢失，磁盘文件保留。下次启动是冷启动。"
        : "暂停会保留内存和运行中的进程，唤醒后从原地继续，不会冷启动。空闲 30 分钟也会自动暂停。",
      okText: isStop ? "停止" : "暂停",
      danger: isStop
    }).then(function (ok) { if (ok) run(); });
    return;
  }
  run();
}

function removeMachine(id, name, btn) {
  var key = "del:" + id;
  if (BUSY[key]) return;
  confirmDialog({
    title: "删除「" + name + "」？",
    message: "机器和它 /data 里的所有文件都会被永久删除，无法恢复。",
    okText: "删除",
    danger: true
  }).then(function (ok) {
    if (!ok) return;
    BUSY[key] = true;
    setMachineLocked(id, true);
    setBtnBusy(btn, true);
    api(machinePath(id), { method: "DELETE" })
      .then(function () {
        toast("已下发删除指令 · " + name);
        return followUp(3);
      })
      .catch(function (e) { toast("删除失败：" + e.message, true); })
      .then(function () {
        BUSY[key] = false;
        setMachineLocked(id, false);
        setBtnBusy(btn, false);
      });
  });
}

/** 保活开关：先本地切状态（即时反馈），失败再回滚 */
function toggleKa(id, enable, el) {
  var key = "ka:" + id;
  if (BUSY[key] || MACHINE_BUSY[id]) return;
  BUSY[key] = true;
  setMachineLocked(id, true);

  if (el) { el.classList.toggle("on", enable); el.disabled = true; }

  var target = findMachine(id);
  var label = target ? target.name : id;

  api(machinePath(id) + "/keepalive", {
    method: "POST",
    body: JSON.stringify({ enable: enable, name: label })
  })
    .then(function (r) {
      if (r.warning) toast(r.warning, true);
      else toast((enable ? "自动保活已开启 · " : "自动保活已关闭 · ") + label);
      return loadAll();
    })
    .catch(function (e) {
      if (el) el.classList.toggle("on", !enable);
      toast((enable ? "开启保活失败：" : "关闭保活失败：") + e.message, true);
    })
    .then(function () {
      BUSY[key] = false;
      setMachineLocked(id, false);
      if (el) el.disabled = false;
    });
}

// ---------- 事件绑定 ----------
document.addEventListener("click", function (e) {
  var tab = e.target.closest("[data-tab]");
  if (tab) { switchTab(tab.getAttribute("data-tab")); return; }

  var del = e.target.closest("[data-del]");
  if (del) { removeMachine(del.getAttribute("data-del"), del.getAttribute("data-name"), del); return; }

  var act = e.target.closest("[data-act]");
  if (act) { lifecycle(act.getAttribute("data-id"), act.getAttribute("data-act"), act); return; }

  var sw = e.target.closest("[data-toggle]");
  if (sw) { toggleKa(sw.getAttribute("data-toggle"), !sw.classList.contains("on"), sw); }
});

document.getElementById("loginBtn").addEventListener("click", login);
document.getElementById("pwd").addEventListener("keydown", function (e) {
  if (e.key === "Enter") login();
});
document.getElementById("refreshBtn").addEventListener("click", function (e) {
  var btn = e.currentTarget;
  if (btn.disabled) return;
  setBtnBusy(btn, true);
  loadAll().then(function (problems) {
    setBtnBusy(btn, false);
    if (problems && problems.length) toast("刷新完成，部分数据失败：" + problems.join("；"), true);
    else toast("已刷新 · " + DATA.machines.length + " 台机器");
  });
});

document.getElementById("logoutBtn").addEventListener("click", function () {
  logout();
  toast("已退出登录");
});

document.getElementById("clearLogsBtn").addEventListener("click", function (e) {
  var btn = e.currentTarget;
  if (btn.disabled) return;
  confirmDialog({
    title: "清空保活日志？",
    message: "只清除日志记录，机器和保活配置不受影响。",
    okText: "清空",
    danger: true
  }).then(function (ok) {
    if (!ok) return;
    setBtnBusy(btn, true);
    api("/logs", { method: "DELETE" })
      .then(function () { toast("日志已清空"); return loadAll(); })
      .catch(function (err) { toast(err.message, true); })
      .then(function () { setBtnBusy(btn, false); });
  });
});

// 只刷新已加载数据的时间显示，不额外访问 API。
setInterval(function () {
  if (AUTH && document.getElementById("mainView").style.display !== "none") render();
}, 30000);

// ---------- 启动 ----------
if (AUTH) {
  api("/auth", { method: "POST" })
    .then(showMain)
    .catch(function () { logout(); });
} else {
  showLogin();
}
</script>
</body>
</html>`;
}

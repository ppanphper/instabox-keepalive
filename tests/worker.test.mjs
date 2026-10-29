import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import worker from "../worker.js";

const env = {
  ADMIN_PASSWORD: "test-password",
  INSTABOX_API_KEY: "ibk_first",
  INSTABOX_ACCOUNTS: JSON.stringify([{ id: "second", name: "账号二", apiKey: "ibk_second" }]),
  UPSTASH_REDIS_REST_URL: "https://redis.test",
  UPSTASH_REDIS_REST_TOKEN: "redis-test-token",
};
const future = () => new Date(Date.now() + 3600000).toISOString();
const reply = (data, status = 200) => new Response(status === 204 ? null : JSON.stringify(data), { status });

function setup(t, handler, initial = {}) {
  const configs = new Map(Object.entries(initial).map(([key, value]) => [key, JSON.stringify(value)]));
  const locks = new Map(), strings = new Map(), logs = [], calls = [], fetches = [];
  let redisHook;
  t.mock.method(globalThis, "fetch", async (url, options = {}) => {
    if (!["follow", "manual"].includes(options.redirect ?? "follow")) {
      throw new TypeError('Cloudflare Workers only supports redirect "follow" or "manual"');
    }
    fetches.push({ url: String(url), options });
    if (String(url).startsWith("https://redis.test/")) {
      const commands = JSON.parse(options.body);
      if (redisHook) await redisHook(commands);
      return reply(commands.map(([command, key, ...args]) => {
        let result;
        switch (command) {
          case "HGETALL": result = Object.fromEntries(configs); break;
          case "HGET": result = configs.get(args[0]) ?? null; break;
          case "GET": result = strings.get(key) ?? null; break;
          case "HSET": configs.set(args[0], args[1]); result = 1; break;
          case "HDEL": result = args.reduce((n, field) => n + Number(configs.delete(field)), 0); break;
          case "LPUSH": logs.unshift(args[0]); result = logs.length; break;
          case "LTRIM": logs.splice(Number(args[1]) + 1); result = "OK"; break;
          case "LRANGE": result = logs.slice(Number(args[0]), Number(args[1]) + 1); break;
          case "DEL": logs.length = 0; result = 1; break;
          case "SET":
            if (args.includes("NX")) {
              result = locks.has(key) ? null : "OK";
              if (result) locks.set(key, args[0]);
            } else {
              strings.set(key, args[0]); result = "OK";
            }
            break;
          case "EVAL": {
            const [, lockKey, token] = args;
            result = locks.get(lockKey) === token ? Number(locks.delete(lockKey)) : 0;
            break;
          }
          default: throw new Error("Unexpected Redis command " + command);
        }
        return { result };
      }));
    }
    const request = { url: new URL(url), method: options.method, key: options.headers["X-API-Key"],
      body: options.body ? JSON.parse(options.body) : undefined, headers: options.headers };
    calls.push(request);
    return handler(request);
  });
  return { configs, locks, strings, logs, calls, fetches, setRedisHook: (hook) => { redisHook = hook; } };
}

async function api(path, method = "GET", body, customEnv = env) {
  return worker.fetch(new Request("https://panel.test/api" + path, {
    method, headers: { "X-Panel-Auth": "test-password", "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), customEnv);
}
const keepalive = (id = "m_one", account = "second") => "/accounts/" + account + "/machines/" + id + "/keepalive";
const detail = (state = "running", extra = {}) => reply({ id: "m_one", state, ...extra });
const lease = () => reply({ machineId: "m_one", expiresAt: future() });

test("account-specific keys, pagination and namespaced identities", async (t) => {
  const mock = setup(t, ({ key, url }) => {
    if (key === "ibk_first") return reply({ machines: [{ id: "m_one", name: "same", state: "running" }] });
    if (!url.search) return reply({ machines: [{ id: "m_one", name: "same", state: "running" }], nextCursor: "a+b/=" });
    assert.equal(url.searchParams.get("cursor"), "a+b/=");
    return reply({ machines: [{ id: "m_two", state: "stopped" }] });
  });
  const result = await (await api("/machines")).json();
  assert.deepEqual(result.machines.map((m) => m.key), ["default:m_one", "second:m_one", "second:m_two"]);
  assert.equal(result.accountCount, 2);
  assert.equal(result.intervalMinutes, 15);
  assert.equal(mock.calls.length, 3);
  assert.ok(!JSON.stringify(result).includes("ibk_"));
});

test("failed account does not hide other accounts and error messages redact keys", async (t) => {
  setup(t, ({ key }) => key === "ibk_first"
    ? reply({ error: { code: "unauthorized", message: "Bad key ibk_first" } }, 401)
    : reply({ machines: [{ id: "m_two", state: "running" }] }));
  const result = await (await api("/machines")).json();
  assert.equal(result.machines.length, 1);
  assert.equal(result.accountErrors.length, 1);
  assert.ok(!JSON.stringify(result).includes("ibk_first"));
});

test("InstaBox and Redis redirects remain visible errors without following the target", async (t) => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(options.redirect, "manual");
    assert.notEqual(new URL(url).hostname, "unexpected.test");
    calls.push(String(url));
    return new Response(null, { status: 302, headers: { Location: "https://unexpected.test/target" } });
  });
  const machines = await (await api("/machines")).json();
  assert.equal(machines.configError, "Redis HTTP 302");
  assert.equal(machines.accountErrors.length, 2);
  assert.ok(machines.accountErrors.every((e) => e.error.includes("HTTP 302")));
  const logs = await api("/logs");
  assert.equal(logs.status, 500);
  assert.match((await logs.json()).error, /Redis HTTP 302/);
  const usage = await (await api("/usage")).json();
  assert.equal(usage.accountErrors.length, 2);
  assert.ok(usage.accountErrors.every((e) => e.error.includes("HTTP 302")));
  assert.equal(calls.length, 6);
});

test("repeating pagination cursor terminates with partial results and warning", async (t) => {
  const mock = setup(t, () => reply({ machines: [{ id: "m_one" }], nextCursor: "same" }));
  const result = await (await api("/machines", "GET", undefined, { ...env, INSTABOX_ACCOUNTS: "" })).json();
  assert.equal(mock.calls.length, 2);
  assert.equal(result.machines.length, 1);
  assert.match(result.accountErrors[0].error, /游标/);
});

test("legacy configuration migrates only to default account; new record wins", async (t) => {
  const mock = setup(t, () => reply({ machines: [{ id: "m_one" }] }), {
    m_one: { keepalive: "on" }, "default:m_one": { keepalive: "off" },
  });
  const list = await (await api("/machines")).json();
  assert.equal(list.machines[0].keepalive.keepalive, "off");
  assert.equal(list.machines[1].keepalive, null);
  assert.equal((await api("/machines/m_one/keepalive", "POST", { enable: false })).status, 200);
  assert.ok(!mock.configs.has("m_one"));
  assert.ok(mock.configs.has("default:m_one"));
});

test("legacy single-key deployment still renews existing enabled machines", async (t) => {
  const mock = setup(t, ({ method }) => method === "GET" ? detail() : lease(), { m_one: { keepalive: "on" } });
  await worker.scheduled({ cron: "*/15 * * * *" }, { ...env, INSTABOX_ACCOUNTS: "" });
  assert.ok(!mock.configs.has("m_one"));
  assert.equal(JSON.parse(mock.configs.get("default:m_one")).lastStatus, "ok");
  assert.ok(mock.calls.every((c) => c.key === "ibk_first"));
});

test("cooldown prevents writes in keepalive and manual resume", async (t) => {
  const until = future();
  const mock = setup(t, () => detail("suspended", { cooldownUntil: until }));
  assert.equal((await api(keepalive(), "POST", { enable: true })).status, 200);
  const config = JSON.parse(mock.configs.get("second:m_one"));
  assert.equal(config.lastStatus, "cooldown");
  assert.equal(config.cooldownUntil, until);
  const response = await api("/accounts/second/machines/m_one/resume", "POST", {});
  assert.equal(response.status, 409);
  assert.ok(mock.calls.every((c) => c.method === "GET"));
});

test("expired cooldown resumes, confirms running and renews immediately with correct key", async (t) => {
  let reads = 0;
  const mock = setup(t, ({ method }) => {
    if (method === "GET") return reads++ ? detail() : detail("suspended", { cooldownUntil: "2020-01-01T00:00:00Z" });
    if (method === "POST") return reply({ id: "op_one" }, 202);
    return lease();
  });
  await api(keepalive(), "POST", { enable: true });
  assert.deepEqual(mock.calls.map((c) => c.method), ["GET", "POST", "GET", "PUT"]);
  assert.match(mock.calls[1].url.pathname, /\/resume$/);
  assert.ok(mock.calls[1].headers["Idempotency-Key"]);
  assert.deepEqual(mock.calls[3].body, { ttlSeconds: 3600 });
  assert.ok(mock.calls.every((c) => c.key === "ibk_second"));
  assert.equal(JSON.parse(mock.configs.get("second:m_one")).lastStatus, "ok");
});

test("stopped machine uses start, not resume", async (t) => {
  let reads = 0;
  const mock = setup(t, ({ method }) => method === "GET" ? detail(reads++ ? "running" : "stopped") : method === "POST" ? reply({}, 202) : lease());
  await api(keepalive(), "POST", { enable: true });
  assert.match(mock.calls[1].url.pathname, /\/start$/);
});

test("transitional states and pending operations never trigger lifecycle writes", async (t) => {
  let state = "starting";
  const mock = setup(t, () => detail(state, state === "running" ? { operationId: "op_pending" } : {}));
  await api(keepalive(), "POST", { enable: true });
  state = "running";
  await api(keepalive(), "POST", { enable: true });
  assert.ok(mock.calls.every((c) => c.method === "GET"));
  assert.equal(JSON.parse(mock.configs.get("second:m_one")).lastStatus, "waiting");
});

test("409 during renewal refreshes cooldown without issuing start", async (t) => {
  let reads = 0;
  const mock = setup(t, ({ method }) => method === "GET"
    ? detail("running", reads++ ? { cooldownUntil: future() } : {})
    : reply({ error: { code: "runtime_cooldown" } }, 409));
  await api(keepalive(), "POST", { enable: true });
  assert.deepEqual(mock.calls.map((c) => c.method), ["GET", "PUT", "GET"]);
  assert.equal(JSON.parse(mock.configs.get("second:m_one")).lastStatus, "cooldown");
});

test("unclassified 409 is reported as failure, not a reason to start", async (t) => {
  const mock = setup(t, ({ method }) => method === "GET" ? detail() : reply({ error: { code: "operation_conflict" } }, 409));
  const result = await (await api(keepalive(), "POST", { enable: true })).json();
  assert.match(result.warning, /operation_conflict/);
  assert.ok(!mock.calls.some((c) => c.method === "POST"));
});

test("invalid or expired lease is never marked successful", async (t) => {
  setup(t, ({ method }) => method === "GET" ? detail() : reply({ machineId: "m_one", expiresAt: "2020-01-01T00:00:00Z" }));
  const result = await (await api(keepalive(), "POST", { enable: true })).json();
  assert.match(result.warning, /租约信息异常/);
});

test("first renewal failure keeps switch enabled and preserves prior lease deadline", async (t) => {
  const expiresAt = future();
  const mock = setup(t, () => reply({ error: { code: "unavailable" } }, 503), {
    "second:m_one": { keepalive: "off", leaseExpiresAt: expiresAt },
  });
  await api(keepalive(), "POST", { enable: true });
  const saved = JSON.parse(mock.configs.get("second:m_one"));
  assert.equal(saved.keepalive, "on");
  assert.equal(saved.lastStatus, "failed");
  assert.equal(saved.leaseExpiresAt, expiresAt);
});

test("manual stop persists off before issuing request, even on ambiguous timeout", async (t) => {
  const mock = setup(t, () => {
    assert.equal(JSON.parse(mock.configs.get("second:m_one")).keepalive, "off");
    throw new TypeError("fetch failed");
  }, { "second:m_one": { keepalive: "on" } });
  assert.equal((await api("/accounts/second/machines/m_one/stop", "POST", {})).status, 502);
  assert.equal(JSON.parse(mock.configs.get("second:m_one")).keepalive, "off");
  assert.equal(mock.locks.size, 0);
});

test("failed config persistence prevents stop", async (t) => {
  const mock = setup(t, () => assert.fail("unexpected API write"), { "second:m_one": { keepalive: "on" } });
  mock.setRedisHook((commands) => { if (commands.some(([command]) => command === "HSET")) throw new Error("Redis unavailable"); });
  assert.equal((await api("/accounts/second/machines/m_one/stop", "POST", {})).status, 500);
  assert.equal(mock.calls.length, 0);
});

test("per-machine lock rejects conflicting manual operation and is released", async (t) => {
  let release, entered;
  const waiting = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const mock = setup(t, async ({ method }) => {
    if (method === "GET") { entered(); await waiting; return detail(); }
    return lease();
  });
  const first = api(keepalive(), "POST", { enable: true });
  await started;
  assert.equal((await api(keepalive(), "POST", { enable: false })).status, 409);
  release();
  assert.equal((await first).status, 200);
  assert.equal(mock.locks.size, 0);
  assert.equal((await api(keepalive(), "POST", { enable: false })).status, 200);
  assert.equal(JSON.parse(mock.configs.get("second:m_one")).keepalive, "off");
});

test("scheduled failure on one machine does not block another account", async (t) => {
  const mock = setup(t, ({ key, method }) => key === "ibk_first" ? reply({}, 403) : method === "GET" ? detail() : lease(), {
    "default:m_one": { keepalive: "on" }, "second:m_one": { keepalive: "on" }, "removed:m_one": { keepalive: "on" },
  });
  await worker.scheduled({ cron: "*/15 * * * *" }, env);
  assert.equal(JSON.parse(mock.configs.get("default:m_one")).lastStatus, "failed");
  assert.equal(JSON.parse(mock.configs.get("second:m_one")).lastStatus, "ok");
  assert.ok(mock.calls.some((c) => c.key === "ibk_second" && c.method === "PUT"));
});

test("scheduled task re-reads switch under lock rather than using stale snapshot", async (t) => {
  const mock = setup(t, () => assert.fail("disabled machine must not be contacted"), { "second:m_one": { keepalive: "on" } });
  mock.setRedisHook((commands) => {
    if (commands.some(([command]) => command === "SET")) mock.configs.set("second:m_one", JSON.stringify({ keepalive: "off" }));
  });
  await worker.scheduled({ cron: "*/15 * * * *" }, env);
  assert.equal(mock.calls.length, 0);
});

test("delete uses selected account and only removes its configuration", async (t) => {
  const mock = setup(t, () => reply(null, 204), { "default:m_one": { keepalive: "on" }, "second:m_one": { keepalive: "on" } });
  assert.equal((await api("/accounts/second/machines/m_one", "DELETE")).status, 202);
  assert.equal(mock.calls[0].key, "ibk_second");
  assert.ok(mock.configs.has("default:m_one"));
  assert.ok(!mock.configs.has("second:m_one"));
});

test("unknown accounts, invalid enable types and missing auth never reach upstream", async (t) => {
  const mock = setup(t, () => assert.fail("unexpected upstream request"));
  assert.equal((await api(keepalive("m_one", "missing"), "POST", { enable: true })).status, 404);
  assert.equal((await api(keepalive(), "POST", { enable: "false" })).status, 400);
  assert.equal((await worker.fetch(new Request("https://panel.test/api/machines"), env)).status, 401);
  assert.equal(mock.calls.length, 0);
});

test("malformed account configuration is rejected without leaking raw secrets", async () => {
  for (const value of ['[{"apiKey":"ibk_secret"}]', '[{"id":"second","apiKey":"ibk_first"}]', 'ibk_secret']) {
    const result = await api("/machines", "GET", undefined, { ...env, INSTABOX_ACCOUNTS: value });
    assert.equal(result.status, 500);
    assert.ok(!(await result.text()).includes("ibk_"));
  }
});

test("rendered browser script parses, routes by account and computes hourly cron boundaries", async () => {
  const html = await (await worker.fetch(new Request("https://panel.test/"), env)).text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  new vm.Script(script);
  const node = { style: {}, classList: { add() {}, remove() {} }, addEventListener() {}, focus() {} };
  const context = vm.createContext({
    localStorage: { getItem() { return ""; } },
    document: { getElementById() { return node; }, addEventListener() {} },
    setTimeout() {}, setInterval() {}, Intl,
    Date: class extends Date { static now() { return Date.parse("2026-10-28T10:54:00Z"); } },
  });
  vm.runInContext(script, context);
  assert.equal(vm.runInContext('CRON_MINUTES = 9; nextTickAt()', context), "2026-10-28T11:00:00.000Z");
  assert.equal(vm.runInContext('CRON_MINUTES = 15; nextTickAt("2026-10-28T11:07:00Z")', context), "2026-10-28T11:15:00.000Z");
  vm.runInContext('DATA.machines = [{key:"second:m_one", accountId:"second", id:"m_one"}]', context);
  assert.equal(vm.runInContext('machinePath("second:m_one")', context), "/accounts/second/machines/m_one");
  assert.equal(vm.runInContext('humanize("冷却至 2026-10-28T10:54:00Z")', context), "冷却至 2026-10-28 18:54:00");
});

test("accepted start is not reported as renewed while machine is still starting", async (t) => {
  let reads = 0;
  const mock = setup(t, ({ method }) => method === "GET" ? detail(reads++ ? "starting" : "stopped") : reply({}, 202));
  await api(keepalive(), "POST", { enable: true });
  const saved = JSON.parse(mock.configs.get("second:m_one"));
  assert.equal(saved.lastStatus, "waiting");
  assert.equal(saved.leaseExpiresAt, null);
  assert.ok(!mock.calls.some((c) => c.method === "PUT"));
});

test("invalid cooldown timestamp fails closed without a lifecycle request", async (t) => {
  const mock = setup(t, () => detail("suspended", { cooldownUntil: "invalid" }));
  const response = await (await api(keepalive(), "POST", { enable: true })).json();
  assert.match(response.warning, /冷却截止时间无效/);
  assert.ok(mock.calls.every((c) => c.method === "GET"));
});

test("JSON-only accounts work, but legacy routes cannot fall back to another account", async (t) => {
  const mock = setup(t, () => reply({ machines: [{ id: "m_one" }] }));
  const customEnv = { ...env, INSTABOX_API_KEY: "" };
  const response = await (await api("/machines", "GET", undefined, customEnv)).json();
  assert.equal(response.machines[0].accountId, "second");
  assert.equal(response.accountCount, 1);
  assert.equal((await api("/machines/m_one/keepalive", "POST", { enable: true }, customEnv)).status, 404);
  assert.equal(mock.calls.length, 1);
});

test("fresh deployment discovers multiple accounts from numbered Secrets without a legacy key or JSON", async (t) => {
  const mock = setup(t, ({ key }) => reply({ machines: key === "ibk_first"
    ? [{ id: "m_one", state: "running" }, { id: "m_two", state: "running" }]
    : [{ id: "m_three", state: "running" }] }));
  const configured = { ...env, INSTABOX_API_KEY: "", INSTABOX_ACCOUNTS: "",
    INSTABOX_API_KEY_1: "ibk_first", INSTABOX_API_KEY_2: "ibk_second", INSTABOX_ACCOUNT_NAME_2: "我的第二账号" };
  const result = await (await api("/machines", "GET", undefined, configured)).json();
  assert.deepEqual(result.machines.map((m) => m.key), ["1:m_one", "1:m_two", "2:m_three"]);
  assert.equal(result.machines[2].accountName, "我的第二账号");
  assert.equal(result.accountCount, 2);
  assert.ok(!JSON.stringify(result).includes("ibk_"));
  assert.deepEqual(mock.calls.map((c) => c.key), ["ibk_first", "ibk_second"]);
});

test("named Secret preserves existing account identity across key rotation", async (t) => {
  const mock = setup(t, () => detail(), { "second:m_one": { keepalive: "on" } });
  const configured = { ...env, INSTABOX_ACCOUNTS: "", INSTABOX_API_KEY_second: "ibk_rotated" };
  await api(keepalive(), "POST", { enable: false }, configured);
  assert.equal(JSON.parse(mock.configs.get("second:m_one")).keepalive, "off");
  assert.ok(!mock.configs.has("default:m_one"));
});

test("numbered Secret rejects duplicate identity/key and invalid suffix without exposing credentials", async () => {
  for (const extra of [
    { INSTABOX_API_KEY_default: "ibk_third" },
    { INSTABOX_API_KEY_2: "ibk_first" },
    { INSTABOX_API_KEY_BAD: "ibk_third" },
  ]) {
    const result = await api("/machines", "GET", undefined, { ...env, ...extra });
    assert.equal(result.status, 500);
    assert.ok(!(await result.text()).includes("ibk_"));
  }
});

function manyConfigs(count) {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [
    "default:m_" + String(index + 1).padStart(3, "0"), { keepalive: "on" },
  ]));
}

test("one Cron handles 12 machines fairly across rounds and remains below Free's 50-request limit", async (t) => {
  const mock = setup(t, ({ method, url }) => {
    const machineId = url.pathname.split("/")[3];
    return method === "GET" ? reply({ id: machineId, state: "running" }) : reply({ machineId, expiresAt: future() });
  }, manyConfigs(12));
  await worker.scheduled({ cron: "*/15 * * * *" }, env);
  assert.equal(mock.fetches.length, 41); // one initial pipeline + eight * five requests
  assert.equal(mock.calls.filter((c) => c.method === "PUT").length, 8);
  assert.equal(mock.strings.get("instabox:scheduler-cursor"), "default:m_008");
  const previous = mock.fetches.length;
  await worker.scheduled({ cron: "*/15 * * * *" }, env);
  assert.ok(mock.fetches.length - previous <= 50);
  const renewed = new Set(mock.calls.filter((c) => c.method === "PUT").map((c) => c.url.pathname.split("/")[3]));
  assert.equal(renewed.size, 12);
  assert.equal(mock.strings.get("instabox:scheduler-cursor"), "default:m_004");
  assert.ok(mock.fetches.every((f) => f.options.redirect === "manual"));
});

test("slow-start + 409 + failed persistence still fits budget and advances cursor to avoid starvation", async (t) => {
  t.mock.method(globalThis, "setTimeout", (callback) => { queueMicrotask(callback); return 0; });
  const reads = new Map();
  const mock = setup(t, ({ method, url }) => {
    const id = url.pathname.split("/")[3];
    if (method === "POST") return reply({}, 202);
    if (method === "PUT") return reply({ error: { code: "operation_conflict" } }, 409);
    const read = reads.get(id) || 0;
    reads.set(id, read + 1);
    return reply({ id, state: read === 0 ? "stopped" : read < 3 ? "starting" : "running" });
  }, manyConfigs(8));
  mock.setRedisHook((commands) => {
    if (commands.some(([command]) => command === "HSET")) throw new Error("simulated persistence failure");
  });
  await worker.scheduled({ cron: "*/15 * * * *" }, env);
  assert.equal(mock.fetches.length, 45); // initial + four * worst-case eleven requests
  assert.equal(mock.strings.get("instabox:scheduler-cursor"), "default:m_004");
  assert.equal(mock.locks.size, 0);
  assert.equal(reads.size, 4);
  const previous = mock.fetches.length;
  await worker.scheduled({ cron: "*/15 * * * *" }, env);
  assert.ok(mock.fetches.length - previous <= 50);
  assert.equal(reads.size, 8);
});

test("capacity warning explains when the conservative rotation exceeds lease headroom", async (t) => {
  setup(t, () => reply({ machines: [] }), manyConfigs(13));
  const result = await (await api("/machines")).json();
  assert.deepEqual(result.capacity, {
    enabled: 13, conservativeBatchSize: 4, estimatedCycleMinutes: 60,
    warning: "已开启 13 台保活，按当前间隔分批检查可能需要 60 分钟；建议缩短 Cron 间隔或拆分面板，为 1 小时租约留出重试时间。",
  });
});

test("cursor survives removed machines and skips accounts that no longer exist", async (t) => {
  const mock = setup(t, ({ url, method }) => {
    const id = url.pathname.split("/")[3];
    return method === "GET" ? reply({ id, state: "running" }) : reply({ machineId: id, expiresAt: future() });
  }, { ...manyConfigs(3), "removed:m_004": { keepalive: "on" } });
  mock.strings.set("instabox:scheduler-cursor", "default:m_002a");
  await worker.scheduled({ cron: "*/15 * * * *" }, env);
  assert.equal(mock.calls[0].url.pathname, "/v1/machines/m_003");
  assert.equal(mock.calls.filter((c) => c.method === "PUT").length, 3);
});

test("listing also respects configured request budget when accounts have many pages", async (t) => {
  let page = 0;
  const mock = setup(t, () => reply({ machines: [{ id: "m_one" }], nextCursor: String(++page) }));
  const result = await (await api("/machines", "GET", undefined, { ...env, INSTABOX_ACCOUNTS: "", WORKER_SUBREQUEST_LIMIT: "20" })).json();
  assert.equal(mock.fetches.length, 20);
  assert.equal(result.machines.length, 1);
  assert.match(result.accountErrors[0].error, /请求预算/);
});

test("invalid request budgets are rejected before external calls", async () => {
  for (const limit of ["0", "19", "50.5", "10001", "bad"]) {
    assert.equal((await api("/machines", "GET", undefined, { ...env, WORKER_SUBREQUEST_LIMIT: limit })).status, 500);
  }
});

test("time budget defers remaining machines and the next Cron resumes after the saved cursor", async (t) => {
  let now = Date.now(), advance = true;
  t.mock.method(Date, "now", () => now);
  const mock = setup(t, ({ method, url }) => {
    const id = url.pathname.split("/")[3];
    if (advance) { now += 4 * 60000; advance = false; }
    return method === "GET" ? reply({ id, state: "running" }) : reply({ machineId: id, expiresAt: future() });
  }, manyConfigs(3));
  await worker.scheduled({ cron: "*/15 * * * *" }, env);
  assert.equal(mock.calls.filter((c) => c.method === "PUT").length, 1);
  assert.equal(mock.strings.get("instabox:scheduler-cursor"), "default:m_001");
  const previous = mock.calls.length;
  await worker.scheduled({ cron: "*/15 * * * *" }, env);
  assert.equal(mock.calls[previous].url.pathname, "/v1/machines/m_002");
});

test("higher configured budget can process a larger batch when the platform plan permits it", async (t) => {
  const mock = setup(t, ({ method, url }) => {
    const id = url.pathname.split("/")[3];
    return method === "GET" ? reply({ id, state: "running" }) : reply({ machineId: id, expiresAt: future() });
  }, manyConfigs(36));
  await worker.scheduled({ cron: "*/15 * * * *" }, { ...env, WORKER_SUBREQUEST_LIMIT: "200" });
  assert.equal(mock.calls.filter((c) => c.method === "PUT").length, 36);
  assert.equal(mock.fetches.length, 181);
});

test("empty fresh configuration explains which Secret to add", async () => {
  const result = await api("/machines", "GET", undefined, { ...env, INSTABOX_API_KEY: "", INSTABOX_ACCOUNTS: "" });
  assert.equal(result.status, 500);
  assert.match((await result.json()).error, /INSTABOX_API_KEY_1/);
});

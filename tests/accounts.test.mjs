import { test } from 'node:test';
import assert from 'node:assert/strict';
import worker from '../worker.js';

const registryKey = 'instabox:accounts:v1';
const configKey = 'instabox:machines';
const env = { ADMIN_PASSWORD: 'test-password', INSTABOX_API_KEY: 'ibk_old',
  ACCOUNT_ENCRYPTION_KEY: 'ab'.repeat(32), UPSTASH_REDIS_REST_URL: 'https://redis.test',
  UPSTASH_REDIS_REST_TOKEN: 'test-redis' };
const reply = (value, status = 200) => Response.json(value, { status });
const machine = (orgId = 'org_new') => ({ id: 'm_one', orgId, name: 'new-machine', state: 'running', runtime: { ready: true } });

function setup(t, handler) {
  const registry = new Map(), configs = new Map(), strings = new Map(), logs = [], calls = [], commands = [];
  const hashes = new Map([[registryKey, registry], [configKey, configs]]);
  let redisFailure = false;
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.redirect, 'manual');
    if (new URL(url).hostname === 'redis.test') {
      if (redisFailure) return reply({ error: 'unavailable' }, 503);
      const batch = JSON.parse(options.body);
      commands.push(...batch);
      return reply(batch.map(([op, key, ...args]) => {
        let result;
        switch (op) {
          case 'HGETALL': result = [...hashes.get(key).entries()].flat(); break;
          case 'HGET': result = hashes.get(key).get(args[0]) ?? null; break;
          case 'HSET': hashes.get(key).set(args[0], args[1]); result = 1; break;
          case 'HDEL': result = Number(hashes.get(key).delete(args[0])); break;
          case 'GET': result = strings.get(key) ?? null; break;
          case 'SET':
            result = args.includes('NX') && strings.has(key) ? null : 'OK';
            if (result) strings.set(key, args[0]);
            break;
          case 'EVAL': {
            const [, target, field, value, max] = args;
            if (key.includes('HEXISTS')) {
              const hash = hashes.get(target);
              result = hash.has(field) ? 0 : hash.size >= Number(max) ? -1 : 1;
              if (result === 1) hash.set(field, value);
            } else {
              result = strings.get(target) === field ? Number(strings.delete(target)) : 0;
            }
            break;
          }
          case 'LPUSH': logs.unshift(args[0]); result = logs.length; break;
          case 'LTRIM': logs.splice(Number(args[1]) + 1); result = 'OK'; break;
          default: throw Error('Unexpected command ' + op);
        }
        return { result };
      }));
    }
    const call = { url: new URL(url), key: options.headers['X-API-Key'], method: options.method,
      body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(call);
    const custom = handler?.(call);
    if (custom) return custom;
    const orgId = call.key === 'ibk_old' ? 'org_old' : 'org_new';
    if (call.url.pathname === '/v1/orgs') return reply({ orgs: [{ id: orgId, name: '工作区' }] });
    if (call.url.pathname === '/v1/machines') return reply({ machines: [machine(orgId)] });
    if (call.url.pathname === '/v1/usage') return reply({ machines: 1 });
    if (call.url.pathname.endsWith('/access')) return reply({ url: 'wss://api.instabox.sh/v1/machines/m_one/terminal', token: 'iat_test_ticket' });
    if (call.url.pathname.endsWith('/activity-leases/keepalive')) return reply({ machineId: 'm_one', expiresAt: new Date(Date.now() + 3600000).toISOString() });
    if (call.method === 'GET') return reply(machine(orgId));
    return reply({ id: 'op_test' }, 202);
  });
  return { registry, configs, strings, logs, calls, commands, failRedis() { redisFailure = true; } };
}

function api(path, method = 'GET', body, settings = env, extra = {}) {
  return worker.fetch(new Request('https://panel.test/api' + path, { method,
    headers: { 'X-Panel-Auth': 'test-password', 'Content-Type': 'application/json', ...extra },
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body) }), settings);
}
const add = (body = { apiKey: 'ibk_new', name: '新账号' }, settings = env, extra) => api('/accounts', 'POST', body, settings, extra);

test('adding an account encrypts credentials, discovers all pages, and does not enable or mutate machines', async t => {
  const state = setup(t, c => c.url.pathname === '/v1/machines' && c.key === 'ibk_new'
    ? reply(c.url.search ? { machines: [{ ...machine(), id: 'm_two' }] } : { machines: [machine()], nextCursor: 'page2' }) : null);
  const response = await add();
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  const result = await response.json();
  assert.equal(result.machineCount, 2);
  assert.match(result.account.id, /^web_[a-f0-9]{24}$/);
  assert.equal(state.registry.size, 1);
  assert.equal(state.configs.size, 0);
  assert.equal(state.logs.length, 0);
  assert.ok(state.calls.every(c => c.method === 'GET'));
  const stored = [...state.registry.values()][0];
  for (const secret of ['ibk_new', '新账号', 'org_new']) assert.ok(!stored.includes(secret));
  assert.ok(!JSON.stringify(result).includes('ibk_'));
  const listing = await (await api('/machines')).json();
  assert.equal(listing.accountCount, 2);
  assert.deepEqual(listing.machines.map(m => m.accountId), ['default', result.account.id, result.account.id]);
  assert.ok(listing.machines.every(m => m.keepalive === null));
  assert.deepEqual(listing.accountErrors, []);
});

test('managed credentials route usage, terminal, lifecycle and Cron to the correct account', async t => {
  const state = setup(t);
  const { account } = await (await add()).json();
  const prefix = '/accounts/' + account.id + '/machines/m_one';
  state.calls.length = 0;
  assert.equal((await api(prefix + '/terminal', 'POST', {})).status, 200);
  assert.equal((await api(prefix + '/start', 'POST', {})).status, 202);
  assert.equal((await api(prefix + '/keepalive', 'POST', { enable: true })).status, 200);
  assert.ok(state.calls.every(c => c.key === 'ibk_new'));
  state.calls.length = 0;
  await worker.scheduled({ cron: '*/15 * * * *' }, env);
  assert.equal(state.calls.length, 2);
  assert.ok(state.calls.every(c => c.key === 'ibk_new'));
  assert.equal(JSON.parse(state.configs.get(account.id + ':m_one')).lastStatus, 'ok');
  assert.equal((await (await api('/usage')).json()).usage.machines, 2);
});

test('rejects identical keys and different keys for the same existing workspace', async t => {
  const state = setup(t, c => c.key === 'ibk_rotated' && c.url.pathname === '/v1/orgs'
    ? reply({ orgs: [{ id: 'org_old' }] }) : null);
  assert.equal((await add({ apiKey: 'ibk_old' })).status, 409);
  assert.equal(state.calls.length, 0);
  assert.equal((await add({ apiKey: 'ibk_rotated' })).status, 409);
  assert.equal(state.registry.size, 0);
  assert.equal((await add()).status, 201);
  assert.equal((await add({ apiKey: 'ibk_new_other' })).status, 409);
  assert.equal(state.registry.size, 1);
});

test('concurrent adds of the same workspace save exactly one account without replacing its key', async t => {
  const state = setup(t);
  const results = await Promise.all([add(), add({ apiKey: 'ibk_new_other' })]);
  assert.deepEqual(results.map(r => r.status).sort(), [201, 409]);
  assert.equal(state.registry.size, 1);
});

test('zero-machine accounts and a first account without legacy Secrets can be saved', async t => {
  const state = setup(t, c => c.url.pathname === '/v1/machines' ? reply({ machines: [] }) : null);
  const settings = { ...env, INSTABOX_API_KEY: '' };
  assert.equal((await (await api('/machines', 'GET', undefined, settings)).json()).accountCount, 0);
  const response = await add({ apiKey: 'ibk_new' }, settings);
  assert.equal(response.status, 201);
  assert.equal((await response.json()).machineCount, 0);
  assert.equal((await (await api('/machines', 'GET', undefined, settings)).json()).accountCount, 1);
  assert.equal(state.registry.size, 1);
});

for (const [name, handler] of [
  ['invalid key', c => c.key === 'ibk_new' ? reply({ error: { code: 'expired_key', message: 'ibk_new invalid' } }, 401) : null],
  ['missing machine permission', c => c.key === 'ibk_new' && c.url.pathname === '/v1/machines' ? reply({ error: { code: 'missing_scope' } }, 403) : null],
  ['failed second page', c => c.key === 'ibk_new' && c.url.pathname === '/v1/machines' ? c.url.search ? reply({}, 503) : reply({ machines: [machine()], nextCursor: 'next' }) : null],
  ['ambiguous workspace', c => c.key === 'ibk_new' && c.url.pathname === '/v1/orgs' ? reply({ orgs: [{ id: 'org_a' }, { id: 'org_b' }] }) : null],
  ['mixed workspace list', c => c.key === 'ibk_new' && c.url.pathname === '/v1/machines' ? reply({ machines: [machine('org_wrong')] }) : null],
]) test(name + ' is rejected without storing a credential', async t => {
  const state = setup(t, handler);
  const response = await add();
  assert.equal(response.status, 422);
  assert.ok(!(await response.text()).includes('ibk_new'));
  assert.equal(state.registry.size, 0);
  assert.equal(state.configs.size, 0);
});

test('unverifiable existing account prevents duplicate detection from being bypassed', async t => {
  const state = setup(t, c => c.key === 'ibk_old' ? reply({}, 401) : null);
  assert.equal((await add()).status, 503);
  assert.equal(state.registry.size, 0);
});

test('authentication, origin, method, content and body limits are enforced before external requests', async t => {
  const state = setup(t);
  assert.equal((await add(undefined, env, { 'X-Panel-Auth': '' })).status, 401);
  assert.equal((await add(undefined, env, { Origin: 'https://elsewhere.test' })).status, 403);
  assert.equal((await api('/accounts', 'DELETE')).status, 405);
  assert.equal((await add(undefined, env, { 'Content-Type': 'text/plain' })).status, 400);
  for (const value of [null, [], {}, { apiKey: 'bad' }, { apiKey: 'ibk_' + 'a'.repeat(300) }, { apiKey: 'ibk_new', name: 1 }, { apiKey: 'ibk_new', name: '\nBAD\u0000' }, '{bad', 'a'.repeat(2049)]) {
    assert.equal((await add(value)).status, 400);
  }
  assert.equal(state.calls.length, 0);
  assert.equal(state.commands.length, 0);
});

test('missing or invalid master key disables adds; missing key retains legacy request behavior', async t => {
  const state = setup(t);
  for (const key of ['', 'invalid']) {
    const settings = { ...env, ACCOUNT_ENCRYPTION_KEY: key };
    assert.deepEqual(await (await api('/accounts', 'GET', undefined, settings)).json(), { canAdd: false });
    assert.equal((await add(undefined, settings)).status, 503);
  }
  assert.equal(state.commands.length, 0);
  await api('/machines', 'GET', undefined, { ...env, ACCOUNT_ENCRYPTION_KEY: '' });
  assert.deepEqual(state.commands, [['HGETALL', configKey]]);
});

test('wrong master key and tampered ciphertext isolate failures and block new writes', async t => {
  const state = setup(t);
  await add();
  const settings = { ...env, ACCOUNT_ENCRYPTION_KEY: 'cd'.repeat(32) };
  const failed = await (await api('/machines', 'GET', undefined, settings)).json();
  assert.equal(failed.accountCount, 1);
  assert.equal(failed.machines[0].accountId, 'default');
  assert.equal(failed.accountErrors.length, 1);
  assert.equal((await add({ apiKey: 'ibk_another' }, settings)).status, 503);
  const [id, raw] = [...state.registry][0], envelope = JSON.parse(raw);
  envelope.ciphertext = (envelope.ciphertext[0] === 'A' ? 'B' : 'A') + envelope.ciphertext.slice(1);
  state.registry.set(id, JSON.stringify(envelope));
  assert.equal((await (await api('/usage')).json()).accountErrors.length, 1);
  assert.equal((await add({ apiKey: 'ibk_another' })).status, 503);
});

test('ciphertext cannot be moved to a different account field and healthy managed records still load', async t => {
  const state = setup(t);
  await add();
  state.registry.set('web_' + '0'.repeat(24), [...state.registry.values()][0]);
  const listing = await (await api('/machines')).json();
  assert.equal(listing.accountCount, 2);
  assert.equal(listing.accountErrors.length, 1);
});

test('Redis outage leaves static machine discovery available and refuses adds', async t => {
  const state = setup(t);
  state.failRedis();
  const listing = await (await api('/machines')).json();
  assert.equal(listing.machines[0].accountId, 'default');
  assert.equal(listing.accountErrors.length, 1);
  assert.ok(listing.configError);
  assert.equal((await add()).status, 503);
});

test('registry limits are atomic and adding accounts respects the request budget', async t => {
  const state = setup(t, c => c.url.pathname === '/v1/orgs'
    ? reply({ orgs: [{ id: 'org_' + c.key.slice(4) }] })
    : c.url.pathname === '/v1/machines' ? reply({ machines: [] }) : null);
  for (let i = 0; i < 32; i++) assert.equal((await add({ apiKey: 'ibk_n' + i })).status, 201);
  assert.equal((await add({ apiKey: 'ibk_overflow' })).status, 409);
  assert.equal(state.registry.size, 32);
});

test('repeated pagination exhausts a finite budget without saving a partial account', async t => {
  let page = 0;
  const state = setup(t, c => c.url.pathname === '/v1/machines'
    ? reply({ machines: [], nextCursor: String(++page) }) : null);
  assert.equal((await add(undefined, { ...env, WORKER_SUBREQUEST_LIMIT: '20' })).status, 422);
  assert.equal(state.registry.size, 0);
  assert.equal(state.calls.length, 19);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';
import worker from '../worker.js';

const env = { ADMIN_PASSWORD: 'test-panel', INSTABOX_API_KEY: 'ibk_first', INSTABOX_API_KEY_2: 'ibk_second' };
const endpoint = 'https://panel.test/api/accounts/2/machines/m_same/terminal';
const ticket = { url: 'wss://api.instabox.sh/v1/machines/m_same/terminal', token: 'iat_scoped_terminal_ticket', protocol: 'instabox-access.v1' };
const ok = (data, status = 200) => Response.json(data, { status });
const request = (opts = {}) => new Request(opts.url || endpoint, {
  method: opts.method || 'POST', headers: { 'X-Panel-Auth': 'test-panel', Origin: 'https://panel.test', ...opts.headers },
});

test('terminal is authenticated, POST-only, same-origin and explicitly account-scoped', async (t) => {
  let calls = 0;
  t.mock.method(globalThis, 'fetch', () => { calls++; assert.fail('must not call upstream'); });
  for (const [options, status] of [
    [{ headers: { 'X-Panel-Auth': '' } }, 401],
    [{ headers: { Origin: 'https://other.test' } }, 403],
    [{ method: 'GET' }, 405],
    [{ url: endpoint.replace('/2/', '/missing/') }, 404],
    [{ url: endpoint.replace('/accounts/2', '') }, 404],
    [{ url: endpoint.replace('m_same', 'invalid') }, 404],
  ]) {
    const response = await worker.fetch(request(options), env);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
  }
  assert.equal(calls, 0);
});

test('terminal checks running machine, uses selected key for both requests and returns only a scoped ticket', async (t) => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, options });
    assert.equal(options.headers['X-API-Key'], 'ibk_second');
    assert.equal(options.redirect, 'manual');
    if (options.method === 'GET') return ok({ id: 'm_same', state: 'running', runtime: { ready: true } });
    assert.equal(new URL(url).pathname, '/v1/machines/m_same/access');
    assert.deepEqual(JSON.parse(options.body), { kind: 'terminal', requireTicket: true });
    return ok({ ...ticket, apiKey: 'ibk_should_never_reach_browser', debug: 'discard' });
  });
  const response = await worker.fetch(request(), env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), ticket);
  assert.equal(calls.length, 2);
});

test('terminal never starts or wakes stopped, cooling, busy or unready machines', async (t) => {
  for (const machine of [
    { state: 'stopped' }, { state: 'suspended' }, { state: 'starting' },
    { state: 'running', runtime: { ready: false } }, { state: 'running', operationId: 'op_busy' },
    { state: 'running', cooldownUntil: new Date(Date.now() + 60000).toISOString() },
    { state: 'running', cooldownUntil: 'invalid' },
  ]) {
    const calls = [];
    const mock = t.mock.method(globalThis, 'fetch', async (url, options) => {
      calls.push(options.method); return ok({ id: 'm_same', ...machine });
    });
    const response = await worker.fetch(request(), env);
    assert.equal(response.status, 409, JSON.stringify(machine));
    assert.deepEqual(calls, ['GET']);
    mock.mock.restore();
  }
});

test('terminal rejects mismatched machine, missing permission and unsupported upstream response', async (t) => {
  for (const [machine, status] of [
    [{ id: 'm_other', state: 'running' }, 502],
    [{ error: { code: 'missing_scope', message: 'Key ibk_first cannot execute' } }, 403],
    [{ error: { code: 'not_found' } }, 404],
  ]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => ok(machine, machine.error ? status : 200));
    const response = await worker.fetch(request(), env);
    assert.equal(response.status, status);
    assert.ok(!(await response.text()).includes('ibk_first'));
    mock.mock.restore();
  }
});

test('terminal only accepts official secure URLs and terminal-specific tokens', async (t) => {
  const invalid = [
    { url: 'ws://api.instabox.sh/v1/machines/m_same/terminal' },
    { url: 'wss://api.instabox.sh.evil.test/v1/machines/m_same/terminal' },
    { url: 'wss://u:p@api.instabox.sh/v1/machines/m_same/terminal' },
    { url: 'wss://api.instabox.sh:444/v1/machines/m_same/terminal' },
    { url: 'wss://api.instabox.sh/v1/machines/m_other/terminal' },
    { url: ticket.url + '?token=hidden' }, { url: ticket.url + '#fragment' },
    { token: '' }, { token: 'ibk_first' }, { token: 'unsafe,protocol' }, { protocol: 'other' }, { url: 'bad' },
  ];
  for (const change of invalid) {
    const mock = t.mock.method(globalThis, 'fetch', async (_url, opts) => opts.method === 'GET'
      ? ok({ id: 'm_same', state: 'running' }) : ok({ ...ticket, ...change }));
    const response = await worker.fetch(request(), env);
    assert.equal(response.status, 502, JSON.stringify(change));
    assert.ok(!(await response.text()).includes('iat_scoped_terminal_ticket'));
    mock.mock.restore();
  }
});

test('terminal access failures preserve actionable status without returning the key', async (t) => {
  for (const status of [403, 409, 404, 302, 500]) {
    const mock = t.mock.method(globalThis, 'fetch', async (_url, opts) => opts.method === 'GET'
      ? ok({ id: 'm_same', state: 'running' })
      : ok({ error: { code: 'access_failed', message: 'Failure ibk_second' } }, status));
    const response = await worker.fetch(request(), env);
    assert.equal(response.status, [403, 409].includes(status) ? status : 502);
    const text = await response.text();
    assert.match(text, /申请终端会话失败/);
    assert.ok(!text.includes('ibk_second'));
    mock.mock.restore();
  }
});

test('browser session IDs fit the PTY contract and isolate accounts while reusing reconnect identity', async () => {
  const html = await (await worker.fetch(new Request('https://panel.test/'), env)).text();
  const script = html.match(/<script>([\s\S]*?)<\/script>/)[1];
  const node = { style: {}, classList: { add() {}, remove() {} }, addEventListener() {}, focus() {}, showModal() {} };
  const context = vm.createContext({
    crypto: webcrypto, localStorage: { getItem() { return ''; } },
    document: { getElementById() { return node; }, addEventListener() {} },
    setTimeout() {}, setInterval() {}, Intl,
  });
  vm.runInContext(script, context);
  vm.runInContext(`
    closeTerminal = function () { TERMINAL = null; };
    connectTerminal = function () {};
    DATA.machines = [
      {key:'default:m_same', id:'m_same', accountId:'default', state:'running'},
      {key:'2:m_same', id:'m_same', accountId:'2', state:'running'}
    ];
    openTerminal('default:m_same');
  `, context);
  const first = vm.runInContext('TERMINAL.session', context);
  assert.match(first, /^[a-z0-9-]{1,32}$/);
  assert.notEqual(first, 'main');
  vm.runInContext("openTerminal('default:m_same')", context);
  assert.equal(vm.runInContext('TERMINAL.session', context), first);
  vm.runInContext("openTerminal('2:m_same')", context);
  const second = vm.runInContext('TERMINAL.session', context);
  assert.match(second, /^[a-z0-9-]{1,32}$/);
  assert.notEqual(second, first);
});

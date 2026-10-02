import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHmac, generateKeyPairSync } from 'node:crypto';
import { Store } from '../local/store.js';
import http from 'node:http';

test('Local UI, CSRF, signed ingress and durable reply operate together', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'joyful-server-'));
  const store = new Store(dir);
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  await store.write('settings', { LINEWORKS_BOT_ID: 'test-bot', LINEWORKS_BOT_SECRET: 'test-secret', LINEWORKS_CLIENT_ID: 'test-client', LINEWORKS_CLIENT_SECRET: 'test-client-secret', LINEWORKS_SERVICE_ACCOUNT: 'test-service', LINEWORKS_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString(), LINEWORKS_ALLOWED_USER_IDS: 'owner' });
  const child = spawn(process.execPath, ['--import', './test/fixtures/lineworks-mock.js', 'local/server.js'], { env: { ...process.env, JOYFUL_DATA_DIR: dir, JOYFUL_ADMIN_PORT: '18877', JOYFUL_CALLBACK_PORT: '18878', TEST_DELIVERY_FILE: join(dir, 'delivered.txt') }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(async () => { child.kill(); await new Promise(resolve => { if (child.exitCode !== null) resolve(); else child.once('exit', resolve); }); await rm(dir, { recursive: true, force: true }); });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Local server startup timed out')), 10000);
    child.stdout.on('data', chunk => { if (chunk.toString().includes('設定画面')) { clearTimeout(timer); resolve(); } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Startup exited ${code}`)); });
  });
  const base = 'http://127.0.0.1:18877';
  const ui = await fetch(base);
  const html = await ui.text();
  assert.match(html, /Continue with ChatGPT/);
  assert.ok(!html.includes('test-client-secret'));
  assert.equal((await fetch(base + '/settings', { method: 'POST', headers: { Origin: base }, body: 'csrf=wrong' })).status, 403);
  const badHostStatus = await new Promise(resolve => {
    http.get(base, { headers: { Host: 'evil.invalid' } }, res => { res.resume(); resolve(res.statusCode); });
  });
  assert.equal(badHostStatus, 403);
  const url = 'http://127.0.0.1:18878/api/lineworks/callback';
  assert.equal((await fetch('http://127.0.0.1:18878/')).status, 404);
  const raw = JSON.stringify({ type: 'message', issuedTime: new Date().toISOString(), source: { userId: 'owner' }, content: { type: 'text', text: '/ping' } });
  const signature = createHmac('sha256', 'test-secret').update(raw).digest('base64');
  assert.equal((await fetch(url, { method: 'POST', body: raw, headers: { 'x-works-signature': 'bad' } })).status, 401);
  const send = () => fetch(url, { method: 'POST', body: raw, headers: { 'x-works-signature': signature, 'x-works-botid': 'test-bot' } });
  assert.equal((await send()).status, 200);
  assert.equal((await send()).status, 200);
  let delivery;
  for (let i = 0; i < 30; i++) {
    try { delivery = await readFile(join(dir, 'delivered.txt'), 'utf8'); break; } catch { await new Promise(r => setTimeout(r, 50)); }
  }
  assert.match(delivery, /pong/);
  assert.equal(delivery.trim().split('\n').length, 1);
  const state = await store.read('queue');
  assert.equal(Object.keys(state.seen).length, 1);
});

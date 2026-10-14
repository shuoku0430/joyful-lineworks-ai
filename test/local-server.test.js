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
  await store.write('settings', { LINEWORKS_BOT_ID: 'test-bot', LINEWORKS_BOT_SECRET: 'test-secret', LINEWORKS_CLIENT_ID: 'test-client', LINEWORKS_CLIENT_SECRET: 'test-client-secret', LINEWORKS_SERVICE_ACCOUNT: 'test-service', LINEWORKS_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString().replace(/\r?\n/g, ''), LINEWORKS_ALLOWED_USER_IDS: 'owner' });
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
  assert.equal(ui.headers.get('referrer-policy'), 'same-origin');
  assert.match(ui.headers.get('content-security-policy'), /form-action 'self' https:\/\/auth.openai.com/);
  assert.match(html, /Continue with ChatGPT/);
  assert.match(html, /textarea name="LINEWORKS_PRIVATE_KEY"/);
  assert.match(html, /設定・秘密鍵の形式: OK/);
  assert.ok(!html.includes('test-client-secret'));
  assert.equal((await fetch(base + '/settings', { method: 'POST', headers: { Origin: base }, body: 'csrf=wrong' })).status, 403);
  const csrf = html.match(/name="csrf" value="([^"]+)"/)[1];
  const connect = await fetch(base + '/connect', { method: 'POST', redirect: 'manual', headers: { Origin: base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ csrf }) });
  assert.equal(connect.status, 303);
  assert.equal(new URL(connect.headers.get('location')).origin, 'https://auth.openai.com');
  assert.equal(connect.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await fetch(base + '/connect', { method: 'POST', headers: { Origin: 'https://evil.invalid' }, body: new URLSearchParams({ csrf }) })).status, 403);
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
  const pairResponse = await fetch(base + '/pair', { method: 'POST', redirect: 'manual', headers: { Origin: base }, body: new URLSearchParams({ csrf }) });
  assert.equal(pairResponse.status, 303);
  const pairingHtml = await (await fetch(base)).text();
  const pairCommand = pairingHtml.match(/id="pair-code">([^<]+)<\/code>/)[1];
  const makePair = text => JSON.stringify({ type: 'message', issuedTime: new Date().toISOString(), source: { userId: 'new-owner' }, content: { type: 'text', text } });
  const signedSend = raw => fetch(url, { method: 'POST', body: raw, headers: { 'x-works-signature': createHmac('sha256', 'test-secret').update(raw).digest('base64'), 'x-works-botid': 'test-bot' } });
  await signedSend(makePair('/pair wrong-code'));
  assert.equal((await store.read('settings')).LINEWORKS_ALLOWED_USER_IDS, 'owner');
  const pairRaw = makePair(pairCommand);
  assert.equal((await signedSend(pairRaw)).status, 200);
  assert.equal((await store.read('settings')).LINEWORKS_ALLOWED_USER_IDS, 'owner,new-owner');
  assert.equal((await signedSend(pairRaw)).status, 200);
  assert.ok(!(await (await fetch(base)).text()).includes('id="pair-code"'));
  for (let i = 0; i < 30; i++) {
    delivery = await readFile(join(dir, 'delivered.txt'), 'utf8');
    if (delivery.trim().split('\n').length === 2) break;
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(delivery.trim().split('\n').length, 2);
  const diagnosticTest = await fetch(base + '/test-lineworks', { method: 'POST', headers: { Origin: base }, body: new URLSearchParams({ csrf }) });
  assert.equal(diagnosticTest.status, 200);
  assert.match(await diagnosticTest.text(), /テスト送信成功/);
  assert.match(html, /全トーク分析（20261005版）/);
  const configureReview = reviewer => fetch(base + '/monitoring-settings', { method: 'POST', redirect: 'manual', headers: { Origin: base }, body: new URLSearchParams({ csrf, enabled: '1', reviewer }) });
  assert.equal((await configureReview('stranger')).status, 400);
  assert.equal((await configureReview('owner')).status, 303);
  const historyTest = await fetch(base + '/test-monitoring', { method: 'POST', headers: { Origin: base }, body: new URLSearchParams({ csrf }) });
  assert.equal(historyTest.status, 200);
  assert.match(await historyTest.text(), /取得データ行数: 1/);
  const reviewerPairResponse = await fetch(base + '/pair-reviewer', { method: 'POST', redirect: 'manual', headers: { Origin: base }, body: new URLSearchParams({ csrf }) });
  assert.equal(reviewerPairResponse.status, 303);
  const reviewerPairHtml = await (await fetch(base)).text();
  const reviewerCommand = reviewerPairHtml.match(/id="pair-code">([^<]+)<\/code>/)[1];
  const groupRaw = JSON.stringify({ type: 'message', issuedTime: new Date().toISOString(), source: { userId: 'new-owner', channelId: 'group' }, content: { type: 'text', text: reviewerCommand } });
  assert.equal((await signedSend(groupRaw)).status, 400);
  assert.equal((await store.read('settings')).monitoringReviewer, 'owner');
  assert.equal((await signedSend(makePair(reviewerCommand))).status, 200);
  assert.equal((await store.read('settings')).monitoringReviewer, 'new-owner');
  assert.equal((await store.read('settings')).monitoringEnabled, true);
});

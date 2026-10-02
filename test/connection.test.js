import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, createHmac } from 'node:crypto';
import { generateKeyPair, SignJWT, exportJWK } from 'jose';
import { ChatGPT, consumeResponse } from '../local/chatgpt.js';
import { Store } from '../local/store.js';
import { Queue } from '../local/queue.js';
import { forwardToPC } from '../lib/relay.js';
import { POST } from '../app/api/lineworks/callback/route.js';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'joyful-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new Store(dir);
}
function stream(events, split = 3) {
  const encoded = new TextEncoder().encode(events.map(e => `data: ${JSON.stringify(e)}\r\n\r\n`).join(''));
  return new ReadableStream({ start(c) { for (let i = 0; i < encoded.length; i += split) c.enqueue(encoded.slice(i, i + split)); c.close(); } });
}

test('SSE accepts fragmented UTF8 and CRLF, and requires completed', async () => {
  assert.equal(await consumeResponse(stream([{ type: 'response.output_text.delta', delta: '日本語' }, { type: 'response.completed' }])), '日本語');
  await assert.rejects(consumeResponse(stream([{ type: 'response.output_text.delta', delta: 'partial' }])), /stream_interrupted/);
  await assert.rejects(consumeResponse(stream([{ type: 'response.output_text.delta', delta: 'partial' }, { type: 'response.failed', response: { error: { code: 'subscription_sharing_usage_limit_exceeded' } } }])), /subscription_sharing_usage_limit_exceeded/);
  await assert.rejects(consumeResponse(stream([{ type: 'response.incomplete' }])), /response.incomplete/);
});

test('OAuth persists host, uses PKCE, rejects unrelated callback without consuming transaction', async t => {
  const store = await fixture(t), client = new ChatGPT(store);
  const a = new URL(await client.authorize('http://127.0.0.1:8787/auth/callback'));
  assert.equal(a.searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(a.searchParams.get('resource'), 'https://api.openai.com/v1');
  assert.equal(a.searchParams.get('code_challenge'), createHash('sha256').update(client.pending.verifier).digest('base64url'));
  await assert.rejects(client.callback(new URLSearchParams({ state: 'wrong', code: 'x' })), /invalid_state/);
  assert.ok(client.pending);
  const b = new URL(await client.authorize('http://127.0.0.1:8787/auth/callback'));
  assert.equal(a.searchParams.get('ext_agent_host_id'), b.searchParams.get('ext_agent_host_id'));
  assert.notEqual(a.searchParams.get('state'), b.searchParams.get('state'));
});

test('Valid signed identity saves connection; wrong nonce cannot replace it', async t => {
  const store = await fixture(t), client = new ChatGPT(store);
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'test-key' };
  let nonce, clientId = 'oaiapp_test';
  const original = global.fetch;
  t.after(() => { global.fetch = original; });
  global.fetch = async url => {
    const value = String(url);
    if (value.includes('openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/jwks' });
    if (value.endsWith('/jwks')) return Response.json({ keys: [jwk] });
    const id_token = await new SignJWT({ nonce, email: 'test@example.invalid' }).setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer('https://auth.openai.com').setAudience(clientId).setSubject('test-sub').setIssuedAt().setExpirationTime('1h').sign(privateKey);
    return Response.json({ id_token, access_token: 'test-access', refresh_token: 'test-refresh', token_type: 'Bearer', expires_in: 3600, scope: 'openid offline_access chatgpt.tokens.use.direct' });
  };
  const a = new URL(await client.authorize('http://127.0.0.1:8787/auth/callback'));
  nonce = client.pending.nonce;
  await client.callback(new URLSearchParams({ state: a.searchParams.get('state'), code: 'test-code', client_id: clientId }));
  assert.equal((await client.status()).sharing, true);
  const b = new URL(await client.authorize('http://127.0.0.1:8787/auth/callback'));
  assert.equal(b.searchParams.get('client_id'), clientId);
  assert.equal(b.searchParams.get('agent_name_hint'), null);
  nonce = 'wrong-nonce';
  await assert.rejects(client.callback(new URLSearchParams({ state: b.searchParams.get('state'), code: 'x' })), /invalid_identity/);
  assert.equal((await store.read('auth')).subject, 'test-sub');
});

test('Concurrent refresh is serialized, rotated token and unchanged scopes persist', async t => {
  const store = await fixture(t), client = new ChatGPT(store);
  await store.write('auth', { access_token: 'old', refresh_token: 'refresh1', client_id: 'issued', expires_at: 0, scopes: ['chatgpt.tokens.use.direct'] });
  const original = global.fetch; t.after(() => { global.fetch = original; });
  let calls = 0;
  global.fetch = async (url, opts) => {
    calls++;
    assert.equal(opts.body.get('client_id'), 'issued');
    assert.equal(opts.body.get('scope'), null);
    await new Promise(r => setTimeout(r, 20));
    return Response.json({ access_token: 'new', refresh_token: 'refresh2', token_type: 'Bearer', expires_in: 3600 });
  };
  assert.deepEqual(await Promise.all([client.accessToken(), client.accessToken()]), ['new', 'new']);
  assert.equal(calls, 1);
  assert.equal((await store.read('auth')).refresh_token, 'refresh2');
});

test('Plan requests do not use API key and omit unsupported request fields', async t => {
  const store = await fixture(t), client = new ChatGPT(store);
  await store.write('auth', { access_token: 'oauth-test', expires_at: Date.now() + 3600000, scopes: ['chatgpt.tokens.use.direct'] });
  const original = global.fetch; t.after(() => { global.fetch = original; });
  global.fetch = async (url, opts) => {
    assert.equal(String(url), 'https://api.openai.com/v1/responses');
    assert.equal(opts.headers.Authorization, 'Bearer oauth-test');
    assert.deepEqual(JSON.parse(opts.body), { model: 'allowed-model', instructions: 'short', input: [{ role: 'user', content: 'hello' }], store: false, stream: true });
    return new Response(stream([{ type: 'response.output_text.delta', delta: 'ok' }, { type: 'response.completed' }]));
  };
  assert.equal(await client.ask('hello', 'allowed-model', 'short'), 'ok');
  await store.write('auth', { access_token: 'oauth-test', expires_at: Date.now() + 3600000, scopes: [] });
  await assert.rejects(client.ask('hello', 'allowed-model'), /plan_permission_required/);
});

test('Queue persists before ACK, deduplicates concurrent arrivals and avoids replay on restart', async t => {
  const store = await fixture(t), queue = new Queue(store);
  const event = { type: 'message', content: { text: 'hi' } };
  const accepted = await Promise.all(Array.from({ length: 10 }, () => queue.enqueue('same-event', event)));
  assert.equal(accepted.filter(Boolean).length, 1);
  const job = await queue.next();
  const restarted = new Queue(store);
  await restarted.recover();
  assert.equal(await restarted.next(), null);
  assert.equal(await restarted.enqueue('same-event', event), false);
  assert.ok((await store.read('queue')).jobs.every(j => !j.event));
  assert.ok(job.id);
  if (process.platform !== 'win32') assert.equal((await stat(join(store.dir, 'queue.json'))).mode & 0o777, 0o600);
});

test('Relay preserves exact signed payload and refuses redirect / non-HTTPS URL', async t => {
  const previous = process.env.PC_CALLBACK_URL;
  t.after(() => { if (previous === undefined) delete process.env.PC_CALLBACK_URL; else process.env.PC_CALLBACK_URL = previous; });
  process.env.PC_CALLBACK_URL = 'https://example.invalid/api/lineworks/callback';
  await forwardToPC(' {"a":1}', 'signature', 'bot', async (url, opts) => {
    assert.equal(opts.body, ' {"a":1}'); assert.equal(opts.headers['x-works-signature'], 'signature'); assert.equal(opts.redirect, 'error');
    return new Response(null, { status: 200 });
  });
  await assert.rejects(forwardToPC('x', 'sig', 'bot', async () => new Response(null, { status: 302 })), /unavailable/);
  process.env.PC_CALLBACK_URL = 'http://example.invalid/api/lineworks/callback';
  await assert.rejects(forwardToPC('x', 'sig', 'bot'), /Invalid PC/);
});

test('Cloud callback rejects invalid signature before any network request', async t => {
  const old = global.fetch; t.after(() => { global.fetch = old; });
  global.fetch = () => { throw new Error('network must not be used'); };
  process.env.LINEWORKS_BOT_SECRET = 'test-secret';
  const req = new Request('https://example.invalid/api/lineworks/callback', { method: 'POST', body: '{}', headers: { 'x-works-signature': 'invalid' } });
  assert.equal((await POST(req)).status, 401);
});

test('Cloud PC mode sends only signed callback to PC and never invokes paid API', async t => {
  const old = global.fetch; t.after(() => { global.fetch = old; });
  process.env.AI_PROVIDER = 'chatgpt-pc';
  process.env.PC_CALLBACK_URL = 'https://example.invalid/api/lineworks/callback';
  process.env.LINEWORKS_BOT_SECRET = 'test-secret';
  process.env.LINEWORKS_BOT_ID = 'bot';
  const raw = JSON.stringify({ type: 'message', content: { type: 'text', text: 'hello' }, source: { userId: 'owner' } });
  const sig = createHmac('sha256', 'test-secret').update(raw).digest('base64');
  let calls = 0;
  global.fetch = async url => { assert.equal(String(url), process.env.PC_CALLBACK_URL); calls++; return new Response(null, { status: 200 }); };
  const req = new Request('https://example.invalid', { method: 'POST', body: raw, headers: { 'x-works-signature': sig, 'x-works-botid': 'bot' } });
  assert.equal((await POST(req)).status, 200); assert.equal(calls, 1);
});

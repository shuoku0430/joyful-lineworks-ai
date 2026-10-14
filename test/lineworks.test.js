import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { normalizePrivateKey, getLineWorksAccessToken, clearLineWorksTokenCache } from '../lib/lineworks.js';

test('PEM pasted into one-line inputs is restored without changing its key', () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  for (const pasted of [pem, pem.replace(/\n/g, ''), pem.replace(/\n/g, '\\n')]) {
    const key = crypto.createPrivateKey(normalizePrivateKey(pasted));
    const signature = crypto.sign('RSA-SHA256', Buffer.from('test'), key);
    assert.ok(crypto.verify('RSA-SHA256', Buffer.from('test'), publicKey, signature));
  }
  assert.throws(() => normalizePrivateKey('not-a-key'), /PRIVATE_KEY_FORMAT/);
});

test('LINE WORKS failures expose only phase and HTTP status, with bounded fetch', async t => {
  const previous = global.fetch; t.after(() => { global.fetch = previous; clearLineWorksTokenCache(); });
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  Object.assign(process.env, { LINEWORKS_CLIENT_ID: 'test-id', LINEWORKS_CLIENT_SECRET: 'test-secret', LINEWORKS_SERVICE_ACCOUNT: 'test-account', LINEWORKS_PRIVATE_KEY: privateKey.export({ format: 'pem', type: 'pkcs8' }).toString() });
  global.fetch = async (url, options) => {
    assert.ok(options.signal);
    return Response.json({ error: 'echoed-private-information' }, { status: 401 });
  };
  clearLineWorksTokenCache();
  await assert.rejects(getLineWorksAccessToken(), e => e.code === 'TOKEN_HTTP_ERROR' && e.status === 401 && !e.message.includes('echoed-private'));
});

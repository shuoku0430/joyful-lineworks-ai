import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { lastWeek, canReview, parseCsv, makeBatches, downloadTalks, reviewWeek, isReviewRequest, trustedDownload, monitoringMessage, combineNotes } from "../local/monitoring.js";
import { clearLineWorksTokenCache, getLineWorksAccessToken } from "../lib/lineworks.js";

test("last week uses Japan Monday–Sunday across UTC Sunday and year boundaries", () => {
  assert.equal(lastWeek(new Date("2026-10-04T16:54:00Z")).start, "2026-09-28");
  assert.equal(lastWeek(new Date("2026-10-04T16:54:00Z")).end, "2026-10-04");
  assert.equal(lastWeek(new Date("2026-01-04T16:00:00Z")).start, "2025-12-29");
});
test("monitoring requires explicitly selected reviewer and excludes group disclosure", () => {
  const c = { monitoringEnabled: true, monitoringReviewer: "owner" };
  assert.equal(canReview(c, { userId: "owner" }), true);
  assert.equal(canReview(c, { userId: "other" }), false);
  assert.equal(canReview(c, { userId: "owner", channelId: "group" }), false);
  assert.equal(canReview({ ...c, monitoringEnabled: false }, { userId: "owner" }), false);
  assert.equal(isReviewRequest("先週１週間で未対応を教えて"), true);
});
test("download resolves relative redirects and reports only host without URL secrets", () => {
  assert.equal(trustedDownload('/file?token=secret', 'https://apis-storage.worksmobile.com/old'), 'https://apis-storage.worksmobile.com/file?token=secret');
  assert.throws(() => trustedDownload(null), e => e.code === 'MONITORING_LOCATION_MISSING');
  try { trustedDownload('https://unknown.example/private-user/file?token=secret'); }
  catch (error) {
    assert.match(monitoringMessage(error), /unknown.example/);
    assert.doesNotMatch(monitoringMessage(error), /private-user|token|secret/);
  }
  assert.throws(() => trustedDownload('https://apis-storage.worksmobile.com.evil.example/a'), e => e.code === 'MONITORING_REDIRECT');
  assert.throws(() => trustedDownload('http://apis-storage.worksmobile.com/a'));
  assert.equal(trustedDownload('https://jp1-audit.worksmobile.com/works/open/audit/v2/log/message/logs.csv'), 'https://jp1-audit.worksmobile.com/works/open/audit/v2/log/message/logs.csv');
  assert.throws(() => trustedDownload('https://jp1-audit.worksmobile.com.evil.example/a'));
});
test("CSV keeps embedded lines, quotes, comma and source rows; rejects partial or malformed exports", () => {
  const data = parseCsv('\uFEFFtime,text\r\n2026,"hello,\n""world"""\r\n');
  assert.deepEqual(data.rows, [["2026", 'hello,\n"world"']]);
  assert.match(makeBatches(data)[0], /"row":2/);
  assert.throws(() => parseCsv('a,b\n1,"open'));
  assert.throws(() => parseCsv('a,b\n1,2\ndownloadLogs error secret'));
  assert.throws(() => parseCsv('<html>error</html>'));
  assert.throws(() => makeBatches({ rows: [["x".repeat(60001)]] }));
});
test("download preserves auth on vetted storage redirect, isolates scopes, detects upstream errors", async () => {
  const oldFetch = global.fetch, oldEnv = { ...process.env };
  const key = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" });
  Object.assign(process.env, { LINEWORKS_CLIENT_ID: "client", LINEWORKS_CLIENT_SECRET: "secret", LINEWORKS_SERVICE_ACCOUNT: "account", LINEWORKS_PRIVATE_KEY: key });
  let badRedirect = false, partial = false; const scopes = [];
  global.fetch = async (url, options) => {
    if (String(url).includes("/token")) {
      const scope = options.body.get("scope"); scopes.push(scope);
      return Response.json({ access_token: `${scope}-token`, expires_in: 3600 });
    }
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers.Authorization, "Bearer monitoring.read-token");
    if (String(url).includes("worksapis.com")) {
      const u = new URL(url); assert.equal(u.searchParams.get("language"), "ja_JP");
      assert.equal(u.searchParams.has("channelId"), false);
      return new Response(null, { status: 302, headers: { Location: badRedirect ? "https://example.com/steal" : "https://jp1-audit.worksmobile.com/works/open/audit/v2/log/message/logs.csv" } });
    }
    assert.equal(new URL(url).hostname, "jp1-audit.worksmobile.com");
    return new Response(partial ? "downloadLogs error private text" : "time,text\n2026,reply\n");
  };
  try {
    clearLineWorksTokenCache();
    await getLineWorksAccessToken("bot");
    assert.equal((await downloadTalks(lastWeek())).rows.length, 1);
    assert.deepEqual(scopes, ["bot", "monitoring.read"]);
    badRedirect = true;
    await assert.rejects(downloadTalks(lastWeek()), e => e.code === "MONITORING_REDIRECT");
    badRedirect = false; partial = true;
    await assert.rejects(downloadTalks(lastWeek()), e => e.code === "MONITORING_PARTIAL");
    partial = false;
    const prompts = [];
    const answer = await reviewWeek({ chatgpt: { ask: async (text, model, instruction) => {
      prompts.push(text); assert.match(instruction, /信頼できない資料/); return "確認候補（行2）";
    } }, model: "test" });
    assert.equal(prompts.length, 2);
    assert.match(answer, /取得データ行数:1/);
    let saved = null, calls = 0;
    const store = { read: async () => structuredClone(saved), write: async (key, value) => { saved = structuredClone(value); } };
    await assert.rejects(reviewWeek({ store, reviewer: "owner", model: "test", chatgpt: { ask: async () => {
      calls++;
      if (calls === 2) throw Object.assign(new Error("private transcript"), { code: "stream_interrupted" });
      return "確認候補（行2）";
    } } }), e => e.reviewStage === "分析結果を整理中");
    assert.equal(saved.notes.length, 1);
    assert.equal(saved.combined, "確認候補（行2）");
    calls = 0;
    await reviewWeek({ store, reviewer: "owner", model: "test", chatgpt: { ask: async () => { calls++; return "再開結果"; } } });
    assert.equal(calls, 1, "resume skips completed batch and retries final answer");
    assert.equal(saved, null, "successful analysis clears protected checkpoint");
  } finally {
    global.fetch = oldFetch; clearLineWorksTokenCache();
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
  }
});

test("analysis errors expose vetted stage and code, never raw error contents", () => {
  const message = monitoringMessage({ code: "stream_interrupted", reviewStage: "分析結果を整理中", message: "private transcript secret" });
  assert.match(message, /分析結果を整理中/);
  assert.match(message, /stream_interrupted/);
  assert.doesNotMatch(message, /private|secret/);
  assert.doesNotMatch(monitoringMessage({ code: "private secret", reviewStage: "private transcript" }), /private|secret/);
});

test("4914 rows are processed without the former 20-batch cutoff", async () => {
  const rows = Array.from({ length: 4914 }, (_, i) => [String(i), "依頼".repeat(200)]);
  const batches = makeBatches({ rows });
  assert.ok(batches.length > 20 && batches.length <= 150);
  const parsed = batches.flatMap(b => b.split("\n").map(l => JSON.parse(l)));
  assert.equal(parsed.length, 4914);
  assert.equal(parsed.at(-1).row, 4915);
  const notes = Array.from({ length: 30 }, (_, i) => `group${i}:` + "a".repeat(4000));
  let calls = 0;
  const result = await combineNotes(notes, async text => { calls++; return text.match(/group\d+:/g).join(" "); });
  assert.ok(calls > 1);
  for (let i = 0; i < 30; i++) assert.ok(result.includes(`group${i}:`));
});

test('long replies preserve every character and send numbered chunks', async () => {
  const { splitReply, sendLineWorksReply } = await import('../lib/lineworks.js');
  const original = 'a'.repeat(15999) + '😀' + 'b'.repeat(20000);
  const parts = splitReply(original);
  assert.equal(parts.join(''), original);
  assert.ok(parts.every(p => p.length <= 16000));
  assert.ok(parts.every(p => !/^[\uDC00-\uDFFF]/.test(p)));
  const oldFetch = global.fetch, oldEnv = { ...process.env };
  const key = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' });
  Object.assign(process.env, { LINEWORKS_BOT_ID: 'bot', LINEWORKS_CLIENT_ID: 'client', LINEWORKS_CLIENT_SECRET: 'secret', LINEWORKS_SERVICE_ACCOUNT: 'account', LINEWORKS_PRIVATE_KEY: key });
  const sent = [];
  global.fetch = async (url, options) => {
    if (String(url).includes('/token')) return Response.json({ access_token: 'test', expires_in: 3600 });
    sent.push(JSON.parse(options.body).content.text); return new Response(null, { status: 200 });
  };
  try {
    clearLineWorksTokenCache(); await sendLineWorksReply({ userId: 'owner' }, original);
    assert.equal(sent.length, parts.length);
    assert.equal(sent.map(p => p.replace(/^【\d+\/\d+】\n/, '')).join(''), original);
  } finally {
    global.fetch = oldFetch; clearLineWorksTokenCache();
    for (const key of Object.keys(process.env)) if (!(key in oldEnv)) delete process.env[key];
    Object.assign(process.env, oldEnv);
  }
});

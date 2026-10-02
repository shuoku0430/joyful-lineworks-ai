import http from "node:http";
import { randomBytes } from "node:crypto";
import { Store } from "./store.js";
import { ChatGPT, USAGE_URL } from "./chatgpt.js";
import { Queue } from "./queue.js";
import { verifyLineWorksSignature, sendLineWorksReply } from "../lib/lineworks.js";
import { DEFAULT_SYSTEM_PROMPT } from "../lib/openai.js";

const store = new Store(), chatgpt = new ChatGPT(store), queue = new Queue(store);
const csrf = randomBytes(32).toString("hex");
const port = Number(process.env.JOYFUL_ADMIN_PORT || 8787);
const ingressPort = Number(process.env.JOYFUL_CALLBACK_PORT || 8788);
const origin = `http://127.0.0.1:${port}`;
const keys = ["LINEWORKS_BOT_ID", "LINEWORKS_BOT_SECRET", "LINEWORKS_CLIENT_ID", "LINEWORKS_CLIENT_SECRET", "LINEWORKS_SERVICE_ACCOUNT", "LINEWORKS_PRIVATE_KEY", "LINEWORKS_ALLOWED_USER_IDS"];
let config = await store.read("settings", {}), busy = false;
for (const key of keys) if (config[key]) process.env[key] = config[key];
const escape = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const form = (path, label, extra = "") => `<form method="post" action="${path}"><input type="hidden" name="csrf" value="${csrf}">${extra}<button>${label}</button></form>`;
const respond = (res, status, body, type = "text/plain; charset=utf-8") => {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'" }); res.end(body);
};
async function body(req) {
  let result = "";
  for await (const chunk of req) { result += chunk; if (Buffer.byteLength(result) > 65536) throw new Error("body_too_large"); }
  return result;
}
function message(error) {
  const code = error.code || error.message;
  if (["subscription_sharing_usage_limit_exceeded", "subscription_sharing_usage_unavailable", "http_429"].includes(code))
    return "ChatGPTの利用枠が上限に達したか、現在利用できません。ChatGPTの設定→使用状況を確認し、時間を置いてお試しください。有料APIへの切替は行いません。";
  if (["sign_in_required", "invalid_grant", "http_401", "plan_permission_required"].includes(code))
    return "PCの設定画面からChatGPTに再接続し、ChatGPT利用枠の許可を確認してください。";
  return "応答を完了できませんでした。PCの接続状態を確認し、もう一度お試しください。";
}
async function work() {
  if (busy) return;
  busy = true;
  try {
    let job;
    while ((job = await queue.next())) {
      try {
        if (!job.answer) {
          let answer;
          const text = job.event.content?.text?.trim() || "";
          if (job.event.content?.type !== "text") answer = "現在はテキストのみ対応しています。";
          else if (["/ping", "ping"].includes(text.toLowerCase())) answer = "pong / PCは稼働中です。";
          else if (["/help", "help", "ヘルプ"].includes(text.toLowerCase())) answer = "ジョイフルAIです。ChatGPTの利用枠で回答します。PCとトンネルの起動が必要です。現在は各質問を独立して処理します。";
          else {
            try {
              if (!config.model) throw new Error("model_required");
              answer = await chatgpt.ask(text.slice(0, 12000), config.model, DEFAULT_SYSTEM_PROMPT);
            } catch (e) { answer = message(e); console.error("AI request failed (details redacted)"); }
          }
          await queue.answer(job.id, answer);
          job.answer = answer;
        }
        // Persist the delivery phase before sending, including after inference.
        await queue.transact(d => { d.jobs.find(j => j.id === job.id).status = "delivering"; });
        await sendLineWorksReply(job.event.source, job.answer);
        await queue.finish(job.id);
      } catch { await queue.fail(job.id); console.error("LINE WORKS delivery outcome uncertain; automatic retry disabled"); }
    }
  } finally { busy = false; }
}
const admin = http.createServer(async (req, res) => {
  try {
    if (req.headers.host !== `127.0.0.1:${port}`) return respond(res, 403, "Invalid host");
    const url = new URL(req.url, origin);
    if (url.origin !== origin) return respond(res, 403, "Invalid origin");
    if (req.method === "GET" && url.pathname === "/auth/callback") {
      try { await chatgpt.callback(url.searchParams); respond(res, 200, `<!doctype html><meta charset="utf-8"><p>ChatGPT接続を保存しました。</p><a href="/">設定画面に戻る</a>`, "text/html; charset=utf-8"); }
      catch { respond(res, 400, "認証を完了できませんでした。設定画面から再接続してください。"); }
      return;
    }
    if (req.method === "POST") {
      const p = new URLSearchParams(await body(req));
      if (req.headers.origin !== origin || p.get("csrf") !== csrf) return respond(res, 403, "Invalid request");
      if (url.pathname === "/connect") {
        const authUrl = await chatgpt.authorize(`${origin}/auth/callback`, p.get("new") === "1");
        res.writeHead(303, { Location: authUrl, "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }); res.end(); return;
      }
      if (url.pathname === "/settings") {
        for (const key of keys) { const v = p.get(key)?.trim(); if (v) { config[key] = v; process.env[key] = v; } }
        await store.write("settings", config);
      } else if (url.pathname === "/model") {
        const models = await chatgpt.models();
        if (!models.some(m => m.slug === p.get("model"))) return respond(res, 400, "Model unavailable");
        config.model = p.get("model"); await store.write("settings", config);
      } else if (url.pathname === "/verify") {
        if (!config.model) return respond(res, 400, "設定画面でモデルを選択してください。");
        const answer = await chatgpt.ask("Reply with exactly: ChatGPT plan connection works.", config.model);
        return respond(res, 200, `検証完了（response.completed受信）: ${answer}`);
      } else if (url.pathname === "/logout") {
        const revoked = await chatgpt.logout();
        return respond(res, 200, revoked ? "接続解除しました。" : "PC側の接続を解除しました。遠隔の解除は確認できていません。ChatGPTの設定からアプリを解除してください。");
      } else return respond(res, 404, "Not found");
      res.writeHead(303, { Location: "/", "Cache-Control": "no-store" }); res.end(); return;
    }
    if (req.method !== "GET" || url.pathname !== "/") return respond(res, 404, "Not found");
    const status = await chatgpt.status();
    let models = [], modelError = "";
    if (status.sharing) try { models = await chatgpt.models(); } catch { modelError = "モデル一覧を取得できません。再接続してお試しください。"; }
    const fields = keys.map(k => `<label>${k} ${config[k] ? "（保存済み・空欄で保持）" : ""}<input name="${k}" type="${k.includes("SECRET") || k.includes("PRIVATE") ? "password" : "text"}" autocomplete="off"></label>`).join("");
    const options = models.map(m => `<option value="${escape(m.slug)}" ${config.model === m.slug ? "selected" : ""}>${escape(m.name)}</option>`).join("");
    const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><title>ジョイフルAI PC設定</title><style>body{font:16px system-ui;max-width:800px;margin:40px auto;padding:20px;background:#f5f7fa;color:#13233d}form{background:white;padding:20px;border-radius:12px;margin:16px 0}label{display:block;margin:12px 0}input{display:block;width:95%;padding:8px}button,select{padding:10px;margin:5px}a{color:#175db3}</style><h1>ジョイフルAI PC設定</h1><p>ChatGPT利用枠を使用。有料APIへの自動切替はありません。</p><p>${escape(status.email)} / ${status.connected ? "接続済み" : "未接続"} / 利用枠: ${status.sharing ? "許可済み" : "未許可"}</p>${form("/connect", "Continue with ChatGPT")}${form("/connect", "別のアカウントを接続（現在の接続を置換）", '<input type="hidden" name="new" value="1">')}<p><a href="${USAGE_URL}" target="_blank" rel="noreferrer">ChatGPTの使用状況・アプリ上限を管理</a>。追加課金を使わないため、認証・使用状況画面でクレジット利用を許可せず、利用上限を設定してください。</p><p>${escape(modelError)}</p>${form("/model", "モデル保存", `<select name="model">${options}</select>`)}${form("/verify", "ChatGPT利用枠で応答テスト")}${form("/settings", "LINE WORKS設定をPCに保存", `<p>秘密情報はこの画面に入力してください。許可するLINE WORKSユーザーIDをカンマ区切りで指定します。未指定ならBotは返信しません。</p>${fields}`)}${form("/logout", "接続を解除")}<p>管理画面: ${origin}（公開しない）<br>Callback受信: http://127.0.0.1:${ingressPort}/api/lineworks/callback</p><p>PC・トンネル停止中は受付できません。会話履歴、Gmail・Drive検索は未対応です。</p></html>`;
    respond(res, 200, html, "text/html; charset=utf-8");
  } catch (e) { respond(res, 400, message(e)); }
});
const ingress = http.createServer(async (req, res) => {
  try {
    if (req.method !== "POST" || req.url !== "/api/lineworks/callback") return respond(res, 404, "Not found");
    const raw = await body(req);
    if (!verifyLineWorksSignature(raw, req.headers["x-works-signature"])) return respond(res, 401, "Invalid signature");
    if (req.headers["x-works-botid"] && req.headers["x-works-botid"] !== process.env.LINEWORKS_BOT_ID) return respond(res, 401, "Invalid bot id");
    const event = JSON.parse(raw);
    if (event.type !== "message") return respond(res, 200, "");
    const allowed = String(config.LINEWORKS_ALLOWED_USER_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
    if (!allowed.includes(event.source?.userId)) return respond(res, 200, "");
    if (!event.source?.userId || (event.content?.type === "text" && !event.content.text?.trim())) return respond(res, 200, "");
    // Reject old signed events when LINE WORKS supplies its issuedTime field.
    if (event.issuedTime !== undefined) {
      const timestamp = typeof event.issuedTime === "number" ? event.issuedTime : Date.parse(event.issuedTime);
      if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 10 * 60000) return respond(res, 400, "Stale event");
    }
    await queue.enqueue(raw, event);
    respond(res, 200, "");
    void work().catch(() => console.error("Local queue unavailable"));
  } catch { respond(res, 503, "PC not ready"); }
});
async function listen(server, number) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(number, "127.0.0.1", resolve); });
}
// Bind ports before touching queue recovery to reject a second local process.
try { await listen(admin, port); await listen(ingress, ingressPort); }
catch { console.error("ポートを使用できません。二重起動を確認してください。"); process.exit(1); }
await queue.recover();
console.log(`設定画面を開いてください: ${origin}`);
console.log(`Callback受信ポート: ${ingressPort}（このポートのみトンネルで公開）`);
setInterval(() => { void work().catch(() => console.error("Local queue unavailable")); }, 2000);
void work().catch(() => console.error("Local queue unavailable"));

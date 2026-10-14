import http from "node:http";
import { randomBytes } from "node:crypto";
import { Store } from "./store.js";
import { ChatGPT, USAGE_URL } from "./chatgpt.js";
import { canReview, isReviewRequest, reviewWeek, monitoringMessage, reviewAccessMessage } from "./monitoring.js";
import { Queue } from "./queue.js";
import { verifyLineWorksSignature, sendLineWorksReply, validateLineWorksConfiguration, getLineWorksAccessToken, clearLineWorksTokenCache } from "../lib/lineworks.js";
import { DEFAULT_SYSTEM_PROMPT } from "../lib/openai.js";

const store = new Store(), chatgpt = new ChatGPT(store), queue = new Queue(store);
const csrf = randomBytes(32).toString("hex");
const port = Number(process.env.JOYFUL_ADMIN_PORT || 8787);
const ingressPort = Number(process.env.JOYFUL_CALLBACK_PORT || 8788);
const origin = `http://127.0.0.1:${port}`;
const keys = ["LINEWORKS_BOT_ID", "LINEWORKS_BOT_SECRET", "LINEWORKS_CLIENT_ID", "LINEWORKS_CLIENT_SECRET", "LINEWORKS_SERVICE_ACCOUNT", "LINEWORKS_PRIVATE_KEY", "LINEWORKS_ALLOWED_USER_IDS"];
let config = await store.read("settings", {}), busy = false, pairing = null;
const diagnostics = { received: null, accepted: null, replied: null, stage: "待機中", lastError: "" };
function lineWorksDiagnostic(error) {
  const code = error.code || "";
  if (/^MISSING_LINEWORKS_[A-Z_]+$/.test(code)) return `未設定: ${code.slice(8)}`;
  if (code === "PRIVATE_KEY_FORMAT") return "秘密鍵の形式を読み取れません。秘密鍵ファイル全体を貼り直してください。";
  if (code === "TOKEN_HTTP_ERROR") return `LINE WORKS認証エラー HTTP ${error.status}。Client ID・Client Secret・Service Account・秘密鍵・botのScopeを確認してください。`;
  if (code === "REPLY_HTTP_ERROR") return `LINE WORKS返信エラー HTTP ${error.status}。Bot IDとアプリのbot権限を確認してください。`;
  if (["TimeoutError", "AbortError"].includes(error.name)) return "LINE WORKSへの接続がタイムアウトしました。PCのインターネット接続を確認してください。";
  return "LINE WORKSへの接続またはPC保存処理に失敗しました。設定とネットワーク接続を確認してください。";
}
function diagnose(text) { diagnostics.lastError = text; console.error(text); }
for (const key of keys) if (config[key]) process.env[key] = config[key];
const escape = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const form = (path, label, extra = "") => `<form method="post" action="${path}"><input type="hidden" name="csrf" value="${csrf}">${extra}<button>${label}</button></form>`;
const respond = (res, status, body, type = "text/plain; charset=utf-8", referrerPolicy = "no-referrer") => {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": referrerPolicy, "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' https://auth.openai.com; frame-ancestors 'none'; base-uri 'none'" }); res.end(body);
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
        diagnostics.stage = "質問を処理中";
        if (!job.answer) {
          let answer;
          const text = job.event.content?.text?.trim() || "";
          if (job.event.content?.type !== "text") answer = "現在はテキストのみ対応しています。";
          else if (text.startsWith("/pair ")) answer = "ご本人のユーザーIDを登録しました。続けて /ping または質問を送ってください。";
          else if (["/ping", "ping"].includes(text.toLowerCase())) answer = "pong / PCは稼働中です。";
          else if (isReviewRequest(text)) {
            if (!canReview(config, job.event.source)) answer = reviewAccessMessage(config, job.event.source);
            else if (!config.model) answer = "PC設定画面でモデルを保存してください。";
            else {
              try { answer = await reviewWeek({ chatgpt, model: config.model, store, reviewer: config.monitoringReviewer, progress: stage => { diagnostics.stage = stage; } }); }
              catch (error) { answer = monitoringMessage(error); }
            }
          }
          else if (["/help", "help", "ヘルプ"].includes(text.toLowerCase())) answer = "ジョイフルAIです。ChatGPTの利用枠で回答します。PCとトンネルの起動が必要です。全トーク分析を有効にした閲覧者は、1対1トークから /review-week または「先週の未対応を教えて」と送ってください。通常の質問は各質問を独立して処理します。";
          else {
            try {
              if (!config.model) throw new Error("model_required");
              answer = await chatgpt.ask(text.slice(0, 12000), config.model, DEFAULT_SYSTEM_PROMPT + "\nあなたには直接トーク履歴や外部サービスへアクセスするツールはありません。履歴を確認したと装わないでください。先週の未対応の分析は、PC設定で全トーク分析を有効にした閲覧者がBotとの1対1トークで /review-week と送ると実行できます。通常の質問には履歴は渡されていません。");
            } catch (e) { answer = message(e); console.error("AI request failed (details redacted)"); }
          }
          await queue.answer(job.id, answer);
          job.answer = answer;
        }
        // Recheck the reviewer before delivery, including persisted answers after a restart.
        if (isReviewRequest(job.event.content?.text || "") && !canReview(config, job.event.source)) {
          job.answer = reviewAccessMessage(config, job.event.source);
          await queue.answer(job.id, job.answer);
        }
        // Persist the delivery phase before sending, including after inference.
        await queue.transact(d => { d.jobs.find(j => j.id === job.id).status = "delivering"; });
        diagnostics.stage = "LINE WORKSへ返信中";
        await sendLineWorksReply(job.event.source, job.answer);
        diagnostics.replied = new Date().toISOString();
        diagnostics.lastError = "";
        console.log("LINE WORKSへ返信しました。");
        await queue.finish(job.id);
      } catch (error) { diagnose(lineWorksDiagnostic(error)); await queue.fail(job.id); }
    }
  } finally { busy = false; diagnostics.stage = "待機中"; }
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
        clearLineWorksTokenCache();
        await store.write("settings", config);
      } else if (url.pathname === "/monitoring-settings") {
        const allowed = String(config.LINEWORKS_ALLOWED_USER_IDS || "").split(",").map(v => v.trim()).filter(Boolean);
        const reviewer = p.get("reviewer");
        if (p.get("enabled") === "1" && !allowed.includes(reviewer)) return respond(res, 400, "本人登録済みユーザーを選んでください。");
        config.monitoringEnabled = p.get("enabled") === "1";
        config.monitoringReviewer = allowed.includes(reviewer) ? reviewer : "";
        clearLineWorksTokenCache();
        await store.write("settings", config);
      } else if (url.pathname === "/test-monitoring") {
        if (!config.monitoringEnabled) return respond(res, 400, "全トーク分析を有効にして保存してください。");
        try {
          const { downloadTalks, lastWeek } = await import("./monitoring.js");
          const data = await downloadTalks(lastWeek());
          return respond(res, 200, `全トーク取得テスト成功。取得データ行数: ${data.rows.length}。分析するにはBotとの1対1トークで /review-week を送ってください。0行の場合は保存期間・保存対象を確認してください。`);
        } catch (error) { return respond(res, 400, monitoringMessage(error)); }
      } else if (url.pathname === "/test-lineworks") {
        try {
          validateLineWorksConfiguration();
          await getLineWorksAccessToken();
          const userId = String(config.LINEWORKS_ALLOWED_USER_IDS || "").split(",").map(s => s.trim()).find(Boolean);
          if (!userId) return respond(res, 400, "本人登録を先に行ってください。");
          await sendLineWorksReply({ userId }, "PCからLINE WORKSへのテスト送信に成功しました。続けて /ping を送ってください。");
          diagnostics.replied = new Date().toISOString(); diagnostics.lastError = "";
          return respond(res, 200, "テスト送信成功。LINE WORKSのトークを確認してください。");
        } catch (error) { const detail = lineWorksDiagnostic(error); diagnose(detail); return respond(res, 400, detail); }
      } else if (["/pair", "/pair-reviewer"].includes(url.pathname)) {
        pairing = { command: `/pair ${randomBytes(16).toString("hex")}`, expires: Date.now() + 10 * 60000, reviewer: url.pathname === "/pair-reviewer" };
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
        await store.write("review-checkpoint", null);
        return respond(res, 200, revoked ? "接続解除しました。" : "PC側の接続を解除しました。遠隔の解除は確認できていません。ChatGPTの設定からアプリを解除してください。");
      } else return respond(res, 404, "Not found");
      res.writeHead(303, { Location: "/", "Cache-Control": "no-store" }); res.end(); return;
    }
    if (req.method !== "GET" || url.pathname !== "/") return respond(res, 404, "Not found");
    const status = await chatgpt.status();
    let models = [], modelError = "";
    if (status.sharing) try { models = await chatgpt.models(); } catch { modelError = "モデル一覧を取得できません。再接続してお試しください。"; }
    const fields = keys.map(k => `<label>${k} ${config[k] ? "（保存済み・空欄で保持）" : ""}${k === "LINEWORKS_PRIVATE_KEY" ? `<textarea name="${k}" rows="5" autocomplete="off" spellcheck="false" placeholder="秘密鍵を貼り付けます。保存後は再表示しません。"></textarea>` : `<input name="${k}" type="${k.includes("SECRET") ? "password" : "text"}" autocomplete="off">`}</label>`).join("");
    const options = models.map(m => `<option value="${escape(m.slug)}" ${config.model === m.slug ? "selected" : ""}>${escape(m.name)}</option>`).join("");
    const pairPanel = form("/pair", "本人登録コードを発行") + (pairing && pairing.expires > Date.now() ? `<p>10分以内に、ご自身のLINE WORKSからBotとの1:1トークへ次を送ってください。この登録コードは他の人へ共有しないでください。</p><code id="pair-code">${escape(pairing.command)}</code>` : "") + `<p>登録済みユーザー数: ${String(config.LINEWORKS_ALLOWED_USER_IDS || "").split(",").filter(s => s.trim()).length}</p>`;
    const queueState = await queue.store.read("queue", { jobs: [] });
    const count = state => queueState.jobs.filter(j => j.status === state).length;
    let configurationCheck = "設定・秘密鍵の形式: OK";
    try { validateLineWorksConfiguration(); } catch (error) { configurationCheck = lineWorksDiagnostic(error); }
    const diagnosticPanel = `<h2>LINE WORKS接続状況</h2><p>${escape(configurationCheck)}</p><p>Callback受信: ${escape(diagnostics.received || "起動後の受信なし")}<br>署名・ユーザー確認済み: ${escape(diagnostics.accepted || "なし")}<br>返信成功: ${escape(diagnostics.replied || "なし")}<br>処理: ${escape(diagnostics.stage)}<br>キュー: 待機${count("pending")} / 処理${count("running")} / 回答済み${count("answered")} / 送信${count("delivering")} / 結果不明${count("uncertain")}</p><p>${escape(diagnostics.lastError)}</p>${form("/test-lineworks", "LINE WORKSへテスト送信")}`;
    const reviewers = String(config.LINEWORKS_ALLOWED_USER_IDS || "").split(",").map(v => v.trim()).filter(Boolean);
    const monitoringPanel = `<h2>全トーク分析（20261005版）</h2><p>原因表示・再開対応 修正版5。LINE WORKSのmonitoring.read権限が必要です。APIで取得した全トーク本文をChatGPT利用枠で分析します。トーク本文のCSVは保存せず、途中の分析メモはPCに保護して保存します。分析結果は選んだ閲覧者の1対1トークにだけ返します。先週は日本時間の月曜〜日曜。その後の返信も取得して照合します。</p>` +
      form("/pair-reviewer", "全トーク分析の本人登録コードを発行") + `<p>このボタンで発行したコードをBotとの1対1トークに送ると、その送信者を閲覧者に設定し全トーク分析を有効にします。現在の閲覧者は置き換わります。発行コードは上の本人登録欄に表示されます。</p>` +
      form("/monitoring-settings", "全トーク分析の設定を保存", `<label><input style="width:auto;display:inline" type="checkbox" name="enabled" value="1" ${config.monitoringEnabled ? "checked" : ""}>全トーク分析を有効にする</label><label>結果を閲覧できる本人登録済みユーザー<select name="reviewer"><option value="">選択してください</option>${reviewers.map((id, i) => `<option value="${escape(id)}" ${config.monitoringReviewer === id ? "selected" : ""}>登録ユーザー${i + 1}: ${escape(id)}</option>`).join("")}</select></label>`) +
      form("/test-monitoring", "全トーク取得をテスト") + `<p>設定後、本人の1対1トークで <code>/review-week</code> または「先週の未対応を教えて」と送ってください。件数により数分かかります。進行状況は接続状況の「処理」に表示します。1回最大150分割＋段階的統合のAI処理。上限超過や途中エラー時は完全な結果として返しません。未対応は候補として扱い、電話や別媒体での対応は確認できません。</p>`;
    const html = `<!doctype html><html lang="ja"><meta charset="utf-8"><title>ジョイフルAI PC設定</title><style>body{font:16px system-ui;max-width:800px;margin:40px auto;padding:20px;background:#f5f7fa;color:#13233d}form{background:white;padding:20px;border-radius:12px;margin:16px 0}label{display:block;margin:12px 0}input,textarea{display:block;width:95%;padding:8px}button,select{padding:10px;margin:5px}a{color:#175db3}</style><h1>ジョイフルAI PC設定</h1><p>ChatGPT利用枠を使用。有料APIへの自動切替はありません。</p><p>${escape(status.email)} / ${status.connected ? "接続済み" : "未接続"} / 利用枠: ${status.sharing ? "許可済み" : "未許可"}</p>${form("/connect", "Continue with ChatGPT")}${form("/connect", "別のアカウントを接続（現在の接続を置換）", '<input type="hidden" name="new" value="1">')}<p><a href="${USAGE_URL}" target="_blank" rel="noreferrer">ChatGPTの使用状況・アプリ上限を管理</a>。追加課金を使わないため、認証・使用状況画面でクレジット利用を許可せず、利用上限を設定してください。</p><p>${escape(modelError)}</p>${form("/model", "モデル保存", `<select name="model">${options}</select>`)}${form("/verify", "ChatGPT利用枠で応答テスト")}${form("/settings", "LINE WORKS設定をPCに保存", `<p>秘密情報はこの画面に入力してください。許可するLINE WORKSユーザーIDをカンマ区切りで指定します。未指定ならBotは返信しません。</p>${fields}`)}${pairPanel}${diagnosticPanel}${monitoringPanel}${form("/logout", "接続を解除")}<p>管理画面: ${origin}（公開しない）<br>Callback受信: http://127.0.0.1:${ingressPort}/api/lineworks/callback</p><p>PC・トンネル停止中は受付できません。通常質問の会話記憶、Gmail・Drive検索は未対応です。</p></html>`;
    // Same-origin forms must retain Origin; OAuth callbacks keep no-referrer.
    respond(res, 200, html, "text/html; charset=utf-8", "same-origin");
  } catch (e) { respond(res, 400, message(e)); }
});
const ingress = http.createServer(async (req, res) => {
  try {
    if (req.method !== "POST" || req.url !== "/api/lineworks/callback") return respond(res, 404, "Not found");
    diagnostics.received = new Date().toISOString();
    console.log("Callbackを受信しました（本文・送信者は非表示）。");
    const raw = await body(req);
    if (!verifyLineWorksSignature(raw, req.headers["x-works-signature"])) { diagnose("Callbackの署名が一致しません。Bot Secretを確認してください。"); return respond(res, 401, "Invalid signature"); }
    if (req.headers["x-works-botid"] && req.headers["x-works-botid"] !== process.env.LINEWORKS_BOT_ID) return respond(res, 401, "Invalid bot id");
    const event = JSON.parse(raw);
    if (event.type !== "message") return respond(res, 200, "");
    if (!event.source?.userId || (event.content?.type === "text" && !event.content.text?.trim())) return respond(res, 200, "");
    // Reject old signed events when LINE WORKS supplies its issuedTime field.
    if (event.issuedTime !== undefined) {
      const timestamp = typeof event.issuedTime === "number" ? event.issuedTime : Date.parse(event.issuedTime);
      if (!Number.isFinite(timestamp) || Math.abs(Date.now() - timestamp) > 10 * 60000) return respond(res, 400, "Stale event");
    }
    const allowed = String(config.LINEWORKS_ALLOWED_USER_IDS || "").split(",").map(s => s.trim()).filter(Boolean);
    if (pairing && pairing.expires > Date.now() && event.content?.type === "text" && event.content.text.trim() === pairing.command) {
      if (event.source.channelId) return respond(res, 400, "Pair in a 1:1 conversation");
      // A local admin explicitly issued this capability to select a monitoring reviewer.
      const selectReviewer = pairing.reviewer;
      // Consume before asynchronous storage; only one signed sender can claim it.
      pairing = null;
      if (!allowed.includes(event.source.userId)) allowed.push(event.source.userId);
      config.LINEWORKS_ALLOWED_USER_IDS = allowed.join(",");
      process.env.LINEWORKS_ALLOWED_USER_IDS = config.LINEWORKS_ALLOWED_USER_IDS;
      if (selectReviewer) { config.monitoringReviewer = event.source.userId; config.monitoringEnabled = true; }
      await store.write("settings", config);
    }
    if (!allowed.includes(event.source.userId)) { diagnose("Callbackの送信者が許可ユーザーに含まれていません。本人登録を確認してください。"); return respond(res, 200, ""); }
    diagnostics.accepted = new Date().toISOString();
    await queue.enqueue(raw, event);
    respond(res, 200, "");
    void work().catch(() => console.error("Local queue unavailable"));
  } catch (error) { diagnose(lineWorksDiagnostic(error)); respond(res, 503, "PC not ready"); }
});
async function listen(server, number) {
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(number, "127.0.0.1", resolve); });
}
// Bind ports before touching queue recovery to reject a second local process.
try { await listen(admin, port); await listen(ingress, ingressPort); }
catch { console.error("ポートを使用できません。二重起動を確認してください。"); process.exit(1); }
await queue.recover();
console.log("ジョイフルAI 全トーク分析版 20261005");
console.log(`設定画面を開いてください: ${origin}`);
console.log(`Callback受信ポート: ${ingressPort}（このポートのみトンネルで公開）`);
setInterval(() => { void work().catch(() => console.error("Local queue unavailable")); }, 2000);
void work().catch(() => console.error("Local queue unavailable"));

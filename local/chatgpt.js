import { randomBytes, randomUUID, createHash, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify, customFetch } from "jose";

const ISSUER = "https://auth.openai.com";
const RESOURCE = "https://api.openai.com/v1";
const TOKEN_URL = `${ISSUER}/api/accounts/oauth/token`;
const SCOPES = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
export const USAGE_URL = "https://chatgpt.com/settings/usage";

export class ChatGPTError extends Error {
  constructor(code) { super(code); this.code = code; }
}
// No provider response body, credentials or authorization URLs are logged.
async function jsonRequest(url, options = {}) {
  const r = await fetch(url, { ...options, signal: AbortSignal.timeout(30000) });
  const data = await r.json();
  if (!r.ok) throw new ChatGPTError(String(data.error?.code || (typeof data.error === "string" ? data.error : `http_${r.status}`)).slice(0, 100));
  return data;
}

async function identity(idToken, clientId, nonce) {
  const discovery = await jsonRequest(`${ISSUER}/.well-known/openid-configuration`);
  const jwks = new URL(discovery.jwks_uri);
  if (discovery.issuer !== ISSUER || jwks.origin !== ISSUER) throw new ChatGPTError("invalid_discovery");
  const { payload } = await jwtVerify(idToken, createRemoteJWKSet(jwks, { [customFetch]: fetch }), {
    issuer: ISSUER, audience: clientId, algorithms: ["RS256"], requiredClaims: ["iss", "aud", "exp", "iat", "sub"],
  });
  if ((nonce !== undefined && payload.nonce !== nonce) || !payload.sub ||
      (payload.azp !== undefined && payload.azp !== clientId) ||
      (Array.isArray(payload.aud) && payload.aud.length > 1 && payload.azp !== clientId)) throw new ChatGPTError("invalid_identity");
  return payload;
}

export async function consumeResponse(body) {
  let buffer = "", text = "", completed = false;
  const decoder = new TextDecoder();
  const handle = (frame) => {
    const payload = frame.split("\n").filter(l => l.startsWith("data:")).map(l => l.slice(5).trim()).join("\n");
    if (!payload || payload === "[DONE]") return;
    const e = JSON.parse(payload);
    if (e.type === "response.output_text.delta") text += e.delta || "";
    if (e.type === "response.completed") {
      if (e.response?.status && e.response.status !== "completed") throw new ChatGPTError("response_not_completed");
      completed = true;
    }
    if (["response.failed", "response.incomplete", "error"].includes(e.type))
      throw new ChatGPTError(e.response?.error?.code || e.code || e.type);
  };
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true });
    if (buffer.length > 4 * 1024 * 1024 || text.length > 1024 * 1024) throw new ChatGPTError("response_too_large");
    // Normalize CRLF after accumulating chunks (a CR/LF pair can cross a chunk).
    buffer = buffer.replace(/\r\n/g, "\n");
    let pos;
    while ((pos = buffer.indexOf("\n\n")) >= 0) {
      handle(buffer.slice(0, pos)); buffer = buffer.slice(pos + 2);
    }
    if (completed) return text.trim() || Promise.reject(new ChatGPTError("empty_response"));
  }
  buffer += decoder.decode();
  if (buffer.trim()) handle(buffer);
  if (!completed) throw new ChatGPTError("stream_interrupted");
  if (!text.trim()) throw new ChatGPTError("empty_response");
  return text.trim();
}

export class ChatGPT {
  constructor(store) { this.store = store; this.pending = null; this.refreshing = null; }
  async status() {
    const auth = await this.store.read("auth", {});
    return { connected: !!auth.access_token, email: auth.email || "", sharing: !!auth.access_token && auth.scopes?.includes("chatgpt.tokens.use.direct") };
  }
  async authorize(redirectUri, newAccount = false) {
    let host = await this.store.read("host");
    if (!host) { host = { id: `urn:uuid:${randomUUID()}` }; await this.store.write("host", host); }
    const saved = newAccount ? {} : await this.store.read("auth", {});
    const registration = saved.client_id ? saved : newAccount ? {} : await this.store.read("registration", {});
    const verifier = randomBytes(32).toString("base64url");
    const state = randomBytes(32).toString("base64url"), nonce = randomBytes(32).toString("base64url");
    this.pending = { state, nonce, verifier, redirectUri, saved, clientId: registration.client_id, started: Date.now() };
    const url = new URL(`${ISSUER}/api/accounts/authorize`);
    url.search = new URLSearchParams({ client_id: registration.client_id || "dynamic_agent_client",
      ext_agent_host_id: host.id, response_type: "code", redirect_uri: redirectUri,
      scope: SCOPES, resource: RESOURCE, state, nonce, code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      ...(!registration.client_id ? { agent_name_hint: "Joyful LINE WORKS AI" } : {}),
      ...(saved.id_token ? { id_token_hint: saved.id_token } : {}),
    }).toString();
    return url.toString();
  }
  async callback(params) {
    const p = this.pending;
    const actualState = Buffer.from(params.get("state") || ""), expectedState = Buffer.from(p?.state || "");
    if (!p || Date.now() - p.started > 600000 || params.getAll("state").length !== 1 || actualState.length !== expectedState.length || !timingSafeEqual(actualState, expectedState)) throw new ChatGPTError("invalid_state");
    this.pending = null;
    if (params.get("error")) throw new ChatGPTError("authorization_declined");
    const clientId = params.get("client_id") || p.clientId;
    if (!clientId || clientId === "dynamic_agent_client" || (p.clientId && p.clientId !== clientId)) throw new ChatGPTError("invalid_client_id");
    if (!params.get("code")) throw new ChatGPTError("missing_code");
    // Retain registration if a one-time authorization code expires.
    await this.store.write("registration", { client_id: clientId });
    const data = await jsonRequest(TOKEN_URL, { method: "POST", body: new URLSearchParams({
      grant_type: "authorization_code", client_id: clientId, code: params.get("code"),
      code_verifier: p.verifier, redirect_uri: p.redirectUri, resource: RESOURCE,
    }) });
    const payload = await identity(data.id_token, clientId, p.nonce);
    if (p.saved.subject && (p.saved.subject !== payload.sub || p.saved.issuer !== payload.iss)) throw new ChatGPTError("account_mismatch");
    if (typeof data.scope !== "string") throw new ChatGPTError("missing_scopes");
    await this.saveTokens({ client_id: clientId, subject: payload.sub, issuer: payload.iss, email: payload.email || "" }, data);
    return this.status();
  }
  async saveTokens(previous, data) {
    if (!data.access_token || (data.token_type || "").toLowerCase() !== "bearer" || !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 0)
      throw new ChatGPTError("invalid_token_response");
    if ((data.scope || previous.scopes?.join(" ") || "").split(/\s+/).includes("offline_access") && !data.refresh_token && !previous.refresh_token)
      throw new ChatGPTError("missing_refresh_token");
    await this.store.write("auth", { ...previous, access_token: data.access_token,
      refresh_token: data.refresh_token || previous.refresh_token, id_token: data.id_token || previous.id_token,
      scopes: data.scope === undefined ? previous.scopes || [] : String(data.scope).split(/\s+/),
      expires_at: Date.now() + Number(data.expires_in) * 1000 });
  }
  async accessToken() {
    let auth = await this.store.read("auth", {});
    if (!auth.access_token) throw new ChatGPTError("sign_in_required");
    if (auth.expires_at <= Date.now() + 60000) {
      if (!this.refreshing) this.refreshing = (async () => {
        const current = await this.store.read("auth", {});
        if (!current.refresh_token) throw new ChatGPTError("sign_in_required");
        const data = await jsonRequest(TOKEN_URL, { method: "POST", body: new URLSearchParams({
          grant_type: "refresh_token", client_id: current.client_id, refresh_token: current.refresh_token, resource: RESOURCE,
        }) });
        if (data.id_token) {
          const payload = await identity(data.id_token, current.client_id);
          if (payload.sub !== current.subject) throw new ChatGPTError("account_mismatch");
        }
        await this.saveTokens(current, data);
      })().finally(() => { this.refreshing = null; });
      await this.refreshing;
      auth = await this.store.read("auth", {});
    }
    if (!auth.scopes?.includes("chatgpt.tokens.use.direct")) throw new ChatGPTError("plan_permission_required");
    return auth.access_token;
  }
  async models() {
    const data = await jsonRequest(`${RESOURCE}/models`, { headers: { Authorization: `Bearer ${await this.accessToken()}` } });
    return (data.models || []).filter(m => m.visibility === "list").map(m => ({ slug: m.slug, name: m.display_name || m.slug }));
  }
  async ask(text, model, instructions) {
    const r = await fetch(`${RESOURCE}/responses`, { method: "POST", signal: AbortSignal.timeout(180000),
      headers: { Authorization: `Bearer ${await this.accessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, instructions, input: [{ role: "user", content: text }], store: false, stream: true }) });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new ChatGPTError(d.error?.code || `http_${r.status}`);
    }
    return consumeResponse(r.body);
  }
  async logout() {
    if (this.refreshing) await this.refreshing.catch(() => {});
    const auth = await this.store.read("auth", {});
    let revoked = !auth.refresh_token;
    try {
      const d = await jsonRequest(`${ISSUER}/.well-known/openid-configuration`);
      const url = new URL(d.revocation_endpoint);
      if (url.protocol !== "https:" || url.hostname !== "auth.openai.com") throw new Error();
      if (auth.refresh_token) {
        const r = await fetch(url, { method: "POST", signal: AbortSignal.timeout(15000), body: new URLSearchParams({
          token: auth.refresh_token, token_type_hint: "refresh_token", client_id: auth.client_id,
        }) });
        revoked = r.status === 200;
      }
    } catch { /* Report incomplete revocation without exposing credentials. */ }
    await this.store.write("auth", { client_id: auth.client_id, email: auth.email, subject: auth.subject, issuer: auth.issuer });
    this.pending = null;
    return revoked;
  }
}

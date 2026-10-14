import crypto from "node:crypto";

const TOKEN_URL = "https://auth.worksmobile.com/oauth2/v2.0/token";
const API_BASE = "https://www.worksapis.com/v1.0";

const tokenCache = new Map();

export class LineWorksError extends Error {
  constructor(code, status) { super(code); this.code = code; this.status = status; }
}
export function clearLineWorksTokenCache() { tokenCache.clear(); }

function required(name) {
  const value = process.env[name];
  if (!value) throw new LineWorksError(`MISSING_${name}`);
  return value;
}

export function normalizePrivateKey(value) {
  const text = value.replace(/\\r\\n/g, "\n").replace(/\\n/g, "\n").trim();
  // Single-line HTML inputs strip real line breaks when a PEM is pasted.
  // Restore the PEM envelope and wrap only its base64 body.
  const pem = text.match(/^-----BEGIN (RSA PRIVATE KEY|PRIVATE KEY)-----\s*([A-Za-z0-9+/=\s]+)\s*-----END \1-----$/);
  if (!pem) throw new LineWorksError("PRIVATE_KEY_FORMAT");
  const encoded = pem[2].replace(/\s/g, "");
  return `-----BEGIN ${pem[1]}-----\n${encoded.match(/.{1,64}/g).join("\n")}\n-----END ${pem[1]}-----`;
}

export function validateLineWorksConfiguration() {
  for (const key of ["LINEWORKS_BOT_ID", "LINEWORKS_BOT_SECRET", "LINEWORKS_CLIENT_ID", "LINEWORKS_CLIENT_SECRET", "LINEWORKS_SERVICE_ACCOUNT", "LINEWORKS_PRIVATE_KEY"]) required(key);
  try {
    const key = crypto.createPrivateKey(normalizePrivateKey(required("LINEWORKS_PRIVATE_KEY")));
    if (key.asymmetricKeyType !== "rsa") throw new LineWorksError("PRIVATE_KEY_FORMAT");
  } catch { throw new LineWorksError("PRIVATE_KEY_FORMAT"); }
  return true;
}

function base64url(input) {
  return Buffer.from(input).toString("base64url");
}

export function verifyLineWorksSignature(rawBody, receivedSignature) {
  if (!receivedSignature) return false;
  const secret = required("LINEWORKS_BOT_SECRET");
  const expected = crypto
    .createHmac("sha256", secret)
    .update(rawBody, "utf8")
    .digest("base64");

  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(receivedSignature, "utf8");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function createServiceAccountJwt() {
  const clientId = required("LINEWORKS_CLIENT_ID");
  const serviceAccount = required("LINEWORKS_SERVICE_ACCOUNT");
  let privateKey;
  try { privateKey = crypto.createPrivateKey(normalizePrivateKey(required("LINEWORKS_PRIVATE_KEY"))); }
  catch { throw new LineWorksError("PRIVATE_KEY_FORMAT"); }
  const now = Math.floor(Date.now() / 1000);

  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64url(JSON.stringify({
    iss: clientId,
    sub: serviceAccount,
    iat: now,
    exp: now + 55 * 60,
  }));
  const signingInput = `${header}.${payload}`;
  const signature = crypto.sign("RSA-SHA256", Buffer.from(signingInput), privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

export async function getLineWorksAccessToken(requestedScope = process.env.LINEWORKS_SCOPE || "bot") {
  const cached = tokenCache.get(requestedScope);
  const now = Date.now();
  if (cached && cached.expiresAt > now + 60_000) {
    return cached.accessToken;
  }

  const clientId = required("LINEWORKS_CLIENT_ID");
  const clientSecret = required("LINEWORKS_CLIENT_SECRET");
  const scope = requestedScope;
  const assertion = createServiceAccountJwt();

  const body = new URLSearchParams({
    assertion,
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    client_id: clientId,
    client_secret: clientSecret,
    scope,
  });

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal: AbortSignal.timeout(20000),
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new LineWorksError("TOKEN_HTTP_ERROR", res.status);
  }

  const expiresIn = Number(data.expires_in || 3600);
  tokenCache.set(requestedScope, {
    accessToken: data.access_token,
    expiresAt: now + expiresIn * 1000,
  });
  return data.access_token;
}

async function postMessage(url, text) {
  const token = await getLineWorksAccessToken();
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      content: {
        type: "text",
        text: String(text),
      },
    }),
    signal: AbortSignal.timeout(20000),
  });

  if (!res.ok) {
    await res.body?.cancel();
    throw new LineWorksError("REPLY_HTTP_ERROR", res.status);
  }
}

export function splitReply(text) {
  const parts = []; let remaining = String(text);
  while (remaining.length > 16000) {
    let end = 16000;
    if (/^[\uDC00-\uDFFF]$/.test(remaining[end])) end--;
    parts.push(remaining.slice(0, end)); remaining = remaining.slice(end);
  }
  if (remaining || !parts.length) parts.push(remaining);
  return parts;
}
export async function sendLineWorksReply(source, text) {
  const botId = encodeURIComponent(required("LINEWORKS_BOT_ID"));
  let url;
  if (source?.channelId) {
    const channelId = encodeURIComponent(source.channelId);
    url = `${API_BASE}/bots/${botId}/channels/${channelId}/messages`;
  } else {
    if (!source?.userId) throw new Error("Callback source.userId is missing");
    const userId = encodeURIComponent(source.userId);
    url = `${API_BASE}/bots/${botId}/users/${userId}/messages`;
  }
  const parts = splitReply(text);
  for (let i = 0; i < parts.length; i++) await postMessage(url, parts.length === 1 ? parts[i] : `【${i + 1}/${parts.length}】\n${parts[i]}`);
}

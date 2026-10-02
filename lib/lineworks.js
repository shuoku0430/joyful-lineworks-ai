import crypto from "node:crypto";

const TOKEN_URL = "https://auth.worksmobile.com/oauth2/v2.0/token";
const API_BASE = "https://www.worksapis.com/v1.0";

let tokenCache = null;

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not configured`);
  return value;
}

function normalizePrivateKey(value) {
  return value.replace(/\\n/g, "\n").trim();
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
  const privateKey = crypto.createPrivateKey(normalizePrivateKey(required("LINEWORKS_PRIVATE_KEY")));
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

export async function getLineWorksAccessToken() {
  const now = Date.now();
  if (tokenCache && tokenCache.expiresAt > now + 60_000) {
    return tokenCache.accessToken;
  }

  const clientId = required("LINEWORKS_CLIENT_ID");
  const clientSecret = required("LINEWORKS_CLIENT_SECRET");
  const scope = process.env.LINEWORKS_SCOPE || "bot";
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
  });

  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`LINE WORKS token error ${res.status}: ${JSON.stringify(data)}`);
  }

  const expiresIn = Number(data.expires_in || 3600);
  tokenCache = {
    accessToken: data.access_token,
    expiresAt: now + expiresIn * 1000,
  };
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
        text: String(text).slice(0, 18000),
      },
    }),
  });

  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`LINE WORKS message error ${res.status}: ${detail}`);
  }
}

export async function sendLineWorksReply(source, text) {
  const botId = encodeURIComponent(required("LINEWORKS_BOT_ID"));

  if (source?.channelId) {
    const channelId = encodeURIComponent(source.channelId);
    return postMessage(`${API_BASE}/bots/${botId}/channels/${channelId}/messages`, text);
  }

  if (!source?.userId) throw new Error("Callback source.userId is missing");
  const userId = encodeURIComponent(source.userId);
  return postMessage(`${API_BASE}/bots/${botId}/users/${userId}/messages`, text);
}

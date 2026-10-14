// The cloud gateway never receives ChatGPT credentials or performs inference.
export async function forwardToPC(rawBody, signature, botId, fetcher = fetch) {
  const url = new URL(process.env.PC_CALLBACK_URL || "");
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
      url.pathname !== "/api/lineworks/callback") throw new Error("Invalid PC callback URL");
  const result = await fetcher(url, {
    method: "POST", redirect: "error", signal: AbortSignal.timeout(8000),
    headers: { "Content-Type": "application/json", "x-works-signature": signature,
      ...(botId ? { "x-works-botid": botId } : {}) },
    body: rawBody,
  });
  if (result.status !== 200) throw new Error("PC callback unavailable");
}

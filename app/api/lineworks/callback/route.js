import { askOpenAI } from "../../../../lib/openai.js";
import { sendLineWorksReply, verifyLineWorksSignature } from "../../../../lib/lineworks.js";

export const runtime = "nodejs";
export const maxDuration = 60;

function helpText() {
  return [
    "ジョイフルAIです。LINE WORKSから質問できます。",
    "",
    "例:",
    "・この文章を丁寧なメールにして",
    "・今日の会議の論点を整理して",
    "・このトラブル報告を要約して",
    "・営業先への返信案を作って",
    "",
    "現在の初期版はテキスト質問に対応しています。",
  ].join("\n");
}

export async function POST(request) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-works-signature");
  const receivedBotId = request.headers.get("x-works-botid");

  try {
    if (!verifyLineWorksSignature(rawBody, signature)) {
      return new Response("Invalid signature", { status: 401 });
    }

    const configuredBotId = process.env.LINEWORKS_BOT_ID;
    if (configuredBotId && receivedBotId && configuredBotId !== receivedBotId) {
      return new Response("Invalid bot id", { status: 401 });
    }

    const event = JSON.parse(rawBody);

    // LINE WORKS expects HTTP 200 for callback events. Ignore non-message events.
    if (event.type !== "message") {
      return new Response(null, { status: 200 });
    }

    if (event.content?.type !== "text") {
      await sendLineWorksReply(event.source, "現在はテキストメッセージに対応しています。画像・ファイル対応は次の拡張で追加できます。");
      return new Response(null, { status: 200 });
    }

    const text = (event.content.text || "").trim();
    if (!text) return new Response(null, { status: 200 });

    if (["/help", "help", "ヘルプ", "使い方"].includes(text.toLowerCase())) {
      await sendLineWorksReply(event.source, helpText());
      return new Response(null, { status: 200 });
    }

    if (["/ping", "ping"].includes(text.toLowerCase())) {
      await sendLineWorksReply(event.source, "pong / ジョイフルAIは稼働中です。");
      return new Response(null, { status: 200 });
    }

    const answer = await askOpenAI(text);
    await sendLineWorksReply(event.source, answer);
    return new Response(null, { status: 200 });
  } catch (error) {
    console.error("LINE WORKS callback failed", error);
    // Callback failures are not retried by LINE WORKS, so return 200 after logging
    // to avoid repeated user-facing failures caused by upstream transient issues.
    return new Response(null, { status: 200 });
  }
}

# ジョイフルAI — LINE WORKS × Gemini（Cloudflare Workers）

LINE WORKS のトークでBotに話しかけると、AI（既定はGemini）が回答して返信するBotです。
Cloudflare Workers 上で常時稼働するため、PCの起動やトンネルは不要で、Callback URL も固定です。

- `POST /callback` … LINE WORKS の Callback URL
- `GET /health` … 稼働確認（未設定の項目があれば `missing` に表示）
- main に push すると GitHub Actions が自動でデプロイ

## 構成

```
LINE WORKS ──(Callback, 署名付き)──▶ Cloudflare Worker ──▶ OpenAI
                 ▲                         │
                 └──────(Bot APIで返信)─────┘
```

- `X-WORKS-Signature`（HMAC-SHA256）を検証してから処理
- LINE WORKS には即 200 を返し、AIの返答はバックグラウンドで送信（タイムアウトしない）
- Service Account + RS256 JWT で Access Token を発行・キャッシュ

## 初回セットアップ

### 1. Cloudflare アカウント（無料）

https://dash.cloudflare.com/sign-up で作成。Workers の無料枠（1日10万リクエスト）で足ります。

### 2. GitHub に Cloudflare の鍵を登録

1. Cloudflare ダッシュボード → 右上アイコン → **My Profile → API Tokens → Create Token**
2. テンプレート **「Edit Cloudflare Workers」** → Use template → Account Resources は自分のアカウント、Zone Resources は **All zones** → Create Token → 表示されたトークンをコピー
3. Cloudflare ダッシュボードのトップ（Workers & Pages）右側の **Account ID** をコピー
4. GitHub このリポジトリ → **Settings → Secrets and variables → Actions → New repository secret** で2つ登録
   - `CLOUDFLARE_API_TOKEN`
   - `CLOUDFLARE_ACCOUNT_ID`
5. **Actions → Deploy to Cloudflare Workers → Run workflow**

### 3. Worker に秘密情報を登録

Cloudflare ダッシュボード → **Workers & Pages → joyful-lineworks-ai → Settings → Variables and Secrets → Add**（Type は **Secret**）

| 名前 | 値 |
|---|---|
| `LINEWORKS_BOT_ID` | Developer Console > Bot の Bot ID |
| `LINEWORKS_BOT_SECRET` | 同 Bot Secret |
| `LINEWORKS_CLIENT_ID` | Developer Console > API > ClientApp の Client ID |
| `LINEWORKS_CLIENT_SECRET` | 同 Client Secret |
| `LINEWORKS_SERVICE_ACCOUNT` | 同 Service Account（`xxxxx.serviceaccount@ドメイン`） |
| `LINEWORKS_PRIVATE_KEY` | 同 Private Key ファイル（.key）の中身を丸ごと |
| `GEMINI_API_KEY` | Google AI Studio の API キー（既定のAI。`AI_PROVIDER = "gemini"`） |
| `OPENAI_API_KEY` | OpenAI を使う場合のみ（`wrangler.toml` の `AI_PROVIDER` を `"openai"` に） |
| `BOT_SYSTEM_PROMPT` | 任意。AIへの指示文を変えたいとき |

`https://joyful-lineworks-ai.<あなたのサブドメイン>.workers.dev/health` を開いて `"ok": true` なら設定完了。

### 4. LINE WORKS の Callback URL を変更

Developer Console → Bot → 対象Bot → Callback URL を

```
https://joyful-lineworks-ai.<あなたのサブドメイン>.workers.dev/callback
```

に変更して保存。以後このURLは変わりません。

### 5. 動作テスト

Botに `/ping` → `pong / ジョイフルAIは稼働中です。` が返ればOK。続けて普通の質問を送ってAIの回答が返るか確認。

## 設定の変更

- AI・モデル：`wrangler.toml` の `AI_PROVIDER`（gemini / openai）、`GEMINI_MODEL`、`OPENAI_MODEL`
- ログ：Cloudflare ダッシュボード → Worker → **Logs**（エラー内容はここに出ます）

## セキュリティ

- 秘密情報は Cloudflare の Secrets にのみ置き、Git・トーク・チャットに貼らない
- このリポジトリは公開設定のため、秘密情報を絶対にコミットしないこと

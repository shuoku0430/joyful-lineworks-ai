# ジョイフルAI — LINE WORKS × OpenAI

LINE WORKS のトークに投稿されたテキストを OpenAI Responses API に渡し、Bot が同じ1:1トークまたは複数人トークへ返信する最小構成です。

## 実装済み

- LINE WORKS Callback受信
- `X-WORKS-Signature` の HMAC-SHA256 / Base64 検証
- `X-WORKS-BotId` の照合
- Service Account + RS256 JWT による Access Token 発行
- Access Token のメモリキャッシュ
- 1:1 / 複数人トークの自動判定
- OpenAI Responses API による回答生成
- `/help` / `/ping`
- 非テキストメッセージへの案内
- Health check `/api/health`

## 1. LINE WORKS Developer Console

### A. API Client App（認証アプリ）

1. Developer Console > API > ClientApp で認証アプリを作成
2. Scope に `bot` を追加
3. Service Account を発行
4. Private Key を発行・保存
5. Client ID / Client Secret / Service Account ID を控える

### B. Bot

1. Developer Console > Bot で Bot を作成
2. Bot名例: `ジョイフルAI`
3. Bot Secret を控える
4. Bot ID を控える
5. デプロイ後、Callback URL に次を指定

```text
https://YOUR-DOMAIN/api/lineworks/callback
```

6. Callbackを有効化し、Message Event を受信できるようにする
7. LINE WORKS管理側でBotを利用メンバーに公開・追加する

## 2. OpenAI API

OpenAI Platform で API key を発行します。ChatGPT Plus等の契約とはAPI利用料金が別管理になる場合があります。

## 3. 環境変数

`.env.example` を参照し、VercelのEnvironment Variablesに以下を登録してください。

```text
OPENAI_API_KEY
OPENAI_MODEL
LINEWORKS_BOT_ID
LINEWORKS_BOT_SECRET
LINEWORKS_CLIENT_ID
LINEWORKS_CLIENT_SECRET
LINEWORKS_SERVICE_ACCOUNT
LINEWORKS_PRIVATE_KEY
LINEWORKS_SCOPE
BOT_SYSTEM_PROMPT（任意）
```

`LINEWORKS_PRIVATE_KEY` は改行を `\n` にして1行で登録しても動作します。

## 4. Vercelへデプロイ

GitHubへこのフォルダをpushし、VercelでImport Projectします。環境変数を登録してDeployしてください。

デプロイ後:

```text
GET https://YOUR-DOMAIN/api/health
```

が `{"ok":true,...}` を返せばサーバーは稼働しています。

その後、LINE WORKS BotのCallback URLを設定します。

## 5. 動作テスト

LINE WORKSでBotへ次を送信:

```text
/ping
```

正常なら:

```text
pong / ジョイフルAIは稼働中です。
```

次に:

```text
営業先への訪問お礼メールを丁寧に作って
```

と送信しAI回答が返れば接続完了です。

## セキュリティ

- `.env` やPrivate KeyをGitへコミットしないでください。
- Callbackは必ず署名検証した後に処理します。
- APIキー、Client Secret、Bot Secret、Private KeyはLINE WORKSトークに貼らないでください。
- 本番運用では、利用可能ユーザー制限・ログ保持方針・機密データの取扱いルールを追加してください。

## 次の拡張候補

- Gmail検索・返信案作成
- Google Drive社内資料検索
- BigQueryの稼働率・売上・運行データ照会
- 画像/PDF入力
- ユーザー別権限
- 会話履歴の保持
- 管理画面・利用ログ


# ジョイフルAI — LINE WORKS × ChatGPT

LINE WORKSのCallback受信に加え、公式Sign in with ChatGPTでPC上からChatGPT利用枠を使用する検証版を追加しました。

**PC起動・認証・Vercel中継設定は [docs/PC_SETUP.md](docs/PC_SETUP.md) を参照してください。** 秘密情報はPCの設定画面または各サービスの環境変数画面に入力します。

## 全トーク分析・接続修正版

PCに配布した `Joyful-PC-MONITORING-FIX5` の修正をこのブランチへ統合しました。

- 1対1トークで本人登録し、全トーク分析の閲覧者を指定できます。
- `/review-week` で先週の未対応候補を、取得後の返信と照合して分析します。
- 完了した分割の分析メモをPCに保護して保存し、同じ取得内容なら途中から再開します。
- 署名検証、秘密鍵の改行修復、接続状況・停止段階の表示、長文返信の分割に対応します。

分析の権限・対象範囲・更新手順は [docs/MONITORING_SETUP.md](docs/MONITORING_SETUP.md) を参照してください。
既存PCの設定と認証はユーザープロファイル内に保存されるため、同じWindowsユーザーで新しいコードを起動します。
PC設定画面とトーク本文・秘密情報をGitHubにアップロードしないでください。

このブランチを更新しても、PC上のコードやVercelのProductionは自動で切り替わりません。
本番への反映にはProductionの中継設定とPC・トンネルの接続確認が必要です。

## 動作方式

| AI_PROVIDER | 動作 |
|---|---|
| 未指定 / disabled | AI接続準備中と返信。有料APIを呼ばない |
| chatgpt-pc | Vercelから署名付きCallbackをHTTPSでPCへ中継。PCのOAuth認証でChatGPT利用枠を使う |
| openai-api | 明示的に選択した場合だけ、従来のOPENAI_API_KEY方式を使う。API料金が別途必要 |

```powershell
npm ci
npm run pc
```

PC設定画面は http://127.0.0.1:8787 、PCのCallbackは8788です。設定画面で認証、モデル保存、応答テスト、LINE WORKS設定を行います。PCとCallback用HTTPSトンネルの常時起動が必要です。

## 検証

```text
npm test
npm run build
```

OAuth、トークン更新、SSE完了判定、利用枠エラー、キュー重複防止、中継と署名検証に加え、全トーク分析の閲覧制限・CSV解析・4,914行の分割処理・長文返信をテストします。モック試験と、実アカウント・実LINE WORKSでの接続試験は区別しています。

## 本番のLINE WORKS設定

Vercelに `env.example` のLINE WORKS設定を登録します。`LINEWORKS_PRIVATE_KEY` は改行を `\n` に置換した1行でも使用できます。Callback URL:

https://joyful-lineworks-ai.vercel.app/api/lineworks/callback

- CallbackでHMAC-SHA256/Base64署名検証
- Service Account/RS256 JWTによるLINE WORKS認証
- 1:1・複数人トークへの返信
- `/help`・`/ping`
- `/api/health`

ChatGPT OAuthトークン・APIキー・LINE WORKS秘密鍵をGitへコミットしないでください。ChatGPTの認証はPC側の公式認証画面で行います。

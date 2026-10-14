# ChatGPT利用枠でのPC接続（検証版）

この構成はOpenAIの公式Sign in with ChatGPTのローカルアプリ向けOAuthフローを使用します。VercelはLINE WORKSの署名付きCallbackをPCへ転送し、PCがAI処理と返信を行います。ChatGPTのCookieやCodexの認証ファイルは読み取りません。

## 現在の検証状況

- OAuthの署名検証・nonce・PKCE・トークン更新、SSEの完了判定、重複受信防止、Vercel中継をモックで検証。
- 実アカウントでの認証、ChatGPT利用枠による応答完了、実LINE WORKSへの返信はPCでの確認が必要。
- WindowsのDPAPI保護は実装済み、Windows実機では未検証。
- この検証環境はクラウドLinuxであり、利用者のPC上のプログラムを直接起動できません。

## 1. PCで起動

Node.js 22 LTS以降をインストールし、このブランチを取得します。

```powershell
git clone --branch feat/chatgpt-plan-local https://github.com/shuoku0430/joyful-lineworks-ai.git
cd joyful-lineworks-ai
npm ci
npm run pc
```

Windowsでは取得したフォルダの `start-pc.cmd` をダブルクリックしても起動できます。ブラウザが先に開いて接続エラーになった場合は数秒後に再読み込みしてください。

設定画面: http://127.0.0.1:8787

1. **Continue with ChatGPT** を押す。
2. OpenAIの認証画面で自分のアカウント・ワークスペースを選び、ChatGPT利用枠の使用を許可する。
3. **追加クレジットを利用しない設定**と、アプリの利用上限を認証画面・ChatGPTの使用状況画面で確認する。このアプリからAPI課金への切替はしませんが、OAuth側で許可したクレジット利用はアカウント設定に従います。
4. 戻った設定画面でモデルを選択し「モデル保存」。一覧が出るだけでは接続成功の判定になりません。
5. 「ChatGPT利用枠で応答テスト」を押し、`検証完了（response.completed受信）` を確認する。
6. LINE WORKSの既存設定を画面に入力して保存する。秘密情報はチャットやGitHubへ貼らない。
7. ユーザーIDが分からない場合は空欄で保存し、Callback接続後に「本人登録コードを発行」を押します。表示された `/pair ...` を10分以内に、ご本人のLINE WORKSからBotとの1:1トークへ送ると、署名検証済みの送信元ユーザーIDを登録します。コードを他の人に共有しないでください。登録完了後は `/ping` と通常の質問で確認します。既知のユーザーIDをカンマ区切りで手入力することもできます。

`LINEWORKS_PRIVATE_KEY` はPEM全体を入力します。改行を `\n` に置き換えた文字列でも使用できます。保存済みフィールドは空欄で保持されます。

## 2. PCのCallbackポートのみ公開

PCのCallback受信は `http://127.0.0.1:8788/api/lineworks/callback` です。管理画面の **8787を公開しない** でください。

既存のHTTPSトンネルがあれば、転送先を `http://127.0.0.1:8788` にします。Cloudflare Tunnelを使う場合の例:

```powershell
cloudflared tunnel --url http://127.0.0.1:8788
```

表示されたHTTPS URLに `/api/lineworks/callback` を付けます。一時トンネルは再起動でURLが変わるため、継続運用では固定のHTTPS URLを使ってください。トンネルのサービス仕様や利用条件は利用時に確認してください。

## 3. Vercel中継を有効化

PRの変更を取り込んでデプロイ後、VercelのProduction環境変数を設定して再デプロイします。

```text
AI_PROVIDER=chatgpt-pc
PC_CALLBACK_URL=https://YOUR-PC-TUNNEL/api/lineworks/callback
```

Vercelに既に登録したLINE WORKS環境変数は使用します。**ChatGPTのアクセストークンや更新トークンをVercelに登録しません。** `OPENAI_API_KEY` は `chatgpt-pc` モードでは使用しません。未設定の `AI_PROVIDER` は `disabled` で、有料APIを呼びません。

LINE WORKSのCallback URLは現在のままです:

https://joyful-lineworks-ai.vercel.app/api/lineworks/callback

GitHubやVercelへの変更ができない場合は、LINE WORKSのBot設定でCallbackを `https://YOUR-PC-TUNNEL/api/lineworks/callback` へ直接変更します。この場合もPCで署名検証します。AIアプリだけを再起動する際は、トンネルの黒い画面を閉じないでください。認証・LINE WORKS設定は同じWindowsユーザーの保存先から再利用します。

## 4. 実機で確認

1. PC設定画面の応答テストを完了する。
2. 自分のLINE WORKSアカウントから `/ping` を送信し、`pong / PCは稼働中です。` を確認する。
3. `接続テストです。ひとことで回答して` を送り、Botが返信することを確認する。
4. ChatGPTの使用状況にアプリ利用が記録され、追加クレジットを使わない設定になっていることを確認する。
5. PCまたはトンネルを止め、Vercel経由なら停止案内が返ることを確認する。

## 保存と運用

- Windows: `%USERPROFILE%\.joyful-lineworks-ai` にWindowsユーザーに紐付くDPAPI暗号化形式で保存します。別ユーザー・別PCへのファイルコピーでは復号できません。
- macOS/Linux: `~/.joyful-lineworks-ai` にディレクトリ0700、ファイル0600で保存します。OS全体のディスク暗号化は別途PC側で管理してください。
- 管理画面はループバックのみ、Host確認・Origin確認・CSRF保護付き。OAuthの秘密情報はブラウザに表示しません。
- 受信は署名検証・ユーザーID制限後、最大100件のPC上のキューに保存して200を返します。同一Callbackは7日間重複排除します。
- 返信が完了した質問本文・回答はキューから削除し、本文のない重複判定記録のみ残します。起動時に前回の処理途中のものは自動再実行しません。送信結果が不明な場合は利用者が再送してください。
- PC停止中のVercel受信は保存されません。停止案内を受けた質問は再送してください。
- 現在は質問単位のテキスト応答です。ChatGPTの既存会話・メモリ、Gmail、Driveにはアクセスしません。
- 現在の画面は単一アカウントです。「別のアカウントを接続」は成功時に置換します。複数アカウントの保存・切替は未対応。
- 通常は既存のclient IDとhost IDを再利用します。利用枠上限時に有料APIへ切り替えず、時間を置く/設定画面で接続を確認する案内を返します。
- 個人アカウントでの初期検証として、許可ユーザーはまず本人だけにしてください。社内展開の可否は選択するプラン・ワークスペースの許可と実際の同意内容を確認して判断します。

## 公式資料

- https://developers.openai.com/siwc/token-sharing-open-source
- https://developers.openai.com/siwc/token-sharing-open-source/sign-in
- https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
- https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference
- https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
- https://github.com/openai/sign-in-with-chatgpt-devkit

2026-10-02の公式資料と開発キットを確認して実装。実アカウントでの利用可否は応答完了まで検証します。Vercel上でOAuth認証情報を保持してAIを直接実行する方式は、このローカル版には含めません。

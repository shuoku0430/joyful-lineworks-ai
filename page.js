export default function Home() {
  return (
    <main style={{ maxWidth: 760, margin: "64px auto", padding: "0 24px", lineHeight: 1.7 }}>
      <h1>ジョイフルAI / LINE WORKS Gateway</h1>
      <p>LINE WORKS Bot と OpenAI Responses API を接続するサーバーです。</p>
      <p>Health check: <code>/api/health</code></p>
      <p>LINE WORKS Callback: <code>/api/lineworks/callback</code></p>
    </main>
  );
}

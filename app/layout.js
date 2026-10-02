export const metadata = {
  title: "Joyful LINE WORKS AI",
  description: "LINE WORKS × OpenAI bot gateway for Joyful Kanko",
};

export default function RootLayout({ children }) {
  return (
    <html lang="ja">
      <body style={{ fontFamily: "system-ui, sans-serif", margin: 0 }}>{children}</body>
    </html>
  );
}

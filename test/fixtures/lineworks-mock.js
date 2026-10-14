import { appendFile } from 'node:fs/promises';
global.fetch = async (url, opts) => {
  if (String(url).includes('auth.worksmobile.com')) return Response.json({ access_token: 'fake-lineworks', expires_in: 3600 });
  if (String(url).includes('/monitoring/message-contents/download')) return new Response('日時,内容\n2026-10-04,確認してください\n');
  if (String(url).includes('worksapis.com')) {
    await appendFile(process.env.TEST_DELIVERY_FILE, opts.body + '\n');
    return new Response(null, { status: 200 });
  }
  throw new Error('Unexpected external call in local integration test');
};

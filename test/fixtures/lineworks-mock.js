import { appendFile } from 'node:fs/promises';
global.fetch = async (url, opts) => {
  if (String(url).includes('auth.worksmobile.com')) return Response.json({ access_token: 'fake-lineworks', expires_in: 3600 });
  if (String(url).includes('worksapis.com')) {
    await appendFile(process.env.TEST_DELIVERY_FILE, opts.body + '\n');
    return new Response(null, { status: 200 });
  }
  throw new Error('Unexpected external call in local integration test');
};

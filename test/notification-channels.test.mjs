import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('production notification path is GitHub Issues only',async()=>{
  const files=['scripts/notify.mjs','scripts/notify-discovery.mjs','.github/workflows/price-guard.yml','public/index.html','public/app.js'];
  const text=(await Promise.all(files.map(file=>fs.readFile(file,'utf8')))).join('\n');
  assert.doesNotMatch(text,/RESEND_API_KEY|NOTIFY_FROM_EMAIL|TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID|notificationForm|notificationEmailKey/);
  assert.match(text,/GitHub Issue/);
});

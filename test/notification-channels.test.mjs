import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

test('production notification path stays in GitHub Actions without email-producing Issues',async()=>{
  const files=['scripts/notify.mjs','scripts/notify-discovery.mjs','.github/workflows/price-guard.yml','public/index.html','public/app.js'];
  const text=(await Promise.all(files.map(file=>fs.readFile(file,'utf8')))).join('\n');
  assert.doesNotMatch(text,/RESEND_API_KEY|NOTIFY_FROM_EMAIL|TELEGRAM_BOT_TOKEN|TELEGRAM_CHAT_ID|notificationForm|notificationEmailKey/);
  assert.match(text,/GITHUB_STEP_SUMMARY/);
  assert.doesNotMatch(text,/api\.github\.com\/repos\/\$\{process\.env\.GITHUB_REPOSITORY\}\/issues/);
});

test('GitHub alert summaries do not mention or assign users because those trigger email',async()=>{
  const files=['scripts/notify.mjs','scripts/notify-discovery.mjs'];
  for(const file of files){
    const text=await fs.readFile(file,'utf8');
    assert.doesNotMatch(text,/assignees\s*:/,`${file} must not assign the repository owner`);
    assert.doesNotMatch(text,/@\$\{owner\}/,`${file} must not mention the repository owner`);
  }
});

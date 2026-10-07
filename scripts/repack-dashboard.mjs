import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { decrypt } from './lib/crypto.mjs';
import { publishStoredDiscovery } from './lib/discovery-publication.mjs';
import { writeOutputs } from './lib/publish.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const password=process.env.DASHBOARD_PASSWORD;
if(!password||password.length<8)throw new Error('DASHBOARD_PASSWORD 至少需要 8 个字符');
const file=path.join(root,'state','latest.json.enc');
const result=JSON.parse(decrypt(await fs.readFile(file),password).toString('utf8'));
await writeOutputs({root,result,previous:result,password});
await publishStoredDiscovery({root,password,dashboard:result});
const [phone,baseline]=await Promise.all([
  fs.stat(path.join(root,'public','data','latest.json.enc')),
  fs.stat(path.join(root,'public','data','state.json.enc'))
]);
console.log(`仪表盘快速包：${phone.size} bytes；完整后台基准：${baseline.size} bytes`);

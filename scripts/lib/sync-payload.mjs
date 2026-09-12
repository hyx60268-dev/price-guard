import zlib from 'node:zlib';
import { decrypt } from './crypto.mjs';

export function decodeSyncBody(body,password){
  const match=String(body||'').match(/<!--\s*PRICE_GUARD_SYNC_V1\s+([A-Za-z0-9_\-\s]+?)\s*-->/);
  if(!match)throw new Error('同步内容不完整，请回到价格守卫重新生成');
  const encrypted=Buffer.from(match[1].replace(/\s+/g,''),'base64url');
  let plain=decrypt(encrypted,password);
  if(plain[0]===0x1f&&plain[1]===0x8b)plain=zlib.gunzipSync(plain);
  const payload=JSON.parse(plain.toString('utf8'));
  if(payload.version!==1)throw new Error('不支持的同步数据版本');
  return payload;
}

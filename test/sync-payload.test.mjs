import test from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { encrypt } from '../scripts/lib/crypto.mjs';
import { decodeSyncBody } from '../scripts/lib/sync-payload.mjs';

test('encrypted and gzipped GitHub Issue payload roundtrips',()=>{
  const source={version:1,issuedAt:'2026-09-12T00:00:00Z',manualCosts:{key:{purchaseCNY:28}},managedAccounts:[]};
  const cipher=encrypt(zlib.gzipSync(Buffer.from(JSON.stringify(source))),'12345678').toString('base64url');
  assert.deepEqual(decodeSyncBody(`<!-- PRICE_GUARD_SYNC_V1\n${cipher}\n-->`,'12345678'),source);
});

test('sync parser rejects missing marker',()=>assert.throws(()=>decodeSyncBody('plain text','12345678'),/不完整/));

test('WebCrypto browser-format payload can be decrypted by the workflow',async()=>{
  const source={version:1,manualCosts:{stable:{manualFeeCNY:30}},managedAccounts:[]},password='12345678';
  const input=zlib.gzipSync(Buffer.from(JSON.stringify(source))),salt=crypto.webcrypto.getRandomValues(new Uint8Array(16)),iv=crypto.webcrypto.getRandomValues(new Uint8Array(12));
  const base=await crypto.webcrypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey']);
  const key=await crypto.webcrypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:180000,hash:'SHA-256'},base,{name:'AES-GCM',length:256},false,['encrypt']);
  const sealed=new Uint8Array(await crypto.webcrypto.subtle.encrypt({name:'AES-GCM',iv,tagLength:128},key,input)),body=sealed.slice(0,-16),tag=sealed.slice(-16);
  const output=new Uint8Array(48+body.length);output.set(new TextEncoder().encode('PG01'));output.set(salt,4);output.set(iv,20);output.set(tag,32);output.set(body,48);
  assert.deepEqual(decodeSyncBody(`<!-- PRICE_GUARD_SYNC_V1\n${Buffer.from(output).toString('base64url')}\n-->`,password),source);
});

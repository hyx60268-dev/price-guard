import crypto from 'node:crypto';
import fs from 'node:fs/promises';

export function encrypt(buffer,password){
  const salt=crypto.randomBytes(16),iv=crypto.randomBytes(12);
  const key=crypto.pbkdf2Sync(password,salt,180000,32,'sha256');
  const cipher=crypto.createCipheriv('aes-256-gcm',key,iv);
  const body=Buffer.concat([cipher.update(buffer),cipher.final()]);
  return Buffer.concat([Buffer.from('PG01'),salt,iv,cipher.getAuthTag(),body]);
}
export function decrypt(buffer,password){
  const input=Buffer.from(buffer);
  if(input.subarray(0,4).toString()!=='PG01') throw new Error('不是 Price Guard 加密文件');
  const salt=input.subarray(4,20),iv=input.subarray(20,32),tag=input.subarray(32,48),body=input.subarray(48);
  const key=crypto.pbkdf2Sync(password,salt,180000,32,'sha256');
  const decipher=crypto.createDecipheriv('aes-256-gcm',key,iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(body),decipher.final()]);
}
export async function encryptFile(input,output,password){
  await fs.writeFile(output,encrypt(await fs.readFile(input),password));
}

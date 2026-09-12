import sharp from 'sharp';

export async function imageHash(url) {
  if (!url) return null;
  try {
    const res=await fetch(url,{headers:{'user-agent':'Mozilla/5.0'}});
    if (!res.ok) return null;
    const buf=Buffer.from(await res.arrayBuffer());
    const {data}=await sharp(buf).greyscale().resize(9,8,{fit:'fill'}).raw().toBuffer({resolveWithObject:true});
    let bits='';
    for(let y=0;y<8;y++) for(let x=0;x<8;x++) bits+=data[y*9+x]>data[y*9+x+1]?'1':'0';
    return BigInt('0b'+bits).toString(16).padStart(16,'0');
  } catch { return null; }
}

export function imageSimilarity(a,b) {
  if (!a||!b) return null;
  let x=BigInt('0x'+a)^BigInt('0x'+b), distance=0;
  while(x){distance+=Number(x&1n);x>>=1n;}
  return 1-distance/64;
}

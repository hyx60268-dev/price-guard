import sharp from 'sharp';

const cache=new Map();

function bitsToHex(bits){
  return BigInt(`0b${bits}`).toString(16).padStart(16,'0');
}

async function download(url){
  const controller=new AbortController(),timeout=setTimeout(()=>controller.abort(),12000);
  try{
    const response=await fetch(url,{headers:{'user-agent':'Mozilla/5.0','accept':'image/avif,image/webp,image/*,*/*;q=0.8'},signal:controller.signal});
    if(!response.ok)return null;
    const length=Number(response.headers.get('content-length'));
    if(Number.isFinite(length)&&length>12_000_000)return null;
    const buffer=Buffer.from(await response.arrayBuffer());
    return buffer.length<=12_000_000?buffer:null;
  }catch{return null}
  finally{clearTimeout(timeout)}
}

async function differenceHash(buffer){
  const {data}=await sharp(buffer).greyscale().resize(9,8,{fit:'fill'}).raw().toBuffer({resolveWithObject:true});
  let bits='';
  for(let y=0;y<8;y++)for(let x=0;x<8;x++)bits+=data[y*9+x]>data[y*9+x+1]?'1':'0';
  return bitsToHex(bits);
}

async function averageHash(buffer){
  const {data}=await sharp(buffer).greyscale().resize(8,8,{fit:'fill'}).raw().toBuffer({resolveWithObject:true});
  const mean=[...data].reduce((sum,value)=>sum+value,0)/data.length;
  return bitsToHex([...data].map(value=>value>=mean?'1':'0').join(''));
}

async function makeFingerprints(url){
  if(!url)return null;
  const buffer=await download(url);if(!buffer)return null;
  try{
    const center=await sharp(buffer).resize(256,256,{fit:'cover',position:'centre'}).png().toBuffer();
    const [dHash,aHash,centerHash,stats]=await Promise.all([
      differenceHash(buffer),averageHash(buffer),differenceHash(center),sharp(buffer).resize(32,32,{fit:'inside'}).stats()
    ]);
    const color=(stats.channels||[]).slice(0,3).map(channel=>Math.round(channel.mean||0));
    return {dHash,aHash,centerHash,color,url};
  }catch{return null}
}

export async function imageFingerprints(url){
  if(!url)return null;
  if(!cache.has(url)){
    if(cache.size>500)cache.delete(cache.keys().next().value);
    cache.set(url,makeFingerprints(url));
  }
  return cache.get(url);
}

export async function imageHash(url){
  return (await imageFingerprints(url))?.dHash||null;
}

export function imageSimilarity(a,b){
  if(!a||!b)return null;
  try{
    let x=BigInt(`0x${a}`)^BigInt(`0x${b}`),distance=0;
    while(x){distance+=Number(x&1n);x>>=1n}
    return 1-distance/64;
  }catch{return null}
}

export function fingerprintSimilarity(a,b){
  if(!a||!b)return null;
  const hashes=[imageSimilarity(a.dHash,b.dHash),imageSimilarity(a.aHash,b.aHash),imageSimilarity(a.centerHash,b.centerHash)].filter(Number.isFinite);
  if(!hashes.length)return null;
  hashes.sort((x,y)=>y-x);
  let score=hashes[0]*.55+(hashes[1]??hashes[0])*.3+(hashes[2]??hashes[0])*.15;
  if(a.color?.length===3&&b.color?.length===3){
    const distance=Math.sqrt(a.color.reduce((sum,value,index)=>sum+(value-b.color[index])**2,0))/(Math.sqrt(3)*255);
    score=score*.75+(1-distance)*.25;
  }
  return Math.max(0,Math.min(1,score));
}

export function imageSetSimilarity(left=[],right=[]){
  let best=null;
  for(const a of left.filter(Boolean))for(const b of right.filter(Boolean)){
    const score=fingerprintSimilarity(a,b);
    if(Number.isFinite(score)&&(best===null||score>best))best=score;
  }
  return best;
}

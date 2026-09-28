export function merchantProfile(raw){
 let u;try{u=new URL(typeof raw==='string'?raw:raw.url)}catch{throw Error('商家主页链接无效')}
 if(u.protocol!=='https:'||u.username||u.password||u.port)throw Error('商家主页必须是公开 HTTPS 链接');
 const platforms={'paypayfleamarket.yahoo.co.jp':['yahoo',/^\/user\/([A-Za-z0-9_-]+)\/?$/],'fril.jp':['rakuma',/^\/shop\/([A-Za-z0-9_-]+)\/?$/],'jp.mercari.com':['mercari',/^\/user\/profile\/(\d+)\/?$/]};
 const def=platforms[u.hostname],id=def&&u.pathname.match(def[1])?.[1];if(!id)throw Error('请使用 Yahoo!フリマ、Rakuma 或 Mercari 商家主页');
 return {platform:def[0],id,key:def[0]+':'+id,url:u.origin+u.pathname.replace(/\/$/,''),name:typeof raw==='string'?id:String(raw.name||id).slice(0,80)};
}
export function mergeMerchantConfigs(base=[],incoming=[]){
 if(!Array.isArray(base)||!Array.isArray(incoming)||incoming.length>100)throw Error('监控商家数量或格式不正确');
 const records=new Map();
 for(const raw of [...base,...incoming]){
  const profile=merchantProfile(raw),stamp=Date.parse(raw.updatedAt||'')||0,current=records.get(profile.key);
  if(!current||stamp>=(Date.parse(current.updatedAt)||0))records.set(profile.key,{...profile,enabled:raw.enabled!==false,updatedAt:stamp?new Date(stamp).toISOString():new Date(0).toISOString()});
 }
 if(records.size>100)throw Error('最多保存100个监控商家');
 return [...records.values()].sort((a,b)=>a.key.localeCompare(b.key));
}

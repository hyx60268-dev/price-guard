// Shared by the browser, encrypted sync and cloud scanner. No arbitrary hosts.
export function parseShopProfile(value=''){
  let url;try{url=new URL(String(value).trim())}catch{return null}
  if(url.protocol!=='https:'||url.username||url.password||url.port)return null;
  const path=url.pathname.replace(/\/+$/,'');
  const yahoo=url.hostname==='paypayfleamarket.yahoo.co.jp'&&path.match(/^\/user\/([a-z0-9_-]+)$/i);
  const rakuma=url.hostname==='fril.jp'&&path.match(/^\/shop\/([a-z0-9_]+)$/i);
  const match=yahoo||rakuma;if(!match)return null;
  return {platform:yahoo?'yahoo_fleamarket':'rakuma',profileUrl:`https://${url.hostname}${path}`,
    id:yahoo?`account-${match[1].toLowerCase()}`:`account-rakuma-${match[1].toLowerCase()}`};
}

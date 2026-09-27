// Share navigation spacing across search/detail tabs in one authorized context.
const gates=new WeakMap();
export function createNavigationGate({intervalMs=8000,clock=Date.now,sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  let last=null,tail=Promise.resolve();
  return ()=>{const next=tail.then(async()=>{if(last!==null){const delay=Math.max(0,intervalMs-(clock()-last));if(delay)await sleep(delay)}last=clock()});tail=next.catch(()=>{});return next};
}
export function waitForXianyuNavigation(page,settings={}){
  const context=page.context();let gate=gates.get(context);
  if(!gate){const value=Number(settings.xianyuRequestIntervalMs);gate=createNavigationGate({sleep:ms=>page.waitForTimeout(ms),intervalMs:Number.isFinite(value)&&value>=1000?value:8000});gates.set(context,gate)}
  return gate();
}

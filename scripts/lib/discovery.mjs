import crypto from 'node:crypto';
import { distinctiveTokens,hasExplicitDefect,hasVariantMismatch,isLikelyVariantOffer,isRejected,productFamily,semanticQuantity,titleScore } from './rules.mjs';
import { positivePrice,verifiedCostEvidence,XIANYU_VERIFICATION } from './xianyu-evidence.mjs';

const listingNoise=/(?:中国限定|海外限定|日本未発売|日本非売品|限定|正規品|公式|新品(?:、未使用)?|未使用|未開封|即日発送|当日発送|翌日発送|国内発送|即納|スピード発送|匿名配送|送料無料|送料込み|即購入(?:可|可能|ok)?|希少|レア|現品限り|ラスト\s*1点|残り\s*1点|在庫あり|在庫複数|複数在庫|早い者勝ち|お?値下げ不可|\d+月\d+日(?:まで|以降)?|\d+\/\d+(?:まで|以降)?|発送予定)/gi;
const rejectSale=/(?:様専用|専用出品|リクエスト|まとめ商品|オーダー|確認用|取り置き|ばら売り|バラ売り|訳あり|ジャンク|破損|欠品|箱潰れ)/i;

export function mercariDiscoverySearchUrl({keyword='中国限定',minPriceJPY=5001}={}){
  const params=new URLSearchParams({keyword,status:'sold_out|trading',sort:'created_time',order:'desc',price_min:String(minPriceJPY)});
  return `https://jp.mercari.com/search?${params}`;
}

export function yahooDiscoverySearchUrl({keyword='中国限定',minPriceJPY=5001}={}){
  const params=new URLSearchParams({sold:'1',minPrice:String(minPriceJPY),sort:'openTime',order:'desc'});
  return `https://paypayfleamarket.yahoo.co.jp/search/${encodeURIComponent(keyword)}?${params}`;
}

export function canonicalSaleTitle(value=''){
  return String(value).normalize('NFKC')
    // Mercari/Yahoo sellers frequently use the common 富岡 typo for 冨岡義勇.
    // Treat it as spelling noise so relists and previously-owned goods stay excluded.
    .replace(/富岡義勇/g,'冨岡義勇').replace(listingNoise,' ')
    .replace(/[【】\[\]（）()<>《》「」『』#＃]/g,' ').replace(/\s+/g,' ').trim();
}

function tokenSet(value=''){
  return new Set(distinctiveTokens(canonicalSaleTitle(value)).map(token=>token.toLowerCase()).filter(token=>token.length>1));
}

function jaccard(left,right){
  if(!left.size||!right.size)return 0;
  let shared=0;for(const token of left)if(right.has(token))shared++;
  return shared/(left.size+right.size-shared);
}

function coveredToken(token,other){
  const normalized=String(token).toLowerCase();
  return [...other].some(value=>{
    const candidate=String(value).toLowerCase();
    return candidate===normalized||(normalized.length>=3&&candidate.length>=3&&(candidate.includes(normalized)||normalized.includes(candidate)));
  });
}

function distinctiveTokenEvidence(left,right){
  const a=tokenSet(left),b=tokenSet(right);
  const onlyA=[...a].filter(token=>!coveredToken(token,b)),onlyB=[...b].filter(token=>!coveredToken(token,a));
  const shared=[...a].filter(token=>coveredToken(token,b));
  return {a,b,onlyA,onlyB,shared,sharedLength:shared.reduce((sum,token)=>sum+token.length,0)};
}

export function sameSaleProduct(left={},right={}){
  const a=canonicalSaleTitle(left.title),b=canonicalSaleTitle(right.title);
  if(!a||!b||hasVariantMismatch(a,b)||hasVariantMismatch(b,a))return false;
  const af=productFamily(a),bf=productFamily(b);
  if(af&&bf&&af!==bf)return false;
  const aq=semanticQuantity(a),bq=semanticQuantity(b);
  if(Number.isFinite(aq)&&Number.isFinite(bq)&&aq!==bq)return false;
  if(a===b)return true;
  const evidence=distinctiveTokenEvidence(a,b);
  // Two-sided unique terms usually identify different characters, colours or
  // editions. Shared franchise/series wording must never merge those products.
  if(evidence.onlyA.length&&evidence.onlyB.length)return false;
  const overlap=jaccard(evidence.a,evidence.b);
  const oneTitleIsStrictlyMoreDescriptive=!evidence.onlyA.length||!evidence.onlyB.length;
  return overlap>=.72||(oneTitleIsStrictlyMoreDescriptive&&evidence.shared.length>=2&&evidence.sharedLength>=6&&titleScore(a,b)>=.72&&titleScore(b,a)>=.72);
}

export function sameDiscoveryProduct(left={},right={}){
  const a=canonicalSaleTitle(left.title),b=canonicalSaleTitle(right.title);
  if(!a||!b||hasVariantMismatch(a,b)||hasVariantMismatch(b,a))return false;
  const af=productFamily(a),bf=productFamily(b);
  const evidence=distinctiveTokenEvidence(a,b);
  // 毛绒挂件在日文标题中会被卖家分别写成「ぬいぐるみ」或「キーホルダー」。
  // 只在两侧无冲突词、至少两个强锚点和数量一致时允许这一个品类交叉，
  // 避免把普通塑料钥匙扣与毛绒玩偶泛化合并。
  const plushKeychain=new Set([af,bf]).size===2&&new Set([af,bf]).has('plush')&&new Set([af,bf]).has('keychain')&&
    evidence.onlyA.length===0&&evidence.onlyB.length===0&&evidence.shared.length>=2&&evidence.sharedLength>=6;
  if(af&&bf&&af!==bf&&!plushKeychain)return false;
  const aq=semanticQuantity(a),bq=semanticQuantity(b);if(Number.isFinite(aq)&&Number.isFinite(bq)&&aq!==bq)return false;
  if(plushKeychain)return true;
  if(sameSaleProduct(left,right))return true;
  const na=a.toLowerCase().replace(/[^\p{L}\p{N}]/gu,''),nb=b.toLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
  if(na===nb)return true;
  const shorter=na.length<=nb.length?na:nb,longer=na.length<=nb.length?nb:na;
  return shorter.length>=8&&longer.includes(shorter)&&shorter.length/longer.length>=.62;
}

export function groupDiscoveryCandidates(candidates=[]){
  const groups=[];
  for(const candidate of candidates){
    if(!candidate?.sourceTitle)continue;
    let group=groups.find(current=>current.members.some(member=>sameDiscoveryProduct(
      {title:member.sourceTitle},{title:candidate.sourceTitle}
    )));
    if(!group){group={members:[]};groups.push(group)}
    group.members.push(candidate);
  }
  return groups.map(group=>group.members);
}

export function containsDiscoveryKeyword(value='',keyword='中国限定'){
  const compact=text=>String(text||'').normalize('NFKC').toLowerCase().replace(/\s+/g,'');
  const wanted=compact(keyword);return Boolean(wanted)&&compact(value).includes(wanted);
}

export function mercariSoldEvidence({checkoutText='',text=''}={}){
  return /(?:売り切れ(?:ました)?|sold\s*out)/i.test(String(checkoutText))||
    /売り切れのためコメントできません/i.test(String(text));
}

export function clusterSellerSales(cards=[]){
  const groups=[];
  for(const card of cards){
    if(!card?.title||rejectSale.test(card.title)||isRejected(card.title,true))continue;
    let group=groups.find(candidate=>sameSaleProduct(candidate.representative,card));
    if(!group){group={representative:card,items:[]};groups.push(group)}
    group.items.push(card);
    if(Date.parse(card.soldAt||'')>Date.parse(group.representative.soldAt||''))group.representative=card;
  }
  return groups.sort((a,b)=>b.items.length-a.items.length);
}

export function parseListingTime(value='',now=Date.now()){
  const text=String(value).normalize('NFKC');
  let match=text.match(/(\d+)\s*分前/);if(match)return new Date(now-Number(match[1])*60_000).toISOString();
  match=text.match(/(\d+)\s*時間前/);if(match)return new Date(now-Number(match[1])*3_600_000).toISOString();
  match=text.match(/(\d+)\s*日前/);if(match)return new Date(now-Number(match[1])*86_400_000).toISOString();
  match=text.match(/(\d+)\s*週間前/);if(match)return new Date(now-Number(match[1])*7*86_400_000).toISOString();
  match=text.match(/(\d+)\s*ヶ月前/);if(match)return new Date(now-Number(match[1])*30*86_400_000).toISOString();
  match=text.match(/(?:(\d{4})年)?\s*(\d{1,2})月\s*(\d{1,2})日/);
  if(match){
    let year=Number(match[1]||new Date(now).getFullYear()),date=new Date(Date.UTC(year,Number(match[2])-1,Number(match[3]),3));
    if(!match[1]&&date.getTime()>now+86_400_000)date=new Date(Date.UTC(year-1,Number(match[2])-1,Number(match[3]),3));
    return date.toISOString();
  }
  const parsed=Date.parse(text);return Number.isFinite(parsed)?new Date(parsed).toISOString():null;
}

export function isWithinDays(value,days=30,now=Date.now()){
  const time=Date.parse(value||'');return Number.isFinite(time)&&time<=now+3_600_000&&time>=now-days*86_400_000;
}

export function median(values=[]){
  const numbers=values.map(Number).filter(Number.isFinite).sort((a,b)=>a-b);
  if(!numbers.length)return null;const middle=Math.floor(numbers.length/2);
  return numbers.length%2?numbers[middle]:(numbers[middle-1]+numbers[middle])/2;
}

export function eligibleDiscoveryCard(card={},settings={},now=Date.now()){
  return Boolean(card.sold)&&Number(card.price)>=Number(settings.minPriceJPY||4999)&&
    isWithinDays(card.soldAt,Number(settings.windowDays)||30,now)&&!rejectSale.test(card.title||'')&&
    !hasExplicitDefect(card.title||'',card.description||'');
}

export function sellerIdFromProfile(value=''){
  return (String(value).match(/\/user\/(?:profile\/)?([^/?#]+)/i)||[])[1]||'';
}

export function rotateDiscoverySellers(sellers=[],attempts={},limit=80){
  return [...sellers].sort((a,b)=>(Date.parse(attempts[a.id]||'')||0)-(Date.parse(attempts[b.id]||'')||0)).slice(0,limit);
}

export function nextMercariPage(href='',current=''){
  if(!href)return null;
  try{const url=new URL(href,current),from=new URL(current);
    if(url.origin!=='https://jp.mercari.com'||url.pathname!==from.pathname||url.href===from.href)return null;
    return url.href;
  }catch{return null}
}

export function isOwnedDiscoverySource(card={},owned={}){
  const sellerIds=owned.sellerIds instanceof Set?owned.sellerIds:new Set(owned.sellerIds||[]);
  const itemIds=owned.itemIds instanceof Set?owned.itemIds:new Set(owned.itemIds||[]);
  return Boolean(card.sellerId&&sellerIds.has(String(card.sellerId)))||Boolean(card.id&&itemIds.has(String(card.id)));
}

export function validDiscoveryXianyu(result={}){
  const samples=(result.samples||[]).filter(sample=>Number.isFinite(Number(sample.price))&&!isLikelyVariantOffer(`${sample.title||''} ${sample.text||''}`,result.query||''));
  const richest=samples.map(sample=>({sample,images:[...new Set(sample.independentImages||[])].filter(url=>/^https?:\/\//.test(url))}))
    .sort((a,b)=>b.images.length-a.images.length)[0];
  const images=(richest?.images||[]).slice(0,8);
  const prices=samples.map(sample=>Number(sample.price)).sort((a,b)=>a-b);
  const spread=prices.length>=2?(prices.at(-1)-prices[0])/Math.max(1,prices[Math.floor(prices.length/2)]):Infinity;
  const evidence=verifiedCostEvidence(samples);
  return {ready:result.verification===XIANYU_VERIFICATION&&result.status==='ok'&&evidence.ready&&spread<=.30&&positivePrice(result.averageCNY)!==null&&images.length>=3,
    images,sample:richest?.sample||null,imageSource:images.length>=3?'xianyu_independent_coherent':null,
    sampleCount:evidence.samples.length,sellerCount:evidence.sellerCount,priceSpread:spread};
}

export function discoveryProfit(item={},settings={}){
  const purchaseCNY=positivePrice(item.purchaseCNY),salePriceJPY=positivePrice(item.sourcePriceJPY),cfg=settings.discovery||{};
  if(purchaseCNY===null||salePriceJPY===null)return {ready:false,estimatedCostJPY:null,estimatedNetRevenueJPY:null,estimatedProfitJPY:null,qualified:false};
  const manualFeeCNY=Number(cfg.estimatedManualFeeCNY??10),shippingJPY=Number(cfg.estimatedShippingJPY??750);
  const sellerFeeRate=Number(cfg.sellerFeeRate??0.05),minimumProfitJPY=Number(cfg.minimumProfitJPY??1500);
  const estimatedCostJPY=Math.ceil(((purchaseCNY+manualFeeCNY)*Number(settings.exchangeRate||0)+shippingJPY)*Number(settings.costMultiplier||1));
  const estimatedNetRevenueJPY=Math.floor(salePriceJPY*(1-sellerFeeRate));
  const estimatedProfitJPY=estimatedNetRevenueJPY-estimatedCostJPY;
  return {ready:true,estimatedCostJPY,estimatedNetRevenueJPY,estimatedProfitJPY,qualified:estimatedProfitJPY>=minimumProfitJPY,
    assumptions:{manualFeeCNY,shippingJPY,sellerFeeRate,minimumProfitJPY}};
}

export function salesWindowCounts(saleDates=[],now=Date.now()){
  const dates=saleDates.filter(value=>Number.isFinite(Date.parse(value)));
  return {days2:dates.filter(value=>isWithinDays(value,2,now)).length,
    days7:dates.filter(value=>isWithinDays(value,7,now)).length,
    days30:dates.filter(value=>isWithinDays(value,30,now)).length};
}

export function rankDiscoveryCandidates(candidates=[],{maxProducts=30,minSales=2,perSeller=4,now=Date.now()}={}){
  const ranked=candidates.map(candidate=>{
    const windows=salesWindowCounts(candidate.saleDates||[],now);
    const priorityWindow=windows.days2>=minSales?2:windows.days7>=minSales?7:30;
    return {...candidate,salesWindows:windows,priorityWindow};
  }).sort((a,b)=>a.priorityWindow-b.priorityWindow||
    (a.priorityWindow===2?b.salesWindows.days2-a.salesWindows.days2:a.priorityWindow===7?b.salesWindows.days7-a.salesWindows.days7:b.salesWindows.days30-a.salesWindows.days30)||
    (b.sellerCount||1)-(a.sellerCount||1)||b.salesCount-a.salesCount||b.sourcePriceJPY-a.sourcePriceJPY);
  const selected=[],sellerUsage=new Map();
  // Complete the 2-day tier before 7-day and 30-day tiers. Inside each tier,
  // round-robin sellers and cap each shop so one account cannot fill the page.
  for(const window of [2,7,30]){
    const remaining=ranked.filter(item=>item.priorityWindow===window);
    for(let allowance=1;allowance<=Math.max(1,perSeller)&&selected.length<maxProducts;allowance++){
      for(let index=0;index<remaining.length&&selected.length<maxProducts;){
        const item=remaining[index],key=String(item.seller?.id||item.sellerIds?.[0]||item.sourcePlatform||'unknown');
        if((sellerUsage.get(key)||0)>=allowance){index++;continue}
        selected.push(item);sellerUsage.set(key,(sellerUsage.get(key)||0)+1);remaining.splice(index,1);
      }
    }
  }
  return selected;
}

export function discoveryId(platform,sellerId,title=''){
  return crypto.createHash('sha256').update(`${platform}\n${sellerId}\n${canonicalSaleTitle(title).toLowerCase()}`).digest('hex').slice(0,20);
}

const chineseNames=new Map([
  ['スターバックス','星巴克'],['ステンレス','不锈钢'],['ブルー','蓝色'],['ブラウン','棕色'],['ブラック','黑色'],['ホワイト','白色'],
  ['時透無一郎','时透无一郎'],['不死川実弥','不死川实弥'],['冨岡義勇','富冈义勇'],['富岡義勇','富冈义勇'],['新繹','新绎'],
  ['ジョジョの奇妙な冒険','JOJO的奇妙冒险'],['ジョニィ','乔尼'],['エイリアンステージ','异星舞台'],['ルカ','LUKA'],
  ['一番くじ','一番赏'],['ラストワン賞','最后赏'],['ポルンガ','波仑伽'],['ブラインドボックス','盲盒'],
  ['新繹シリーズ','新绎系列'],['クリア色紙','透明色纸'],['コレクションカード','收藏卡'],['カード','卡牌'],
  ['鬼滅の刃','鬼灭之刃'],['呪術廻戦','咒术回战'],['進撃の巨人','进击的巨人'],['名探偵コナン','名侦探柯南'],
  ['あんさんぶるスターズ','偶像梦幻祭'],['あんスタ','偶像梦幻祭'],['ブルーアーカイブ','碧蓝档案'],['アズールレーン','碧蓝航线'],
  ['ポケットモンスター','宝可梦'],['ポケモン','宝可梦'],['ちいかわ','吉伊卡哇'],['ハチワレ','小八'],['うさぎ','乌萨奇'],
  ['原神','原神'],['鳴潮','鸣潮'],['第五人格','第五人格'],['ドラゴンボール','龙珠'],['ナルト','火影忍者'],['NARUTO','火影忍者'],
  ['アクリルスタンド','亚克力立牌'],['アクスタ','亚克力立牌'],['ぬいぐるみ','毛绒玩偶'],['マスコット','挂件'],
  ['キーホルダー','钥匙扣'],['フィギュア','手办'],['缶バッジ','徽章'],['トレカ','小卡'],['フォトカード','小卡'],
  ['ポストカード','明信片'],['タンブラー','随行杯'],['ボトル','水杯'],['マグカップ','马克杯']
]);

export function xianyuQueryFor(title=''){
  let query=canonicalSaleTitle(title);
  for(const [japanese,chinese] of chineseNames)query=query.replaceAll(japanese,chinese);
  return query.replace(/(?:セット|全\d+種|\d+点|限定品)/gi,match=>match.replace('セット','套装').replace('点','件').replace('限定品','限定'))
    .replace(/\s+/g,' ').trim().slice(0,80);
}

function compactTitle(value,max=40){
  const points=Array.from(value.replace(/\s+/g,' ').trim());return points.length<=max?points.join(''):points.slice(0,max).join('');
}

export function rewriteListing({title='',description='',condition='',saleCount=0}={}){
  let core=canonicalSaleTitle(title).replace(/^(?:中国|上海|北京|広州|深圳)\s*/,'').trim();
  const chinaRelated=/(?:中国|上海|北京|広州|深圳|CHINA|MINISO)/i.test(`${title} ${description}`);
  let proposedTitle=compactTitle(`${chinaRelated?'中国限定 ':''}${core}`);
  if(!proposedTitle)proposedTitle=compactTitle(title);
  const state=/新品|未使用|未開封/.test(condition||description)?'新品・未使用':'商品の状態は掲載画像をご確認ください';
  const body=[
    chinaRelated?'中国限定で販売された、日本では入手しにくいアイテムです。':'海外で販売された、国内では見かける機会の少ないアイテムです。',
    '',`【商品名】${core||title}`,`【状態】${state}`,
    '',saleCount>=2?`同一出品者から直近30日以内に${saleCount}件の販売実績が確認された商品です。`:'',
    '海外製品のため、初期傷・スレ・印刷の個体差などがある場合がございます。',
    '画像をご確認のうえ、海外製品にご理解いただける方のみご購入ください。',
    '', '即購入OKです。匿名配送で発送いたします。'
  ].filter((line,index,array)=>line||array[index-1]!==''&&array[index+1]!=='').join('\n');
  return {proposedTitle,proposedDescription:body};
}

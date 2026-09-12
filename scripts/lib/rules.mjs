const noise = new Set(['中国限定','海外限定','正規品','新品','未使用','未開封','公式','限定','送料無料','匿名配送','即購入ok','即購入OK']);
const badPattern = /(求购|收购|只收|蹲收|换物|交换|置换|补款|定金|尾款|仅展示|勿拍|非实体|电子版|网盘|租赁|出租|标价无意义|价格无意义|标价不实|运费链接|日本代购|煤炉|mercari|已售|售出勿拍|sold|売り切れ|ジャンク|破損|欠品|箱なし|盒损|瑕疵|残次|缺件)/i;
const baitPattern = /(请点进去选项|点击立即购买查看|拍下改价|私聊改价|价格见图|图上价|多个角色|多款可选|任选|标价非实价|自带价|占位价|起步价|最低款价格|标价为最低|标价只是|页面价格不准)/i;
const selectionPattern = /(请选择|选择规格|选择款式|选款|选图|拍哪款|下单备注|联系客服改价|私聊改价|各款价格|价格不一|每款价格|单独询价|需补差价|补差后发货|以详情价为准|详情价格为准)/i;
const multiOfferPattern = /(多款|多角色|全系列|合集|系列任选|整套可拆|可拆卖)/i;

export function normalize(value='') {
  return String(value).toLowerCase().replace(/[\s·・,:：，。!！?？【】\[\]()（）<>《》“”"'‘’\-_/+＋×]/g,'');
}

export function tokens(value='') {
  return String(value).split(/[\s/・·【】\[\]()（）,:：，。!！?？+＋-]+/)
    .map(x=>x.trim()).filter(x=>x.length>1 && !noise.has(x));
}

export function titleScore(query, title) {
  const nt=normalize(title); const ts=tokens(query);
  if (!ts.length) return 0;
  let hit=0,total=0;
  for (const token of ts) {
    const n=normalize(token); const weight=Math.max(2,n.length);
    total+=weight;
    if (nt.includes(n)) hit+=weight;
  }
  return total ? hit/total : 0;
}

export function isRejected(text='', allowBait=false) {
  return badPattern.test(text) || (!allowBait && baitPattern.test(text));
}

// 闲鱼常用系列中最便宜的一款作为卡片标价。只要详情需要选款、改价或补差，
// 就不能把卡片顶部价格当作目标商品的成本。整套/全套查询允许“全系列”字样。
export function isLikelyVariantOffer(text='',query='') {
  if (baitPattern.test(text) || selectionPattern.test(text)) return true;
  const wantsWholeSet=/(全套|整套|套装|全\s*\d+|\d+\s*(?:件|个|枚|种|款)\s*(?:套|全))/i.test(query);
  return multiOfferPattern.test(text) && !wantsWholeSet;
}

export function hasVariantMismatch(query='',candidate='') {
  const q=normalize(query),title=String(candidate);
  const extraPatterns=[
    /(?:全?\s*\d+\s*(?:点|個|枚|種|本|箱|個入|ピース))/gi,
    /(?:\d+\s*(?:box|セット))/gi,
    /(?:まとめ売り|おまけ|おまけ付き|抱き合わせ)/gi,
    /(?:ホログラムチケット|ポストカード|特典カード|缶バッジ)/gi,
    /(?:[A-HＡ-Ｈ]\s*(?:タイプ|type|賞|カラー|色|版|ver(?:sion)?\.?))/gi,
    /(?:(?:タイプ|type|カラー|色|版|ver(?:sion)?\.?)\s*[A-HＡ-Ｈ])/gi
  ];
  for(const pattern of extraPatterns){
    for(const match of title.matchAll(pattern)) if(!q.includes(normalize(match[0]))) return true;
  }
  return false;
}

export function inferSize(title='') {
  if (/(カード|卡片|小卡|色紙|徽章|缶バッジ|アクリル|立牌|项链|ネックレス|手表|腕時計|帽子|ハット)/i.test(title)) return '小';
  if (/(一番賞|フィギュア|手办|ガンダム|高达|MG\s|PG\s|1\/\d+|大型|大号)/i.test(title)) return '大';
  return '中';
}

export function yen(text='') {
  const m=String(text).match(/[¥￥]\s*([0-9][0-9,]*)(?:\s*\.\s*([0-9]{1,2}))?/);
  return m ? Number(m[1].replaceAll(',','')+'.'+(m[2]||'0')) : null;
}

export function average(values=[]) {
  const nums=values.filter(Number.isFinite);
  return nums.length ? nums.reduce((a,b)=>a+b,0)/nums.length : null;
}

export function coherentPrices(samples=[]) {
  const priced=samples.filter(sample=>Number.isFinite(sample.price)).sort((a,b)=>a.price-b.price);
  if(priced.length<2)return [];
  const values=priced.map(sample=>sample.price),middle=Math.floor(values.length/2);
  const median=values.length%2?values[middle]:(values[middle-1]+values[middle])/2;
  return priced.filter(sample=>sample.price>=median*.6&&sample.price<=median*1.67);
}

export function calculateCost(purchaseCNY,manualCNY,shippingJPY,settings) {
  if (![purchaseCNY,manualCNY,shippingJPY].every(Number.isFinite)) return null;
  return Math.ceil(((purchaseCNY+manualCNY)*settings.exchangeRate+shippingJPY)*settings.costMultiplier);
}

export function advice({ownPrice,recommendedPrice,cost,warning}) {
  if (!Number.isFinite(cost)) return '待输入成本';
  const current=ownPrice-cost, after=recommendedPrice-cost;
  if (after<0) return '调价后亏损';
  if (after<warning) return '不建议按推荐价出售';
  if (current<warning) return '建议提价或控制成本';
  return '利润正常';
}

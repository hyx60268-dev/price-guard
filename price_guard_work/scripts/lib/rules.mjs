const noise = new Set(['中国限定','海外限定','正規品','新品','未使用','未開封','公式','限定','送料無料','匿名配送','即購入ok','即購入OK']);
const badPattern = /(求购|收购|只收|蹲收|换物|交换|置换|补款|定金|尾款|仅展示|勿拍|非实体|电子版|网盘|租赁|出租|标价无意义|价格无意义|标价不实|运费链接|日本代购|煤炉|mercari|已售|售出勿拍|sold|売り切れ|ジャンク|破損|欠品|箱なし|盒损|瑕疵|残次|缺件)/i;
const baitPattern = /(请点进去选项|点击立即购买查看|拍下改价|私聊改价|价格见图|图上价|多个角色|多款可选|任选|标价非实价|自带价)/i;

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

export function calculateCost(avgCNY,size,settings) {
  if (!Number.isFinite(avgCNY)) return null;
  const fee=settings.fees[size] || settings.fees['中'];
  return Math.ceil(((avgCNY+fee.manualCNY)*settings.exchangeRate+fee.shippingJPY)*settings.costMultiplier);
}

export function advice({ownPrice,recommendedPrice,cost,warning}) {
  if (!Number.isFinite(cost)) return '需人工补价';
  const current=ownPrice-cost, after=recommendedPrice-cost;
  if (after<0) return '调价后亏损';
  if (after<warning) return '不建议按推荐价出售';
  if (current<warning) return '建议提价或控制成本';
  return '利润正常';
}

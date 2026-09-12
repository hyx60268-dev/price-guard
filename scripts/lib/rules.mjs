const noise = new Set(['中国限定','海外限定','正規品','新品','未使用','未開封','公式','限定','送料無料','匿名配送','即購入ok','即購入OK']);
const badPattern = /(求购|收购|只收|蹲收|换物|交换|置换|补款|定金|尾款|仅展示|勿拍|非实体|电子版|网盘|租赁|出租|标价无意义|价格无意义|标价不实|运费链接|日本代购|煤炉|mercari|已售|售出勿拍|sold|売り切れ|ジャンク|訳あり|難あり|破損|欠品|箱なし|箱潰れ|箱ダメージ|盒损|瑕疵|残次|缺件)/i;
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

function normalizedJapanese(value='') {
  return String(value).normalize('NFKC').toLowerCase();
}

// 商品数を「ペア」「2体」「2点 1セット」のような表記揺れをまたいで比較する。
// 「全8種 ランダム」は8点セットではなくランダム1点として扱う。
export function semanticQuantity(value='') {
  const text=normalizedJapanese(value);
  const random=/(?:ランダム|random|随机)/i.test(text);
  const complete=/全\s*\d+\s*種\s*(?:セット|コンプ)|(?:コンプリート|complete)\s*(?:セット)?/i.test(text);
  if(random&&!complete)return 1;
  const explicit=[...text.matchAll(/(\d+)\s*(?:点|個|体|枚|本|箱|ピース|個入|入り|件)/gi)]
    .map(match=>Number(match[1])).filter(Number.isFinite);
  if(explicit.length)return Math.max(...explicit);
  const allKinds=text.match(/全\s*(\d+)\s*種/i);
  if(allKinds&&complete)return Number(allKinds[1]);
  if(/(?:ペア|pair|カップル|情侣|一対|1対|男女|男の子.{0,12}女の子|boy.{0,12}girl|girl.{0,12}boy)/i.test(text))return 2;
  if(/(?:単品|ばら売り|バラ売り|1\s*(?:点|個|体|枚|本|箱|ピース|件))/i.test(text))return 1;
  return null;
}

function setMultiplier(value='') {
  const matches=[...normalizedJapanese(value).matchAll(/(\d+)\s*セット/gi)]
    .map(match=>Number(match[1])).filter(Number.isFinite);
  return matches.length?Math.max(...matches):null;
}

export function productFamily(value='',category='') {
  const text=normalizedJapanese(`${value} ${category}`);
  if(/(?:アクリルブロック|acrylic\s*block|亚克力砖)/i.test(text))return 'acrylic_block';
  if(/(?:アクリルスタンド|アクスタ|acrylic\s*stand|亚克力立牌|立牌)/i.test(text))return 'acrylic_stand';
  if(/(?:フィギュア|figure|手办|模型雕像)/i.test(text))return 'figure';
  if(/(?:ガンプラ|ガンダム|プラモデル|模型套件|\bmg\b|\bpg\b|\bhg\b|\brg\b)/i.test(text))return 'model_kit';
  if(/(?:ぬいぐるみ|ぬい\b|マスコット|毛绒|娃娃|公仔|category:?2134|\b2134\b)/i.test(text))return 'plush';
  if(/(?:トレカ|フォトカード|ポストカード|カード|色紙|小卡|卡片)/i.test(text))return 'card';
  if(/(?:缶バッジ|徽章|badge)/i.test(text))return 'badge';
  if(/(?:キーホルダー|キーチェーン|ストラップ|key\s*chain|钥匙扣)/i.test(text))return 'keychain';
  if(/(?:タンブラー|ボトル|マグ|カップ|杯)/i.test(text))return 'drinkware';
  if(/(?:ネックレス|ペンダント|ブレスレット|リング|腕時計|项链|手链|戒指)/i.test(text))return 'accessory';
  if(/(?:書籍|写真集|コミック|book|书|(?:^|\s)本(?:\s|$))/i.test(text))return 'book';
  return '';
}

const descriptorPattern=/(?:日本非売品|日本未発売|非売品|中国限定|海外限定|国内限定|正規品|新品|未使用|未開封|公式|限定|希少|レア|コラボレーション|コラボ|シリーズ|セット|まとめ売り|ペア|pair|単品|ランダム|random|全\s*\d+\s*種|\d+\s*(?:点|個|体|枚|本|箱|ピース|個入|入り|件)|ぬいぐるみ|マスコット|キーホルダー|キーチェーン|ストラップ|アクリルスタンド|アクスタ|アクリルブロック|フィギュア|プラモデル|フォトカード|ポストカード|カード|缶バッジ|タンブラー|ボトル|マグ|カップ)/gi;

export function distinctiveTokens(value='') {
  return normalizedJapanese(value).split(/[\s×&＆/／・·,:：，。!！?？【】\[\]()（）<>《》“”"'‘’+＋\-_]+/)
    .map(part=>part.replace(descriptorPattern,'').trim())
    .filter(part=>part.length>1);
}

export function distinctiveCoverage(query='',candidate='') {
  const wanted=[...new Set(distinctiveTokens(query))],haystack=normalize(candidate);
  let matchedWeight=0,totalWeight=0,matchedCount=0,matchedLength=0;
  for(const token of wanted){
    const normalized=normalize(token),weight=Math.max(2,normalized.length);totalWeight+=weight;
    if(normalized&&haystack.includes(normalized)){matchedWeight+=weight;matchedCount++;matchedLength+=normalized.length}
  }
  return {score:totalWeight?matchedWeight/totalWeight:0,matchedCount,matchedLength,tokenCount:wanted.length,tokens:wanted};
}

export function semanticSameItem({query='',candidate='',queryCategory='',candidateCategory=''}={}) {
  if(hasVariantMismatch(query,candidate))return {accepted:false,reason:'variant_mismatch'};
  const evidence=distinctiveCoverage(query,candidate);
  const queryFamily=productFamily(query,queryCategory),candidateFamily=productFamily(candidate,candidateCategory);
  const familyCompatible=!queryFamily||!candidateFamily||queryFamily===candidateFamily;
  const enoughAnchors=evidence.score>=0.78&&(evidence.matchedCount>=2||evidence.matchedLength>=6);
  return {accepted:familyCompatible&&enoughAnchors,reason:familyCompatible?(enoughAnchors?'matched':'weak_anchors'):'product_mismatch',
    queryFamily,candidateFamily,...evidence};
}

// 「海外製品のため傷がある場合がございます」のような一般的な注意書きは除外理由にせず、
// 実物の傷・欠品を明記した行だけを除外する。
export function hasExplicitDefect(title='',description='') {
  if(badPattern.test(title))return true;
  return String(description).split(/[\n。]/).some(line=>{
    if(!/(?:破損|欠品|キズ|傷|汚れ|凹み|割れ|剥がれ|箱潰れ|箱ダメージ)/i.test(line))return false;
    if(/(?:場合|可能性|ことが|あり得|海外製品|海外輸送|製造上|初期.{0,8}(?:場合|可能性)|ご了承ください)/i.test(line))return false;
    return /(?:あります|あり|ございます|しています|見られます|欠けています|付属しません|なし)/i.test(line);
  });
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
  const queryQuantity=semanticQuantity(query),candidateQuantity=semanticQuantity(candidate);
  if(Number.isFinite(candidateQuantity)&&candidateQuantity>1&&!Number.isFinite(queryQuantity))return true;
  // 元商品がペア/複数セットなら、候補側にも同じ個数の明記が必要。
  // 個数不明の単品を安い「同款」として採用しない。
  if(Number.isFinite(queryQuantity)&&queryQuantity>1&&!Number.isFinite(candidateQuantity))return true;
  if(Number.isFinite(queryQuantity)&&Number.isFinite(candidateQuantity)&&queryQuantity!==candidateQuantity)return true;
  const querySets=setMultiplier(query),candidateSets=setMultiplier(candidate);
  if(Number.isFinite(candidateSets)&&candidateSets>1&&candidateSets!==querySets)return true;
  const extraPatterns=[
    /(?:\d+\s*(?:box|セット))/gi,
    /(?:まとめ売り|おまけ|おまけ付き|抱き合わせ)/gi,
    /(?:ホログラムチケット|ポストカード|特典カード|缶バッジ)/gi,
    /(?:[A-HＡ-Ｈ]\s*(?:タイプ|type|賞|カラー|色|版|ver(?:sion)?\.?))/gi,
    /(?:(?:タイプ|type|カラー|色|版|ver(?:sion)?\.?)\s*[A-HＡ-Ｈ])/gi
  ];
  for(const pattern of extraPatterns){
    for(const match of title.matchAll(pattern)){
      // 「1セット」は包装単位なので、元タイトルに「セット」があれば同一数量として扱う。
      if(/^1\s*セット$/i.test(match[0])&&/(?:セット|ペア|pair)/i.test(query))continue;
      if(!q.includes(normalize(match[0])))return true;
    }
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

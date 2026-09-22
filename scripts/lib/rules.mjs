const noise = new Set(['中国限定','海外限定','正規品','新品','未使用','未開封','公式','限定','送料無料','匿名配送','即購入ok','即購入OK']);
const badPattern = /(求购|收购|只收|蹲收|换物|交换|置换|补款|定金|尾款|仅展示|勿拍|非实体|电子版|网盘|租赁|出租|标价无意义|价格无意义|标价不实|运费链接|日本代购|煤炉|mercari|已售|售出勿拍|sold|売り切れ|ジャンク|訳あり|難あり|破損|欠品|箱なし|箱無し|外箱なし|外箱のみ|箱のみ|空箱|パッケージのみ|ボックスのみ|箱だけ|仅外盒|只有盒|盒损|箱潰れ|箱ダメージ|瑕疵|残次|缺件)/i;
const baitPattern = /(请点进去选项|点击立即购买查看|拍下改价|私聊改价|价格见图|图上价|多个角色|多款可选|任选|标价非实价|自带价|占位价|起步价|最低款价格|标价为最低|标价只是|页面价格不准)/i;
const selectionPattern = /(请选择|选择规格|选择款式|选款|选图|拍哪款|下单备注|联系客服改价|私聊改价|各款价格|价格不一|每款价格|单独询价|需补差价|补差后发货|以详情价为准|详情价格为准)/i;
const multiOfferPattern = /(多款|多角色|全系列|合集|系列任选|整套可拆|可拆卖)/i;
export const MATCHING_RULES_VERSION = 8;

// 同じIP/シリーズが中国語・日本語・英語や作者名で出品されるケースを、
// 再利用できる別名辞書で同じ識別語へ寄せる。追加時は商品固有語だけを登録し、
// 「熊」「フィギュア」のような一般語は絶対に別名扱いしない。
function canonicalProductText(value='') {
  return String(value).normalize('NFKC')
    // Yahoo sellers use several Japanese/Chinese spellings (and one common typo)
    // for this same Pokemon collection name.  Keep this product-specific alias
    // here rather than weakening the generic token matcher.
    .replace(/(?:絵夢点睛|絵夢点晴|绘梦点睛|繪夢點睛|梦点睛|夢点睛)/gi,' emutenkai ')
    .replace(/(?:greedy\s*bear|greedybear|貪吃熊|贪吃熊|食いしん坊(?:クマ|熊|ベア)|くいしんぼう(?:クマ|熊|ベア))/gi,' greedybear ')
    .replace(/(?:sure\s*fun|surefun|may\s*mei|maymei|メイメイ)/gi,' maymei ')
    .replace(/(?:metheus|薪火)/gi,' metheus ')
    .replace(/pet\s*(?:フォトカード|相卡|合影卡|透卡|拍立得)/gi,' photocard ')
    .replace(/(?:フォトカード|相卡|合影卡|透卡|拍立得)/gi,' photocard ');
}

export function normalize(value='') {
  return canonicalProductText(value).toLowerCase().replace(/[\s·・,:：，。!！?？【】\[\]()（）<>《》“”"'‘’\-_/+＋×]/g,'');
}

export function tokens(value='') {
  return canonicalProductText(value).split(/[\s/・·【】\[\]()（）,:：，。!！?？+＋-]+/)
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

export function listingTextEquivalent(ownTitle='',ownDescription='',candidateTitle='',candidateDescription=''){
  if(hasVariantMismatch(ownTitle,candidateTitle)||hasVariantMismatch(candidateTitle,ownTitle))return false;
  const titleForward=titleScore(ownTitle,candidateTitle),titleBackward=titleScore(candidateTitle,ownTitle);
  if(titleForward<.88||titleBackward<.82)return false;
  const clean=value=>normalize(String(value).replace(/即購入.*|匿名配送.*|送料無料.*|ご覧いただきありがとうございます。?/gi,' '));
  const own=clean(ownDescription),candidate=clean(candidateDescription);
  if(own.length>=8&&own===candidate)return true;
  if(own.length<16||candidate.length<16)return false;
  const shorter=own.length<=candidate.length?own:candidate,longer=own.length<=candidate.length?candidate:own;
  return longer.includes(shorter)&&shorter.length/longer.length>=.75;
}

// 同一套装常见「10ピース入り / 10体セット」等表记差异。标题不必逐字接近，
// 但品牌/系列锚点、商品类型和明确数量都一致时，可作为图片不同情况下的规格证据。
export function listingSpecificationEquivalent(ownTitle='',candidateTitle='',ownCategory='',candidateCategory=''){
  if(hasVariantMismatch(ownTitle,candidateTitle)||hasVariantMismatch(candidateTitle,ownTitle))return false;
  if(!saleUnitEquivalent(ownTitle,candidateTitle))return false;
  const forward=semanticSameItem({query:ownTitle,candidate:candidateTitle,queryCategory:ownCategory,candidateCategory});
  const backward=semanticSameItem({query:candidateTitle,candidate:ownTitle,queryCategory:candidateCategory,candidateCategory:ownCategory});
  if(!forward.accepted||!backward.accepted)return false;
  const ownFamily=productFamily(ownTitle,ownCategory),candidateFamily=productFamily(candidateTitle,candidateCategory);
  if(!ownFamily||ownFamily!==candidateFamily)return false;
  const ownQuantity=semanticQuantity(ownTitle),candidateQuantity=semanticQuantity(candidateTitle);
  if(!Number.isFinite(ownQuantity)||ownQuantity!==candidateQuantity)return false;
  return Math.min(forward.matchedLength,backward.matchedLength)>=8&&
    Math.min(forward.matchedCount,backward.matchedCount)>=2;
}

function normalizedJapanese(value='') {
  return String(value).normalize('NFKC').toLowerCase();
}

// 商品数を「ペア」「2体」「2点 1セット」のような表記揺れをまたいで比較する。
// 「全8種 ランダム」は8点セットではなくランダム1点として扱う。
export function semanticQuantity(value='') {
  const text=normalizedJapanese(value);
  const random=/(?:ランダム|random|随机)/i.test(text);
  // 「BOX 6種セット」「6種コンプリート」は6点の商品。説明文に
  // 「ランダム封入」があっても、出品単位そのものを1点に落としてはいけない。
  const kindSets=[...text.matchAll(/(?:全\s*)?(\d+)\s*種\s*(?:セット|コンプ(?:リート)?|complete|入り|入|box|ボックス)|(?:box|ボックス|アソート)\s*(\d+)\s*種/gi)]
    .flatMap(match=>[Number(match[1]),Number(match[2])]).filter(Number.isFinite);
  const complete=kindSets.length>0||/(?:コンプリート|complete|フルコンプ)\s*(?:セット)?/i.test(text);
  const explicit=[...text.matchAll(/(\d+)\s*(?:点|個|体|枚|本|箱|ピース|個入|入り|件|キャラクター|キャラ)/gi)]
    .map(match=>Number(match[1])).filter(Number.isFinite);
  if(kindSets.length)return Math.max(...kindSets);
  if(explicit.length)return Math.max(...explicit);
  if(random&&!complete)return 1;
  const allKinds=text.match(/全\s*(\d+)\s*種/i);
  if(allKinds&&complete)return Number(allKinds[1]);
  if(/(?:ペア|pair|カップル|情侣|一対|1対|男女|男の子.{0,12}女の子|boy.{0,12}girl|girl.{0,12}boy)/i.test(text))return 2;
  if(/(?:単品|ばら売り|バラ売り|1\s*(?:点|個|体|枚|本|箱|ピース|件))/i.test(text))return 1;
  return null;
}

// 同じ数量でも、未開封アソートBOXと箱なしの6体まとめ売りは別条件。
// 画像が公式の集合写真で一致しても、販売単位が違えば同款にはしない。
export function saleUnitProfile(value='') {
  const text=normalizedJapanese(value);
  const fullBox=/(?:アソート\s*(?:box|ボックス|ケース)|\d+\s*(?:box|ボックス|ケース)|(?:box|ボックス|ケース).{0,12}\d+\s*(?:個|点|体|種|ピース)|\d+\s*(?:個|点|体|種|ピース)(?:入り|入|セット)?.{0,12}(?:アソート\s*)?(?:box|ボックス|ケース))/i.test(text);
  const completeSet=/(?:フルコンプ|コンプリート(?:セット)?|(?:全\s*)?\d+\s*種\s*(?:セット|コンプ(?:リート)?|complete))/i.test(text);
  const explicitSingle=/(?:単品|ばら売り|バラ売り|1\s*(?:点|個|体|枚|本|ピース))(?:\s|$|[、。・])/i.test(text);
  return {fullBox,completeSet,explicitSingle};
}

export function saleUnitEquivalent(query='',candidate='') {
  const left=saleUnitProfile(query),right=saleUnitProfile(candidate);
  if(left.fullBox||right.fullBox)return left.fullBox&&right.fullBox;
  if(left.completeSet||right.completeSet)return left.completeSet&&right.completeSet;
  return !(left.explicitSingle&&right.completeSet||right.explicitSingle&&left.completeSet);
}

function setMultiplier(value='') {
  const matches=[...normalizedJapanese(value).matchAll(/(\d+)\s*セット/gi)]
    .map(match=>Number(match[1])).filter(Number.isFinite);
  return matches.length?Math.max(...matches):null;
}

export function productFamily(value='',category='') {
  const text=normalizedJapanese(`${value} ${category}`);
  if(/(?:レーザーチケット|ホログラムチケット|チケット|ticket|票卡|镭射票)/i.test(text))return 'ticket';
  if(/(?:シールウエハース|ウエハースシール|ステッカー|sticker|贴纸|贴片)/i.test(text))return 'sticker';
  if(/(?:アクリルブロック|シーンブロック|acrylic\s*block|scene\s*block|亚克力砖)/i.test(text))return 'acrylic_block';
  // 流砂/オイル入り/シェイカーは通常の平面アクリルスタンドとは別商品。
  if(/(?:流砂|流沙|オイル入り|オイルアクリル|シェイカー|shaker)\s*(?:アクリル|acrylic)?|(?:アクリル|acrylic).{0,8}(?:流砂|流沙|オイル入り|シェイカー|shaker)/i.test(text))return 'acrylic_shaker';
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

export function conditionProfile(value=''){
  const text=normalizedJapanese(value);
  return {
    boxOnly:/(?:外箱のみ|箱のみ|空箱|パッケージのみ|ボックスのみ|箱だけ|仅外盒|只有盒|空盒)/i.test(text),
    noBox:/(?:箱なし|箱無し|外箱なし|箱はありません|本体のみ|无盒|没有盒)/i.test(text),
    // 「未開封品」の中の「開封品」を中古扱いしない。
    openedOrUsed:/(?:中古|開封済|(?<!未)開封品|開封しています|飾って|展示品|使用済|使用感|組立済|二手|已开封|展示过)/i.test(text),
    sealedNew:/(?:新品未開封|新品・未開封|未開封|未拆封|全新未拆)/i.test(text),
    newUnused:/(?:新品[、・]?未使用|新品、未使用|新品未使用|未使用品|(?:^|[\s\n・])未使用(?:$|[\s\n・])|全新未使用|全新仅拆(?:确认|外盒|查看|验货)?|仅拆确认(?:角色)?)/i.test(text)
  };
}

// 完整商品与“仅外盒”永不等价；自己的商品明确为新品/未拆时，候选也必须
// 明确保持相同状态，不能用开封、展示、二手或无盒商品压低最低价。
export function conditionCompatible(query='',candidate=''){
  const own=conditionProfile(query),other=conditionProfile(candidate);
  if(other.boxOnly)return false;
  if((own.sealedNew||own.newUnused)&&(other.openedOrUsed||other.noBox))return false;
  if(own.sealedNew&&!(other.sealedNew||other.newUnused))return false;
  if(own.newUnused&&!own.sealedNew&&!(other.newUnused||other.sealedNew))return false;
  return true;
}

const descriptorPattern=/(?:日本非売品|日本未発売|非売品|中国限定|海外限定|国内限定|正規品|新品|未使用|未開封|公式|限定|希少|レア|即発送|即日発送|送料無料|匿名配送|コラボレーション|コラボ|シリーズ|series|セット|まとめ売り|ペア|pair|単品|ランダム|random|\d+\s*周年(?:記念)?|第\s*\d+\s*弾|(?:全\s*)?\d+\s*種|\d+\s*(?:小箱|点|個|体|枚|本|箱|ピース|個入|入り|件)|入り|被りなし|重複なし|ブラインドボックス|アソート\s*(?:box|ボックス)|box|コレクション|ぬいぐるみ|マスコット|キーホルダー|キーチェーン|ストラップ|アクリルスタンド|アクスタ|アクリルブロック|シーンブロック|フィギュア|プラモデル|写真集|書籍|フォトカード|ポストカード|カード|缶バッジ|タンブラー|ボトル|マグ|カップ|特典(?:カード)?付き|おまけ付き)/gi;

export function distinctiveTokens(value='') {
  return canonicalProductText(value).toLowerCase().split(/[\s×&＆/／・·,:：，。!！?？【】\[\]()（）<>《》「」『』“”"'‘’+＋\-_]+/)
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

function hasVariantMarkerMismatch(query='',candidate='') {
  const q=normalize(query),title=String(candidate);
  // A/B版のような裸の記号は商品名（先頭行）だけを見る。説明文の「Cマーク」
  // （正規品証明）までC版と誤読して別商品扱いしない。
  const heading=value=>String(value).split(/\r?\n/).map(line=>line.trim()).find(Boolean)||'';
  const standaloneMarkers=value=>new Set([...normalizedJapanese(heading(value)).toUpperCase().matchAll(/(?:^|[\s　・:：【】()（）])([A-H])(?=$|[\s　・:：【】()（）])/g)].map(match=>match[1]));
  const queryMarkers=standaloneMarkers(query),candidateMarkers=standaloneMarkers(candidate);
  if([...candidateMarkers].some(marker=>!queryMarkers.has(marker)))return true;
  const querySets=setMultiplier(query),candidateSets=setMultiplier(candidate);
  if(Number.isFinite(candidateSets)&&candidateSets>1&&candidateSets!==querySets)return true;
  const extraPatterns=[
    /(?:\d+\s*(?:box|セット))/gi,
    /(?:まとめ売り|抱き合わせ)/gi,
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

function setFromMatches(value,patterns=[]){
  const text=normalizedJapanese(value).toUpperCase(),result=new Set();
  for(const [pattern,normalizeMatch] of patterns)for(const match of text.matchAll(pattern))result.add(normalizeMatch(match));
  return result;
}

function listingHeading(value=''){
  return String(value).split(/\r?\n|。/).map(line=>line.trim()).find(Boolean)||'';
}

// ブランド・作品・シリーズが同じでも、両タイトルに互いに存在しない固有語が
// ある場合は別商品として扱う。これにより角色名、書籍の副題、シリーズ内の款式名
// （例: Mute Mode / My Channel）を画像類似度やYahoo推薦が上書きできなくなる。
// 説明文には関連商品名が多数現れるため、比較対象は必ず商品名の先頭行だけにする。
function namedIdentityConflict(query='',candidate=''){
  const leftHeading=listingHeading(query),rightHeading=listingHeading(candidate);
  const leftText=normalize(leftHeading),rightText=normalize(rightHeading);
  const strong=token=>{
    const value=normalize(token);
    return value.length>=4||(/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u.test(value)&&value.length>=2);
  };
  const uniqueStrong=(source,targetText)=>[...new Set(distinctiveTokens(source).map(normalize))]
    .filter(token=>token&&strong(token)&&!targetText.includes(token));
  const leftOnly=uniqueStrong(leftHeading,rightText),rightOnly=uniqueStrong(rightHeading,leftText);
  return leftOnly.length>0&&rightOnly.length>0;
}

// 抽選フィギュアの「A賞 / ラストワン賞」やタロットの「V / XX」は、
// 作品名・角色・商品类型が同じでも商品そのものを特定する識別子。
export function identityVariantFacets(value=''){
  const upper=normalizedJapanese(value).toUpperCase();
  const prizes=setFromMatches(upper,[
    [/(?:ラストワン|LAST\s*ONE)\s*賞?/g,()=> 'LAST_ONE'],
    [/(?:^|[^A-Z0-9])([A-H])\s*賞/g,match=>`${match[1]}_PRIZE`],
    [/(?:^|[^0-9])([1-9]|10)\s*等\s*賞/g,match=>`${match[1]}_PRIZE`]
  ]);
  const tarot=new Set();
  if(/(?:タロット|TAROT)/i.test(upper)){
    for(const match of upper.matchAll(/(?:^|[\s　・:：【】()（）])((?:XXI|XX|XIX|XVIII|XVII|XVI|XV|XIV|XIII|XII|XI|X|IX|VIII|VII|VI|V|IV|III|II|I)|(?:[0-9]|1[0-9]|2[01]))(?=$|[\s　・:：【】()（）])/g))tarot.add(match[1]);
  }
  const tarotNames=/(?:タロット|TAROT)/i.test(upper)?setFromMatches(upper,[
    [/(愚者|魔術師|女教皇|女帝|皇帝|教皇|恋人|戦車|力|隠者|運命の輪|正義|吊るされた男|死神|節制|悪魔|塔|星|月|太陽|審判|世界|THE\s+FOOL|THE\s+MAGICIAN|THE\s+HIGH\s+PRIESTESS|THE\s+EMPRESS|THE\s+EMPEROR|THE\s+HIEROPHANT|THE\s+LOVERS|THE\s+CHARIOT|STRENGTH|THE\s+HERMIT|WHEEL\s+OF\s+FORTUNE|JUSTICE|THE\s+HANGED\s+MAN|DEATH|TEMPERANCE|THE\s+DEVIL|THE\s+TOWER|THE\s+STAR|THE\s+MOON|THE\s+SUN|JUDGEMENT|JUDGMENT|THE\s+WORLD)/g,match=>match[1].replace(/\s+/g,'_')]
  ]):new Set();
  const waves=setFromMatches(upper,[[/第\s*(\d+)\s*弾/g,match=>match[1]]]);
  const anniversaries=setFromMatches(upper,[[/(\d+)\s*周年/g,match=>match[1]]]);
  return {prizes,tarot,tarotNames,waves,anniversaries};
}

function disjointNonEmpty(left,right){return left.size>0&&right.size>0&&![...left].some(value=>right.has(value))}

// Ichiban Kuji often reuses the same character, prize letter and MASTERLISE name
// across completely different releases.  The words between "一番くじ" and the
// prize marker are therefore part of the product identity (e.g. 忍ノ絆,
// 風影奪還編, 波の国編).  Collect every such prefix from the title and the first
// description lines so a seller that omits the release name from the title can
// still be verified from the description.
function lotteryPrefixTokens(value=''){
  const text=canonicalProductText(String(value)).slice(0,1200),result=new Set();
  for(const match of text.matchAll(/一番くじ/gi)){
    const window=text.slice(match.index,match.index+180);
    const prize=window.search(/(?:ラストワン|[A-HＡ-Ｈ])\s*賞/i);
    if(prize<0)continue;
    for(const token of distinctiveTokens(window.slice(0,prize))){
      let normalized=normalize(token);
      if(normalized==='ナルト')normalized='naruto';
      if(normalized&&normalized!=='一番くじ')result.add(normalized);
    }
  }
  return result;
}

function lotterySeriesDelta(query='',candidate=''){
  const left=lotteryPrefixTokens(query),right=lotteryPrefixTokens(candidate);
  if(!left.size||!right.size)return {applicable:false,leftOnly:new Set(),rightOnly:new Set()};
  return {
    applicable:true,
    leftOnly:new Set([...left].filter(token=>!right.has(token))),
    rightOnly:new Set([...right].filter(token=>!left.has(token)))
  };
}

export function hasLotterySeriesMismatch(query='',candidate=''){
  const delta=lotterySeriesDelta(query,candidate);
  return delta.applicable&&delta.leftOnly.size>0&&delta.rightOnly.size>0;
}

// If only one listing states the release subtitle, text/recommendation evidence
// is not enough.  Yahoo must confirm the same package at the strong visual
// threshold; otherwise two different A-prize figures of the same character mix.
export function lotterySeriesNeedsVisualConfirmation(query='',candidate=''){
  const delta=lotterySeriesDelta(query,candidate);
  return delta.applicable&&!hasLotterySeriesMismatch(query,candidate)&&
    (delta.leftOnly.size>0||delta.rightOnly.size>0);
}

export function hasIdentityVariantMismatch(query='',candidate=''){
  const left=identityVariantFacets(query),right=identityVariantFacets(candidate);
  return disjointNonEmpty(left.prizes,right.prizes)||disjointNonEmpty(left.tarot,right.tarot)||
    disjointNonEmpty(left.tarotNames,right.tarotNames)||disjointNonEmpty(left.waves,right.waves)||
    disjointNonEmpty(left.anniversaries,right.anniversaries)||hasLotterySeriesMismatch(query,candidate)||namedIdentityConflict(query,candidate);
}

export function lotterySeriesEquivalent(query='',candidate=''){
  const delta=lotterySeriesDelta(query,candidate);
  if(!delta.applicable||delta.leftOnly.size||delta.rightOnly.size)return false;
  const queryHeading=listingHeading(query),candidateHeading=listingHeading(candidate);
  if(hasIdentityVariantMismatch(queryHeading,candidateHeading)||hasIdentityVariantMismatch(candidateHeading,queryHeading))return false;
  const left=identityVariantFacets(queryHeading),right=identityVariantFacets(candidateHeading);
  if(!left.prizes.size||!right.prizes.size||![...left.prizes].some(prize=>right.prizes.has(prize)))return false;
  const forward=distinctiveCoverage(queryHeading,candidateHeading),backward=distinctiveCoverage(candidateHeading,queryHeading);
  // One title may omit the release subtitle while its description supplies it;
  // in that case the shorter heading must be a strong subset of the fuller one.
  return Math.max(forward.score,backward.score)>=.85&&Math.min(forward.matchedCount,backward.matchedCount)>=4;
}

// “未写数量”只是未知，不是明确冲突。它可以进入详情图片核验，但不能仅靠文字
// 直接成为同款；明确写了单品/2体、A/B版或不同套数时仍是硬冲突。
export function hasExplicitVariantMismatch(query='',candidate=''){
  if(hasIdentityVariantMismatch(query,candidate))return true;
  const queryQuantity=semanticQuantity(query),candidateQuantity=semanticQuantity(candidate);
  if(Number.isFinite(queryQuantity)&&Number.isFinite(candidateQuantity)&&queryQuantity!==candidateQuantity)return true;
  return hasVariantMarkerMismatch(query,candidate);
}

export function hasVariantMismatch(query='',candidate='') {
  if(hasExplicitVariantMismatch(query,candidate))return true;
  const queryQuantity=semanticQuantity(query),candidateQuantity=semanticQuantity(candidate);
  if(Number.isFinite(candidateQuantity)&&candidateQuantity>1&&!Number.isFinite(queryQuantity))return true;
  // 文字判定时，元商品がペア/複数セットなら候補にも同じ個数の明記を要求する。
  // 图片强证据会使用上面的 explicit 版本，把“未写数量”留给详情核验。
  if(Number.isFinite(queryQuantity)&&queryQuantity>1&&!Number.isFinite(candidateQuantity))return true;
  return false;
}

// 同じ本体に「特典カード付き」「おまけ付き」と書かれた競合は、購入者から見れば
// より条件のよい同款であり、別商品として捨ててはいけない。一方、数量・版・本体の
// 種類が食い違う候補は、画像が流用されていても同款にしない。
export function visualListingEquivalent({query='',candidate='',queryCategory='',candidateCategory='',imageScore=null,threshold=.86}={}) {
  if(!Number.isFinite(imageScore)||imageScore<threshold)return false;
  if(hasExplicitVariantMismatch(query,candidate)||hasExplicitVariantMismatch(candidate,query))return false;
  if(!saleUnitEquivalent(query,candidate))return false;
  const queryQuantity=semanticQuantity(query),candidateQuantity=semanticQuantity(candidate);
  // 多件套的官方集合图很容易被单品卖家复用。多件商品必须在双方详情里都能
  // 读出相同数量，不能再只凭相似图片越过数量核验。
  if((Number.isFinite(queryQuantity)&&queryQuantity>1||Number.isFinite(candidateQuantity)&&candidateQuantity>1)&&
    (!Number.isFinite(queryQuantity)||!Number.isFinite(candidateQuantity)||queryQuantity!==candidateQuantity))return false;
  const queryFamily=productFamily(query,queryCategory),candidateFamily=productFamily(candidate,candidateCategory);
  if(!queryFamily||queryFamily!==candidateFamily)return false;
  const forward=distinctiveCoverage(query,candidate),backward=distinctiveCoverage(candidate,query);
  return Math.max(forward.matchedCount,backward.matchedCount)>=2&&Math.max(forward.matchedLength,backward.matchedLength)>=4;
}

// A sealed outer blind-box and the seller wording "12 small boxes" describe the
// same sale unit for some imported collectibles.  Their photos can be the exact
// same printed carton but score lower after perspective/background changes.  This
// narrow path still requires a strong image, identical family and shared product
// identity; explicit wave/anniversary/character conflicts remain hard failures.
export function packagedAssortmentEquivalent({query='',candidate='',queryCategory='',candidateCategory='',imageScore=null,threshold=.66}={}) {
  if(!Number.isFinite(imageScore)||imageScore<threshold)return false;
  const queryHeading=listingHeading(query),candidateHeading=listingHeading(candidate);
  if(hasIdentityVariantMismatch(queryHeading,candidateHeading)||hasIdentityVariantMismatch(candidateHeading,queryHeading))return false;
  const queryQuantity=semanticQuantity(queryHeading),candidateQuantity=semanticQuantity(candidateHeading);
  if(Number.isFinite(queryQuantity)&&Number.isFinite(candidateQuantity)&&queryQuantity!==candidateQuantity)return false;
  const queryFamily=productFamily(query,queryCategory),candidateFamily=productFamily(candidate,candidateCategory);
  if(!queryFamily||queryFamily!==candidateFamily)return false;
  const forward=distinctiveCoverage(queryHeading,candidateHeading),backward=distinctiveCoverage(candidateHeading,queryHeading);
  if(Math.min(forward.score,backward.score)<.78||Math.min(forward.matchedCount,backward.matchedCount)<2)return false;
  const left=saleUnitProfile(queryHeading),right=saleUnitProfile(candidateHeading);
  const smallBoxSet=value=>/\d+\s*小箱\s*(?:セット|入り|入)?/i.test(normalizedJapanese(value));
  return left.fullBox&&right.fullBox||left.fullBox&&smallBoxSet(candidateHeading)||right.fullBox&&smallBoxSet(queryHeading);
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

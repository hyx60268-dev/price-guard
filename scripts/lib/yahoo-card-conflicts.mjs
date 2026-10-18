import {identityVariantFacets} from './rules.mjs';

// A pure, deliberately narrow rejection-only precheck. Call after the independent
// price/ownership gates and before requesting images or competitor detail. The
// caller must bind ownDetail to the current own listing and retain the original
// observation clocks. Neither price, images, categories nor cached verifier
// reasons are evidence here. An unresolved result always needs the normal detail
// verification; even identical titles are never accepted by this function.
export const YAHOO_CARD_CONFLICT_VERSION=1;
export const YAHOO_CARD_CONFLICT_REASONS=Object.freeze([
 'card_conflict_missing_text','card_conflict_text_bounds','card_conflict_ambiguous_text','card_conflict_ambiguous_terms',
 'explicit_card_defect','explicit_card_packaging_mismatch','explicit_card_condition_mismatch',
 'explicit_card_sale_unit_mismatch','explicit_card_quantity_mismatch','explicit_card_variant_mismatch',
 'explicit_card_required_bonus_absent','explicit_card_product_type_mismatch','no_definitive_card_conflict'
]);
const result=(classification,reason)=>({classification,reason});
const unresolved=reason=>result('unresolved',reason);
const conflict=reason=>result('definitive_conflict',reason);
const normalize=text=>text.normalize('NFKC').replace(/(蓝色|藍色|棕色|黑色|白色|粉色|绿色|綠色|紫色|红色|紅色|黄色|黃色)/g,
 value=>` ${{蓝色:'ブルー',藍色:'ブルー',棕色:'ブラウン',黑色:'ブラック',白色:'ホワイト',粉色:'ピンク',绿色:'グリーン',綠色:'グリーン',紫色:'パープル',红色:'レッド',紅色:'レッド',黄色:'イエロー',黃色:'イエロー'}[value]} `);
const uncertain=/(?:…|‥|\.{2,}|\? |[?？]$|省略|以下略|場合|可能性|かもしれ|不明|未確認|要確認|選べる|選択|選款|任选|可选|いずれか|または|もしくは|(?:バラ売り|ばら売り|単品)(?:も)?可|\bor\b)/i;
const negativeOrReference=/(?:では(?:ない|なく|ありません)|じゃ(?:ない|なく)|では無い|不是|並非|并非|not\b|非売品では|見本|参考|イメージ|用の|対応|検索用|関連商品)/i;
const typeRules=[
 ['figure',/(?:フィギュア|\bfigures?\b|手办|手辦|模型雕像)/i],
 ['acrylic_stand',/(?:アクリルスタンド|アクスタ|acrylic\s*stand|亚克力立牌|亞克力立牌|立牌)/i],
 ['acrylic_block',/(?:アクリルブロック|シーンブロック|acrylic\s*block|亚克力砖)/i],
 ['acrylic_shaker',/(?:流砂|流沙|オイルアクリル|シェイカー|shaker)/i],
 ['card',/(?:トレカ|フォトカード|ポストカード|カード|小卡|卡片|\bcards?\b)/i],
 ['plush',/(?:ぬいぐるみ|毛绒|毛絨|\bplush\b)/i],
 ['book',/(?:書籍|写真集|コミック|画集|\bbooks?\b|写真书|寫真書)/i],
 ['badge',/(?:缶バッジ|徽章|\bbadge\b)/i],
 ['neck_pillow',/(?:ネックピロー|neck\s*pillow|颈枕|頸枕)/i],
 ['drinkware',/(?:タンブラー|ボトル|マグカップ|水筒|\btumbler\b|\bbottle\b)/i]
];
// Only an explicit INCLUDED accessory can be removed. "フィギュア 特典カード
// のみ" and other mixed/parts-only headings remain unresolved, never figure.
const includedAccessory=/(?:特典|おまけ)\s*(?:の)?\s*(?:アクリルスタンド|アクスタ|フォトカード|ポストカード|カード|缶バッジ)\s*(?:\d+\s*(?:枚|個|点))?\s*(?:付き(?!では|でない)|付属(?:します|あり|(?=$|[\s、。・+＋]))|付(?=$|[\s、。・+＋]))/g;
function mainHeading(value){return value.replace(includedAccessory,' ')}
function types(value){return new Set(typeRules.filter(([,pattern])=>pattern.test(value)).map(([name])=>name))}
function bonus(value){
 const absentPattern=/特典(?:カード)?\s*(?:は|が)?\s*(?:付きでは(?:ありません|ない)|付属(?:しません|しない|していません|していない|なし|無し)|付いて(?:いません|いない|ない)|付きません|ありません|なし|無し|欠品)/g;
 const absent=absentPattern.test(value);absentPattern.lastIndex=0;
 const rest=value.replace(absentPattern,' ');
 const included=/特典(?:カード)?\s*(?:は|が)?\s*(?:付き|付属(?:します|する|しています|あり|(?=$|[\s、。・+＋]))|付(?=$|[\s、。・+＋])|あり|有り)/.test(rest);
 return {included,absent,rest};
}
function saleLines(title,description=''){
 // The title and direct sale statements only. Long promotional paragraphs,
 // manufacturing warnings and per-inner-box contents are not sale quantities.
 const lines=description.split(/[\n。]/),kept=[title];let innerContents=false;
 for(const raw of lines){
  const line=raw.trim();
  if(/(?:1個|一個|1箱|小箱)(?:の内容|あたり|当たり)/.test(line))innerContents=true;
  if(innerContents||line.length>160||uncertain.test(line)||negativeOrReference.test(line)||
   /(?:ラインナップ|通常\d+種|シークレット|小箱|各|封入|ランダム|送料|発送|梱包|購入日|購入時|サイズ|全高|素材|他にも)/.test(line))continue;
  kept.push(line);
 }
 return kept.join('\n');
}
function condition(value){
 const withoutBonus=bonus(value).rest;
 // Negated defects are not positive defects. A real different defect can still
 // be stated alongside "傷なし"; matched negative spans are removed first.
 const clean=withoutBonus.replace(/(?:傷|キズ|きず|汚れ|破損|欠品|箱潰れ|箱ダメージ)\s*(?:は|が)?\s*(?:なし|無し|ありません|ない|無しです)/g,' ')
  .replace(/(?:无|無|没有|沒有)(?:瑕疵|残次|破损|破損|缺件|缺损|划痕|污渍)/g,' ')
  .replace(/(?:外)?箱(?:のみ|だけ)(?:確認のため|確認の為|を)?開封/g,'外箱開封');
 const defect=/(?:ジャンク|訳あり|難あり|破損品|破損あり|破損有り|破損しています|欠品あり|欠品有り|パーツ欠品|部品欠品|付属品欠品|箱潰れ|箱ダメージ|(?:傷|キズ|きず|汚れ|割れ|凹み|へこみ|塗装剥がれ)(?:あり|有り|有)|瑕疵あり|有瑕疵|缺件|残次品)/i.test(clean);
 const sealed=/(?:未開封|未拆封|全新未拆)/.test(clean);
 const unused=/(?:新品|未使用|全新)/.test(clean.replace(/新品同様|未使用に近い|接近全新/g,' '));
 const used=/(?:中古|使用済み?|(?<!未)使用品|展示品|展示済|展示过|展示過|二手)/.test(clean);
 const opened=/(?<!未)(?:開封済み?|開封品)|已开封|已開封/.test(clean);
 const boxOnly=/(?:外箱のみ|箱のみ|空箱|パッケージのみ|ボックスのみ|箱だけ|仅外盒|只有盒|空盒)/.test(clean);
 const noBox=/(?:箱なし|箱無し|外箱なし|箱はありません|无盒|無盒|没有盒)/.test(clean);
 const boxed=sealed||/(?:箱付き|箱付属|外箱付き|外箱付属|箱あり|箱有り|原包装|原包裝)/.test(clean);
 const mainIncluded=/(?:本体(?:あり|有り|付き|付属)|本体と|本体・)/.test(clean);
 return {defect,sealed,unused,used,opened,boxOnly,noBox,boxed,mainIncluded,
  ambiguous:sealed&&opened||used&&unused||boxed&&noBox||boxOnly&&mainIncluded};
}
function unit(value){
 const useful=value.replace(/(?:単品|バラ売り|ばら売り)(?:販売|出品)?(?:不可|禁止|しません|しない|なし|無し)/g,' ').split('\n').filter(line=>!/(?:特典|おまけ|付属|対応カード|全\d+種類|1個の内容)/.test(line)).join('\n');
 const counts=new Set([...useful.matchAll(/(?:^|[^\d])([1-9]\d{0,3})\s*(?:点|個|体|枚|本|冊|ピース)(?=$|[\s、。・/]|セット|入り|入|のみ|だけ|組|まとめ売り)/g)].map(match=>Number(match[1])));
 for(const match of useful.matchAll(/(?:全\s*)?([1-9]\d{0,3})\s*種\s*(?:セット|コンプリート|コンプ)/g))counts.add(Number(match[1]));
 const fullBox=/(?:\b[1-9]\d*\s*box\b|未開封\s*(?:box|ボックス)|(?:box|ボックス)\s*(?:単位|販売|売り)|アソート\s*(?:box|ボックス)|整盒|端盒|整箱)/i.test(useful);
 const explicitSingle=/(?:単品|单个|單個|单盒|單盒|バラ売り|ばら売り)(?!不可|禁止|しません|なし|無し)/.test(useful);
 const single=explicitSingle||counts.size===1&&counts.has(1)&&!fullBox;
 return {fullBox,single,quantity:counts.size===1&&!(fullBox&&counts.has(1))?[...counts][0]:null,ambiguous:counts.size>1||fullBox&&explicitSingle||explicitSingle&&/(?:セット|まとめ売り)/.test(useful)};
}
function facets(title,description=''){
 // Shared facet parser handles e.g. 1/7 vs 1/8 and Pokemon 第4弾/4代目.
 // Deliberately do not call the broader strict guard: missing terms, unrelated
 // tokens, multiple facets and brand names are not definitive card conflicts.
 const scaleFields=description.split(/\r?\n/).filter(line=>/^(?:【\s*(?:スケール|縮尺|scale|比例)\s*】|(?:スケール|縮尺|scale|比例)\s*[:：])/i.test(line.trim()));
 const found=identityVariantFacets([title,...scaleFields].join('\n'));
 delete found.tarotNames;delete found.tarot; // translated names/numerals need detail
 return found;
}

export function classifyYahooCardConflict(input={}){
 const {ownDetail,card}=input??{};
 if(typeof ownDetail?.title!=='string'||typeof ownDetail?.description!=='string'||typeof card?.title!=='string'||
  !ownDetail.title.trim()||!ownDetail.description.trim()||!card.title.trim())return unresolved('card_conflict_missing_text');
 if(ownDetail.title.length>1000||card.title.length>1000||ownDetail.description.length>30000)return unresolved('card_conflict_text_bounds');
 const ownTitle=normalize(ownDetail.title),candidateTitle=normalize(card.title),description=normalize(ownDetail.description);
 if(card.titleTruncated===true||card.truncated===true||ownDetail.titleTruncated===true||uncertain.test(ownTitle)||uncertain.test(candidateTitle))return unresolved('card_conflict_ambiguous_text');
 const ownText=`${ownTitle}\n${description}`,candidateText=candidateTitle;
 const ownBonus=bonus(ownText),otherBonus=bonus(candidateText);
 if(negativeOrReference.test(ownBonus.rest)||negativeOrReference.test(otherBonus.rest)||
  ownBonus.included&&ownBonus.absent||otherBonus.included&&otherBonus.absent)return unresolved('card_conflict_ambiguous_text');
 const ownHeading=mainHeading(bonus(ownTitle).rest),candidateHeading=mainHeading(bonus(candidateTitle).rest);
 const ownTypes=types(ownHeading),otherTypes=types(candidateHeading);
 const ownCondition=condition(ownText),otherCondition=condition(candidateText);
 const ownUnit=unit(mainHeading(saleLines(ownTitle,description))),otherUnit=unit(candidateHeading);
 const ownFacets=facets(ownHeading,description),otherFacets=facets(candidateHeading);
 if(ownTypes.size>1||otherTypes.size>1||ownCondition.ambiguous||otherCondition.ambiguous||ownUnit.ambiguous||otherUnit.ambiguous||
  Object.values(ownFacets).some(values=>values.size>1)||Object.values(otherFacets).some(values=>values.size>1))return unresolved('card_conflict_ambiguous_terms');
 // A bare defect title does not establish a difference from an unknown or also
 // defective own item. No "missing condition" -> "used" default is permitted.
 if(otherCondition.defect&&!ownCondition.defect&&(ownCondition.sealed||ownCondition.unused))return conflict('explicit_card_defect');
 if(otherCondition.boxOnly&&!ownCondition.boxOnly&&(ownCondition.sealed||ownCondition.mainIncluded))return conflict('explicit_card_packaging_mismatch');
 if(otherCondition.noBox&&ownCondition.boxed)return conflict('explicit_card_packaging_mismatch');
 if(ownCondition.sealed&&otherCondition.opened||ownCondition.unused&&otherCondition.used)return conflict('explicit_card_condition_mismatch');
 if(ownUnit.fullBox&&otherUnit.single||otherUnit.fullBox&&ownUnit.single)return conflict('explicit_card_sale_unit_mismatch');
 if(ownUnit.quantity!==null&&otherUnit.quantity!==null&&ownUnit.quantity!==otherUnit.quantity)return conflict('explicit_card_quantity_mismatch');
 for(const key of Object.keys(ownFacets)){
  const left=ownFacets[key],right=otherFacets[key];
  if(left.size===1&&right.size===1&&![...left].some(value=>right.has(value)))return conflict('explicit_card_variant_mismatch');
 }
 if(ownBonus.included&&otherBonus.absent)return conflict('explicit_card_required_bonus_absent');
 if(ownTypes.size===1&&otherTypes.size===1&&![...ownTypes].some(value=>otherTypes.has(value)))return conflict('explicit_card_product_type_mismatch');
 return unresolved('no_definitive_card_conflict');
}

// Current target-local freight evidence, independent of carrier metadata.
// This helper never infers a fee from product title, method, or a marketplace.
const proofSources={yahoo:'target_price_area',rakuma:'listing_shipping_fee_row'};
const plain=value=>String(value||'').replace(/<[^>]+>/g,' ').replace(/&#x([0-9a-f]+);/gi,(_,n)=>String.fromCodePoint(parseInt(n,16)))
  .replace(/&#(\d+);/g,(_,n)=>String.fromCodePoint(Number(n))).replace(/&amp;/g,'&').replace(/&quot;/g,'"')
  .replace(/&nbsp;/g,' ').replace(/&#39;|&apos;/g,"'").normalize('NFKC').replace(/\s+/g,' ').trim();

// The fee parser proves the amount separately. Inspect only the current
// target's heading-to-next-section region for contradictory delivery terms.
export function targetPriceAreaTerms(html,title){
  const source=String(html||'').replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>/gi,'');
  const heading=[...source.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/gi)].find(match=>plain(match[1])===plain(title));
  if(!heading)return '';
  return plain(source.slice(heading.index+heading[0].length).split(/<h[12]\b|<footer\b|<\/main>|<\/article>/i)[0].slice(0,12000));
}

// A geographic edition is product identity, not a delivery condition. Bind
// regional limits directly to fee/delivery language; do not reject bare titles
// such as 「東京限定マグカップ 送料無料」.
const jpRegion='(?:北海道|青森|岩手|宮城|秋田|山形|福島|茨城|栃木|群馬|埼玉|千葉|東京|神奈川|新潟|富山|石川|福井|山梨|長野|岐阜|静岡|愛知|三重|滋賀|京都|大阪|兵庫|奈良|和歌山|鳥取|島根|岡山|広島|山口|徳島|香川|愛媛|高知|福岡|佐賀|長崎|熊本|大分|宮崎|鹿児島|沖縄|関東|関西|東北|北陸|東海|中部|近畿|中国地方|四国|九州|甲信越|甲信|本州|離島|都内|府内|県内|市内|道内|一部地域|指定地域|対象地域|特定地域)(?:都|府|県|地方|地域|エリア)?(?:23区|全域|一帯)?(?:内)?';
const jpRegions=`${jpRegion}(?:[・、,/及びと]+${jpRegion})*`;
const fee='(?:送料無料|送料(?:は|が)?無料|送料込(?:み)?|配送料無料)';
const delivery='(?:配送(?:先|地域|エリア)?|発送(?:先|地域|エリア)?|お届け(?:先|地域|エリア)?|配達(?:先|地域|エリア)?|送付先)';
const only='(?:限定|のみ|だけ|に限り|に限って|に限ります|以外(?:は)?(?:対象外|不可))';
const regionalFeePatterns=[
  new RegExp(`${fee}(?:の)?(?:対象|適用|対象地域|適用地域|対象エリア)(?:は|が|:)?${jpRegions}`),
  new RegExp(`${jpRegions}(?:にお住まいの|在住の|にお住まい|在住|の|へお届けの)(?:方|人|お客様)(?:は|のみ|限定)?${fee}`),
  new RegExp(`${fee}(?:です|は|対象は)?[(:【「]*${jpRegions}(?:への|の方|にお住まいの方)?${only}`),
  new RegExp(`${jpRegions}(?:限定|のみ|だけ|に限り|に限って)(?:で|は|が|に|なら|の方は)?[):】」]*${fee}`),
  new RegExp(`${jpRegions}(?:は|なら|の場合は)${fee}`),
  new RegExp(`${delivery}(?:は|が|先は|先が|を)?[(:【「]*${jpRegions}(?:への|の方|にお住まいの方)?${only}`),
  new RegExp(`${jpRegions}(?:限定|のみ|だけ|に限り|に限って)(?:で|は|が|に|の)?[):】」]*${delivery}`),
];
const conditionalFeePatterns=[
  new RegExp(`(?:[0-9]+(?:万|千)?円|[0-9]+(?:個|点|本))(?:以上|超)(?:のご?購入|購入|注文|お買い上げ)?(?:で|は|の場合|なら)?${fee}`),
  new RegExp(`${fee}(?:は|が|の対象は)?(?:会員|メンバー|登録者|クーポン利用者|指定配送)(?:登録|の方)?(?:限定|のみ|対象)`),
  new RegExp(`(?:会員|メンバー|登録者|クーポン利用者)(?:限定|のみ)(?:で|は|なら)?${fee}`),
  new RegExp(`(?:条件付(?:き)?|条件を満たす場合)(?:の|は|に)?${fee}`),
  new RegExp(`${fee}(?:の(?:商品|出品|対象))?(?:ではありません|ではない|じゃありません|じゃない)`),
];
function explicitShippingConditions(value){
  const text=String(value||'').normalize('NFKC');
  if([...regionalFeePatterns,...conditionalFeePatterns].some(pattern=>pattern.test(text.replace(/\s+/g,'').replace(/[()\[\]{}【】「」『』〈〉《》]/g,''))))return true;
  const english=text.replace(/\s+/g,' ');
  return /\b(?:free\s+)?(?:shipping|delivery)\b[^.!?。\n]{0,70}\bonly\s+(?:within|to|in|for)\b/i.test(english)||
    /\bonly\s+(?:within|to|in)\b[^.!?。\n]{0,70}\b(?:free\s+)?(?:shipping|delivery)\b/i.test(english)||
    /\b(?:free\s+)?(?:shipping|delivery)\s+(?:within|to|in)\b[^.!?。\n]{0,50}\bonly\b/i.test(english)||
    /\bfree\s+(?:shipping|delivery)\s+(?:only\s+)?(?:for|on)\s+(?:orders?|purchases?)\b[^.!?。\n]{0,30}\b(?:over|above|at least|more than|of)\b/i.test(english)||
    /\b(?:free\s+(?:shipping|delivery)\s+(?:for|to)\s+(?:members?|subscribers?)|(?:members?|subscribers?)[ -]only\s+free\s+(?:shipping|delivery))\b/i.test(english);
}

export function shippingTermsUnproven(...values){
  let text=values.filter(value=>typeof value==='string').join('\n').normalize('NFKC');
  // Explicit negations/retractions do not turn optional pickup or a historical
  // statement into current pickup-only/extra-fee evidence.
  text=text.replace(/\b(?:not|no longer)\s+(?:pickup|pick-up|collection)[ -]only\b/gi,'')
    .replace(/\bno\s+(?:additional|extra)\s+(?:shipping|delivery)\s+(?:fees?|charges?)\b/gi,'')
    .replace(/(?:追加|別途)(?:の)?(?:送料|配送料)(?:は|が)?\s*(?:ありません|不要|なし|無し|0円)/g,'')
    .replace(/(?:送料|配送料)(?:は|が|を)?(?:別料金|別途|別)(?:ではありません|ではない|じゃない|不要|なし|無し)/g,'')
    .replace(/(?:購入者|買主)(?:様)?(?:の)?負担(?:ではありません|ではない|じゃない)/g,'')
    .replace(/(?:着払い|送料別|引(?:き)?取(?:り)?限定|手渡しのみ)(?:ではありません|ではない|じゃありません|じゃない|不可)/g,'')
    .replace(/(?:以前|以前は|昔は)[^。\n]{0,60}?(?:引(?:き)?取(?:り)?限定|手渡しのみ)[^。\n]{0,20}?(?:でしたが|だったが)[、,\s]*(?=(?:現在|今)は[^。\n]{0,25}(?:発送|配送)(?:可能|できます))/g,'')
    .replace(/\b(?:previously|formerly)\s+(?:pickup|pick-up|collection)[ -]only\s*[,;]\s*(?=now\s+(?:shipping|delivery)\s+(?:is\s+)?available)/gi,'');
  return values.some(value=>typeof value==='string'&&explicitShippingConditions(value))||
    /(?:着払い|送料\s*別|購入者負担|買主負担|(?:追加|別途|加算)[^。\n]{0,10}(?:送料|配送料)|(?:送料|配送料)[^。\n]{0,10}(?:追加|別途|加算))/.test(text)||
    /(?:送料無料|送料込|送料は無料)(?:ではありません|ではない|じゃない|対象外)/.test(text)||
    /(?:送料|配送料)(?:は|が|を)?別(?:です|料金|途|に(?:頂|いただ|貰|もら)|$|[。!！?？])|(?:購入者|買主)(?:様)?の負担/.test(text)||
    /(?:送料|配送料)(?:は|が)?(?:価格に|商品代金に|代金に)?(?:含まれて(?:いません|おりません)|含まれません|含まれない|含みません|含まない)/.test(text)||
    /(?:発送|配送|郵送)(?:は|が)?\s*(?:不可|できません|出来ません|しません|行いません|行っておりません|いたしません|致しません|対応不可)/.test(text)||
    /(?:発送|配送|郵送)(?:に|は|には|については)?対応(?:して(?:おりません|いません)|しません)/.test(text)||
    /(?:直接)?(?:取りに|受け取りに|引き取りに)(?:来られる|来れる|来ていただける|来て頂ける)(?:方|人)(?:のみ|限定)/.test(text)||
    /(?:手渡し|引(?:き)?取(?:り)?|現地受(?:け)?取(?:り)?|店頭受(?:け)?取(?:り)?)[^。\n]{0,8}(?:のみ|限定|専用)/.test(text)||
    /(?:北海道|沖縄|離島|一部地域|地域|配送先)[^。\n]{0,30}(?:除く|対象外|別途|追加|相談|異な|変わ|着払|送料\s*\d)/.test(text)||
    /(?:送料無料|送料込)[^。\n]{0,20}(?:条件|場合|のみ|(?:地域|住所|購入|同梱|数量)限定|除く)|(?:円|点|個)[^。\n]{0,10}(?:以上|購入)[^。\n]{0,15}(?:送料無料|送料込)|(?:送料|配送)[^。\n]{0,12}(?:要相談|応相談)/.test(text)||
    /(?:同梱|まとめ買い|複数購入)(?:時|の場合|で|なら|のみ|限定)[^。\n]{0,15}(?:送料無料|送料込)/.test(text)||
    /\b(?:pickup[ -]only|pick-up[ -]only|collection[ -]only|no\s+(?:shipping|delivery)|(?:shipping|delivery)\s+(?:is\s+)?(?:unavailable|not available)|(?:additional|extra)\s+(?:shipping|delivery)\s+(?:fees?|charges?))\b/i.test(text)||
    /\bfree shipping[^。\n]{0,40}(?:except|excluding|only for)|(?:Hokkaido|Okinawa|remote islands)[^。\n]{0,40}(?:extra|additional|excluded|not included)/i.test(text)||
    /仅自提|只自提|不发货|不邮寄|(?:邮费|运费)到付|不包邮|偏远[^。\n]{0,15}(?:加收|运费)|包邮[^。\n]{0,15}除外/.test(text);
}

export function marketplaceShippingEvidence({source,chargeKnown,proofSource,amount,currency,destination,title='',description='',feeText='',method}={}){
  const shippingMethod=typeof method==='string'&&method.trim()&&!/^(?:未定|不明|unknown|unspecified|not specified)$/i.test(method.trim())?method.trim():null;
  const unproven=reason=>({shippingChargeKnown:false,shippingSource:null,shippingMethod,reason});
  if(chargeKnown!==true||proofSource!==proofSources[source]||!proofSources[source]||!Number.isFinite(amount)||amount<0)
    return unproven('shipping_fee_unproven');
  if(currency!=='JPY'||destination!=='JP')return unproven('shipping_currency_or_destination_unconfirmed');
  if(shippingTermsUnproven(title,description,feeText,method))return unproven('shipping_terms_unconfirmed');
  return {shippingChargeKnown:true,shippingSource:proofSource,shippingMethod,reason:null};
}

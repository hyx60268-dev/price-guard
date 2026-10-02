// Search recall vocabulary only. This is never sufficient product/SKU evidence.
// Translate observed words without deleting model numbers, colours or sale units.
export function localizeSearchTerms(value=''){
 return String(value).normalize('NFKC')
  .replace(/トイ[・·\s]*ストーリー|Toy\s*Story/gi,'玩具总动员')
  .replace(/クレヨンしんちゃん|Crayon\s*Shin[ -]?chan/gi,'蜡笔小新')
  .replace(/小新の衣橱(?:系列)?/g,'小新衣橱')
  .replace(/蜡笔小新\s*小新衣橱/g,'蜡笔小新衣橱')
  .replace(/ロッツォ|\bLOTSO\b|熊抱哥/gi,'草莓熊')
  .replace(/(?:\bMINIME|ミニミー)\s*(\d+)\b/gi,'MINIME$1')
  .replace(/ゼンレスゾーンゼロ|ゼンゼロ/g,'绝区零')
  .replace(/アークナイツ/gi,'明日方舟')
  .replace(/鳴上嵐/g,'鸣上岚')
  .replace(/精霊三部曲|精靈三部曲/g,'精灵三部曲')
  .replace(/による絵本/g,'绘本').replace(/絵本/g,'绘本')
  .replace(/スカーフハンドル付き/g,'丝巾手柄')
  .replace(/サングラスケース/g,'墨镜盒')
  .replace(/ヒョウ柄/g,'豹纹').replace(/ドット柄/g,'波点')
  .replace(/キルティング/g,'绗缝')
  .replace(/淡いイエロー/g,'浅黄色').replace(/イエロー/g,'黄色')
  .replace(/ワイヤレスイヤホン/g,'无线耳机').replace(/LCD搭載/gi,'LCD显示屏')
  .replace(/ぬいぐるみチャーム/g,'毛绒挂件').replace(/チャーム/g,'挂件')
  .replace(/シークレット/g,'隐藏款').replace(/ミニフィギュア|ミニ手办/g,'迷你手办')
  .replace(/(\d+)\s*個入り/g,'$1个装')
  .replace(/\s+/g,' ').trim();
}

export function searchIdentityAnchorsPresent(query='',candidate=''){
 // Shared brands and packaging are insufficient for these observed product
 // families. Keep the named character and wardrobe/series in search recall.
 return [/蜡笔小新/,/衣橱/,/草莓熊/,/WARM\s*EMBRACE/i].every(anchor=>!anchor.test(query)||anchor.test(candidate));
}

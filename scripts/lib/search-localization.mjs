// Search recall vocabulary only. This is never sufficient product/SKU evidence.
// Translate observed words without deleting model numbers, colours or sale units.
export function localizeSearchTerms(value=''){
 const original=String(value).normalize('NFKC');
 // Observed Japanese listings abbreviate/misspell the printed series name.
 // Limit this recall alias to Pokemon context; never infer a release or box size.
 const pokemon=/(?:ポケ(?:ット)?モンスター|ポケモン|宝可梦|寶可夢|ピカチュウ|皮卡丘|\bPok[eé]mon\b)/i.test(original);
 const localized=pokemon?original.replace(/(?:[绘繪絵]?[梦夢](?:描)?[点點][睛晴])/g,'绘梦点睛')
  .replace(/未開封/g,'未拆封').replace(/第(\d+)弾/g,'第$1弹'):original;
 return localized
  .replace(/アルター|阿尔塔/g,'ALTER')
  .replace(/オーバーロード/gi,'OVERLORD')
  .replace(/ナーベラル[・·\s]*ガンマ|Narberal\s*(?:Gamma|Γ)/gi,'娜贝拉尔·伽玛')
  .replace(/ピカチュウ/g,'皮卡丘')
  .replace(/トイ[・·\s]*ストーリー|Toy\s*Story/gi,'玩具总动员')
  .replace(/クレヨンしんちゃん|Crayon\s*Shin[ -]?chan|蠟筆小新/gi,'蜡笔小新')
  .replace(/(52TOYS)\s*×\s*(?=玩具总动员|蜡笔小新)/gi,'$1 ')
  // 52TOYS official naming: 小新的衣橱系列 / Wardrobe Series. OOTD is a different line.
  .replace(/小新の衣[橱櫥](?:系列)?/g,'小新的衣橱系列')
  .replace(/蜡笔小新\s*(?:小新的?衣[橱櫥]|衣[橱櫥])(?:系列)?/g,'蜡笔小新 小新的衣橱系列')
  .replace(/蜡笔小新\s*[-—·]?\s*(?:Wardrobe(?:\s+Series)?|ワードローブシリーズ)/gi,'蜡笔小新 小新的衣橱系列')
  .replace(/ロッツォ|\bLOTSO\b|熊抱哥/gi,'草莓熊')
  // JD and the official store spell the same numbered line Minime系列2 / Series 2.
  .replace(/(?:\bMINI\s*ME|ミニミー)\s*(?:系列|series|シリーズ)?\s*(\d+)(?![a-z\d])/gi,'MINIME$1')
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
 const editions=query.match(/MINIME\d+[a-z\d]*/gi)||[],otherEditions=new Set((candidate.match(/MINIME\d+[a-z\d]*/gi)||[]).map(value=>value.toLowerCase()));
 return editions.every(value=>otherEditions.has(value.toLowerCase()))&&[/娜贝拉尔[·・\s]*伽玛/,/蜡笔小新/,/衣橱/,/草莓熊/,/WARM\s*EMBRACE/i].every(anchor=>!anchor.test(query)||anchor.test(candidate));
}

import { canonicalSaleTitle } from './discovery.mjs';

// Visual notes are limited to the exact products reviewed in the user's
// screenshots. They describe visible design, never authenticity or condition.
export function verifiedVisualNotes(item={}){
 const t=item.title||'';
 if(/Anker/i.test(t)&&/AeroClip\s*2/i.test(t)&&/張凌赫/.test(t)&&/ギフトボックス/.test(t))return {
  ja:['張凌赫とのコラボレーションによる「声声有赫」限定ギフトボックスです。','赤いボックスの内側に人物ビジュアルを配し、イヤホンと付属アイテムをまとめたギフト仕様のデザインです。'],
  zh:['张凌赫联名「声声有赫」限定礼盒。','图中礼盒为红色，内侧展示人物图案，搭配耳机及配套物件。礼盒颜色与耳机颜色分开标注。']};
 if(/ゼンゼロ/.test(t)&&/仲夏幻夢/.test(t)&&/葉瞬光/.test(t)&&/\bSS\b/.test(t))return {
  ja:['「ゼンゼロ」閃魂コラボ「仲夏幻夢」シリーズの葉瞬光 SSコレクションカードです。','人物イラストを中心に配した縦型のカードで、キャラクターの衣装や背景の描き込みを楽しめるデザインです。'],
  zh:['《绝区零》闪魂联名「仲夏幻梦」系列叶瞬光 SS 收藏卡。','卡面以角色插画为中心，采用竖版构图，展示角色服饰和背景细节。']};
 if(/NARUTO/.test(t)&&/20周年/.test(t)&&/金属カード/.test(t))return {
  ja:['「NARUTO」20周年を記念した金属カードのギフトボックスです。','写真の外箱はブラックを基調とし、ゴールド系のキャラクターイラストと記念デザインが施されています。'],
  zh:['《火影忍者》20 周年纪念金属卡礼盒。','图中外盒以黑色为主，搭配金色系角色线条插画与纪念图案。']};
 if(/POPMART/i.test(t)&&/NARUTO/.test(t)&&/暁/.test(t)&&/1BOX/.test(t))return {
  ja:['「NARUTO」の暁をテーマにしたPOPMARTのフィギュアシリーズです。','写真では赤と黒を基調としたディスプレイボックスに、個別の小箱を並べたパッケージが確認できます。'],
  zh:['POPMART《火影忍者》晓组织主题手办系列。','图片展示红黑配色端盒，内含分别包装的小盒。']};
 if(/鬼滅の刃/.test(t)&&/無限城/.test(t)&&/ポストカード/.test(t)&&/ABセット/.test(t))return {
  ja:['「鬼滅の刃」無限城編をテーマにした新繹シリーズのポストカード、A・Bセットです。','写真には黒と金色を基調にした2つのパッケージが写っています。'],
  zh:['《鬼灭之刃》无限城篇新绎系列明信片 A、B 套装。','照片展示两份黑金配色包装。']};
 return {ja:[],zh:[]};
}
export function merchantCopy(item={}){
 const name=canonicalSaleTitle(item.title||''),raw=String(item.title||'')+'\n'+String(item.description||'');
 const region=/中国限定/.test(raw)?'中国限定':/海外限定/.test(raw)?'海外限定':'';
 const notes=verifiedVisualNotes(item),units=raw.normalize('NFKC').match(/1\s*BOX\s*[（(]?\s*(\d+)\s*(?:ピース|個|pcs)/i);
 const count=String(item.title||'').match(/\d+\s*(?:枚|点|個|体|本)(?:入り|入)?/g)||[];
 const unit=units?`1BOX（${units[1]}個入り）`:count.join(' / ');
 const color=String(item.title||'').match(/ホワイト|レッド|ブラック|ブルー|ピンク|グリーン|パープル|イエロー/g)?.join(' / ')||'';
 // Keep the actual version, colour and sale unit in the title instead of
 // truncating them away at an arbitrary character boundary.
 const title=[region,name].filter(Boolean).join(' ');
 const specifications=String(item.description||'').split(/\n|。/).map(s=>s.trim()).filter(s=>s.length<160&&/(?:サイズ|素材|材質|全高|高さ|幅|重量|\d+(?:\.\d+)?\s*(?:mm|cm|g)\b)/i.test(s)&&!/(?:発送|配送|送料|保証|正規品|本物|新品|未開封|完売)/.test(s)).slice(0,5);
 const details=[`商品：${name}`,region?`販売地域：${region}`:'',color?`カラー：${color}`:'',unit?`販売単位：${unit}`:'',...specifications].filter(Boolean);
 const intro=notes.ja.length?notes.ja:[`${name}です。`];
 const contents=item.contents||unit||( /ギフトボックス/.test(name)?'ギフトボックス。付属品の種類と点数は仕入れ商品の内容をご確認ください。':'付属品と数量は仕入れ商品の内容をご確認ください。');
 const ja=[...intro,'','【商品詳細】',...details,'','【商品内容】',contents,
  units?'※1BOXでの販売です。複数BOXのセットではありません。シークレットの封入や全種類のコンプリートは保証していません。':'',
  '','【状態】','仕入れ商品の開封状態・外箱・付属品を確認してから記入してください。',
  '','【ご注意】','画像はデザインの参考です。実際に発送する商品の内容・状態をご確認ください。海外製品には塗装や印刷の個体差、外箱のスレが見られる場合があります。'].filter((v,i,a)=>v!==''||a[i-1]!=='').join('\n');
 const zh=['中文翻译：',...(notes.zh.length?notes.zh:[name+'。']),'','【商品详情】',`品名：${name}`,region?`限定信息：${region}`:'',color?`颜色：${color}`:'',unit?`销售单位：${unit}`:'',...specifications,'','【商品内容】',item.contents||unit||'请按实际采购商品确认附件种类和数量。',units?'销售单位为一整盒，并非多盒套装；不承诺隐藏款或集齐全套。':'','','【状态】','请按实际采购商品填写开封、外盒和附件状态，不继承来源商家的成色声明。','','【注意事项】','图片用于参考设计。海外商品可能存在涂装、印刷个体差异或外盒擦痕。'].filter((v,i,a)=>v!==''||a[i-1]!=='').join('\n');
 return {proposedTitle:title,proposedDescription:ja,translatedDescription:zh,copyStatus:'draft',copyNote:'标题、详情可分别复制。商品设计取自来源详情及已核对图片；发货内容与成色请按采购实物填写。',copyVersion:2};
}

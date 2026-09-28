import test from 'node:test';
import assert from 'node:assert/strict';
import { merchantNameFromTitle } from '../scripts/lib/merchant-names.mjs';
test('observed Yahoo and Mercari profile headings supply real names without collecting badges or ratings',()=>{
 assert.equal(merchantNameFromTitle('yahoo','みお(出張中、10/6日順次発)の出品リスト｜Yahoo!フリマ（旧PayPayフリマ）'),'みお(出張中、10/6日順次発)');
 assert.equal(merchantNameFromTitle('mercari','みこ の出品した商品 - メルカリ'),'みこ');
 assert.equal(merchantNameFromTitle('yahoo','A&amp;Bの出品リスト｜Yahoo!フリマ'),'A&B');
 assert.equal(merchantNameFromTitle('yahoo','ログイン - Yahoo! JAPAN'),'');
 assert.equal(merchantNameFromTitle('mercari','商品 - メルカリ'),'');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize,titleScore } from '../scripts/lib/rules.mjs';
import { localizeSearchTerms,searchIdentityAnchorsPresent } from '../scripts/lib/search-localization.mjs';
import { externalSearchQueries } from '../scripts/lib/external-images.mjs';

test('Narberal Gamma names are equivalent across the actual Japanese and Chinese catalogue',()=>{
 assert.equal(normalize('アルター オーバーロード ナーベラル・ガンマ so-bin'),normalize('ALTER OVERLORD 娜贝拉尔·伽玛 so bin'));
 const own='ALTER オーバーロード ナーベラル・ガンマ so-bin Ver. フィギュア';
 const catalogue='ALTER OVERLORD 娜贝拉尔·伽玛 so-bin Ver.【再版】 AL20744 1/8';
 assert.ok(titleScore(own,catalogue)>.62);
 assert.ok(titleScore(own,catalogue.replace('娜贝拉尔·伽玛','アルベド'))<.62);
 assert.notEqual(normalize('ナーベラル・ガンマ so-bin'),normalize('アルベド so-bin'));
});

test('search keeps the named character, scale and sale unit through translation',()=>{
 const title='ALTER ナーベラル・ガンマ so-bin 1/8 2体セット';
 const localized=localizeSearchTerms(title);
 assert.match(localized,/娜贝拉尔·伽玛/);assert.match(localized,/1\/8/);assert.match(localized,/2体セット/);
 assert.ok(externalSearchQueries(title).some(q=>q.includes('娜贝拉尔')));
 assert.equal(searchIdentityAnchorsPresent(localized,'ALTER アルベド so-bin 1/8'),false);
 assert.equal(searchIdentityAnchorsPresent(localized,'ALTER 娜贝拉尔·伽玛 so-bin 1/8'),true);
});

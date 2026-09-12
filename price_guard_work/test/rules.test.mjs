import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateCost,advice,titleScore } from '../scripts/lib/rules.mjs';
import { encrypt,decrypt } from '../scripts/lib/crypto.mjs';
const settings={exchangeRate:22.99,costMultiplier:1.05,fees:{小:{manualCNY:30,shippingJPY:210},中:{manualCNY:50,shippingJPY:850},大:{manualCNY:100,shippingJPY:1200}}};
test('small item formula',()=>assert.equal(calculateCost(90.5,'小',settings),3130));
test('profit warning',()=>assert.equal(advice({ownPrice:4099,recommendedPrice:4099,cost:3130,warning:1500}),'不建议按推荐价出售'));
test('title similarity',()=>assert.ok(titleScore('鬼灭之刃 时透无一郎 亚克力立牌','鬼灭之刃 新绎 时透无一郎 亚克力立牌')>.7));
test('encryption roundtrip',()=>{const b=Buffer.from('价格守卫');assert.equal(decrypt(encrypt(b,'12345678'),'12345678').toString(),b.toString())});

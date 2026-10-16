const assert = require('assert'); const { spokenToDigits, spokenToJO } = require('../voice.js');
const cases = { '26-001': '26-001', 'twenty six zero zero one': '26-001', 'twenty six oh oh one': '26-001', '26 1': '26-001', 'JO 26 12': '26-012',
  'twenty six double oh one': '26-001', '261': '26-001', 'twenty six one': '26-001', 'twenty six oh one': '26-001', '26 005': '26-005', '26-1234': '26-1234', 'hello': '' };
let f = 0; for (const [k, v] of Object.entries(cases)) { const got = spokenToJO(k); const ok = got === v; if (!ok) f++; console.log(ok ? 'ok  ' : 'FAIL', JSON.stringify(k), '->', got, '(digits ' + spokenToDigits(k) + ')'); }
assert.strictEqual(f, 0, f + ' failures'); console.log('all', Object.keys(cases).length, 'passed');

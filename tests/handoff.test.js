// Old github.io address forwards to oypjewelry.com/scan. Settings ride in the fragment, never the query string.
const assert = require('assert');
const H = require('../handoff.js');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('ok ', m); };

function mem(init) {
  const m = Object.assign({}, init || {});
  return { getItem: k => (k in m ? m[k] : null), setItem: (k, v) => { m[k] = String(v); }, removeItem: k => { delete m[k]; }, _m: m };
}
const old = (search, extra) => Object.assign({ hostname: 'oypjewelry-stack.github.io', pathname: '/jo-scanner/', search: search || '', hash: '' }, extra);
const phone = mem({
  oypScanApi: 'https://script.google.com/macros/s/ABC/exec',
  oypScanToken: 's3cret/+=',
  oypScanRotate: 'ccw',
  oypScanAuto: '1',
  oypScanCrop: '0',
  oypScanRole: 'admin',
  oypScanPrintJo: '0',
  oypScanPrintTag: '1',
  enhance: '0',
  oypScanZones: '[{"id":"jo","label":"JO number","x":0.1,"y":0.1,"w":0.2,"h":0.1}]',
  oypScanZonesShared: '1',
  oypPrint: '{"darkness":4}',
  oypDevice: 'd-abc'
});

ok(H.shouldLeave(old()) && !H.shouldLeave({ hostname: 'oypjewelry.com', pathname: '/scan/' }) && !H.shouldLeave({ hostname: 'localhost', pathname: '/jo-scanner/' }), 'only the old github.io scanner address leaves');
ok(H.decide(true, 0) === 'go' && H.decide(true, 2) === 'wait' && H.decide(false, 0) === 'stay', 'leave when /scan is up and this phone has nothing left to upload');

const url = new URL(H.destination(old('?role=admin&token=from-query&api=https%3A%2F%2Fexample.com%2Fexec'), phone));
ok(url.origin + url.pathname === 'https://oypjewelry.com/scan/', 'the new address is oypjewelry.com/scan/');
ok(url.searchParams.get('role') === 'admin' && url.searchParams.get('api') === 'https://example.com/exec', 'role and the web app URL stay in the query');
ok(url.searchParams.get('token') == null && !/[?&]token=/.test(url.search) && !url.search.includes('s3cret') && !url.search.includes('from-query'), 'the token is not in the query string');
ok(url.hash.indexOf('#h=') === 0, 'settings are in the fragment');
const back = H.decodePayload(url.hash.slice(3));
ok(back.oypScanToken === 's3cret/+=' && back.oypScanApi === 'https://script.google.com/macros/s/ABC/exec' && back.oypScanPrintJo === '0' && back.oypScanCrop === '0' && back.enhance === '0' && back.oypScanZones.indexOf('"jo"') > 0 && back.oypPrint === '{"darkness":4}' && back.oypDevice === 'd-abc', 'fragment round-trips the token, switches, zones, and printer settings');

const fresh = mem();
const path = H.arrivalPath({ pathname: '/scan/', search: '?role=admin', hash: url.hash }, fresh);
ok(path === '/scan/?role=admin' && fresh.getItem('oypScanToken') === 's3cret/+=', 'arrival writes settings and drops the fragment');
const again = mem({ oypScanToken: 'kept', oypScanPrintJo: '1' });
H.arrivalPath({ pathname: '/scan/', search: '', hash: url.hash }, again);
ok(again.getItem('oypScanToken') === 'kept' && again.getItem('oypScanPrintJo') === '1' && again.getItem('oypScanCrop') === '0', 'a second hand-off fills only what this phone does not already have');

phone.setItem(H.SENT, '1');
const later = new URL(H.destination(old('?role=staff'), phone));
ok(!later.hash && later.searchParams.get('role') === 'staff' && later.searchParams.get('token') == null, 'after the one-time hand-off the old address redirects without the settings');
const withToken = new URL(H.destination(old('?token=again'), phone));
ok(withToken.searchParams.get('token') == null && H.decodePayload(withToken.hash.slice(3)).oypScanToken === 'again', 'a token still in the old query moves into the fragment');

ok(H.KEYS.indexOf('oypScanToken') >= 0 && H.KEYS.indexOf('oypSession') < 0, 'the staff sign-in is not part of the hand-off');

console.log('handoff tests passed:', n);

// Capture flow + JO sticker / Jewelry tag switches. The phone stays on the capture screen, page 1 can
// upload while later pages are still being shot, and page 1 sends printJo and printTag.
const assert = require('assert'); const fs = require('fs');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('ok ', m); };
const src = fs.readFileSync(__dirname + '/../app.js', 'utf8');
const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
const css = fs.readFileSync(__dirname + '/../style.css', 'utf8');
const paste = fs.readFileSync(__dirname + '/../paste/Code.gs.print-flag.txt', 'utf8');
const grab = name => src.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'))[0];
const scanPayload = new Function(grab('scanPayload') + '; return scanPayload;')();

const page = (p, extra) => Object.assign({ jo: '26-001', page: p, filename: '26-001-p' + p + '.jpg', scan: '26-001@s', image: 'data:image/jpeg;base64,AAAA' }, extra);
const both = scanPayload(page(1), 'tok', { printJo: true, printTag: true });
ok(both.printJo === true && both.printTag === true && both.print === undefined && both.imageBase64 === 'AAAA' && both.scan === '26-001@s' && both.page === 1, 'page 1 sends printJo and printTag, not print');
const joOff = scanPayload(page(1), 'tok', { printJo: false, printTag: true });
ok(joOff.printJo === false && joOff.printTag === true && joOff.jo === '26-001', 'JO sticker off sends printJo false and still sends printTag');
const tagOff = scanPayload(page(1), 'tok', { printJo: true, printTag: false });
ok(tagOff.printJo === true && tagOff.printTag === false, 'jewelry tag off sends printTag false');
ok(scanPayload(page(1), 'tok', {}).printJo === true && scanPayload(page(1), 'tok', {}).printTag === true, 'a missing choice stays on');
const later = scanPayload(page(2), 'tok', { printJo: false, printTag: false });
ok(later.printJo === undefined && later.printTag === undefined && later.print === undefined, 'later pages never send the sticker flags');
ok(scanPayload(page(1), '', { printJo: false, printTag: false }).token === '', 'empty token still sent');

ok(/return localStorage\.getItem\(key\) !== '0'/.test(src), 'each switch defaults on unless this phone saved off');
ok(/printJo: 'oypScanPrintJo'/.test(src) && /printTag: 'oypScanPrintTag'/.test(src), 'each choice is stored on the phone');
ok(/body\.printJo === false \|\| body\.printTag === false/.test(src) && /__oypNativeFetch/.test(src) && /OYPZones\.prepare/.test(src), 'either switch off uses the unwrapped fetch and still prepares the JO crop');
ok(/cap\.pages\.push\(p\)/.test(src) && /showView\('capView'\)/.test(src), 'after a photo the capture screen stays up and keeps every page');
ok(/photo\.cont = true/.test(src) && /id="btnNextPage"/.test(html) && /for="filePhoto"/.test(html), 'Next page is one tap that reopens the same camera');
ok(/id="btnCapDone"/.test(html) && /function finishCapture\(\)/.test(src) && !/confirm\(/.test(grab('finishCapture')), 'Done leaves the screen with no confirm dialog');
ok(/queue\.retry\(s\.retry\)/.test(src) && /id="btnCapRetry"/.test(html), 'a failed page can be retried from the capture screen');
ok(/data-sticker="jo"/.test(html) && /data-sticker="tag"/.test(html) && /class="settog/.test(html) && /No JO sticker/.test(html) && /No jewelry tag/.test(html) && /JO sticker/.test(html) && /Jewelry tag/.test(html), 'JO sticker and Jewelry tag settogs, with a note for each when off');
ok((html.match(/data-sticker="jo"/g) || []).length >= 2 && (html.match(/data-sticker="tag"/g) || []).length >= 2, 'both switches are on the start screen and the capture screen');
ok(/\.settog\{display:inline-flex/.test(css) && /text-transform:uppercase/.test(css) && /\.settog input\{width:20px;height:20px/.test(css) && /font-size:12px/.test(css), 'settog matches the back-office switch size');
ok(/class="pill sm"/.test(html) && /id="btnNextPage"/.test(html) && /class="pill sm outline"/.test(html) && /class="capacts"/.test(html), 'Next page and Done are staff pills in one row');
ok(/#btnNextPage,#btnCapDone\{[^}]*height:34px/.test(css) && /font-size:14px/.test(css) && /font-weight:500/.test(css) && /Libre Bodoni/.test(css), 'those pills are 34px, 14px Libre Bodoni 500');
ok(/printerItemHtml/.test(src) && /data-oyp-printer/.test(src), 'the menu uses the shared nav.js Printer row');
ok(!/id="oypPrBtn"|id="printChip"/.test(html) && /header\.top #printChip,header\.top \.oyp-pr-slot\{display:none!important\}/.test(css), 'the scanner header has no printer button of its own');
ok(/req\.printJo !== false/.test(paste) && /req\.printTag !== false/.test(paste) && /jo_card/.test(paste) && /jewelry_tag/.test(paste), 'paste queues jo_card and jewelry_tag unless that flag is false');
ok(/filename: pageName\(state\.jo, state\.page\)/.test(src), 'new pages still use pageName');
ok(/MAX_PX = 1600/.test(src) && /QUALITY = 0\.8/.test(src) && /PHOTO = \{ maxPx: MAX_PX, quality: QUALITY \}/.test(src), 'camera photos upload at 1600px JPEG 0.8');
ok(/jpeg-worker\.js/.test(src) && /OffscreenCanvas/.test(src) && /op: 'encode'/.test(src), 'resize and JPEG run in a worker when the phone has one');
ok(/v=20261021c/.test(html), 'cache-bust bumped');

console.log('capture tests passed:', n);

// Capture flow + JO sticker / Jewelry tag switches. The phone stays on the capture screen, page 1 can
// upload while later pages are still being shot, and page 1 sends printJo and printTag.
const assert = require('assert'); const fs = require('fs');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; console.log('ok ', m); };
const src = fs.readFileSync(__dirname + '/../app.js', 'utf8');
const html = fs.readFileSync(__dirname + '/../index.html', 'utf8');
const css = fs.readFileSync(__dirname + '/../style.css', 'utf8');
const paste = fs.readFileSync(__dirname + '/../paste/Code.gs.print-flag.txt', 'utf8');
const grab = name => src.match(new RegExp('(?:async )?function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'))[0];
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
ok(/#btnNextPage,#btnCapDone,#btnCapJoSave\{[^}]*height:34px/.test(css) && /font-size:14px/.test(css) && /font-weight:500/.test(css) && /Libre Bodoni/.test(css), 'those pills are 34px, 14px Libre Bodoni 500');
ok(/printerItemHtml/.test(src) && /data-oyp-printer/.test(src), 'the menu uses the shared nav.js Printer row');
ok(/OFFICE_NAV/.test(src) && /N\.ordered\(user\)/.test(src) && /consignment/.test(src) && /production/.test(src), 'the menu uses the full staff list, including saved order');
ok(/<hr><a href="#" data-m="queue">/.test(src) && /data-m="settings">Scanner settings/.test(src), 'Pending uploads and Scanner settings stay below the divider');
ok(!/id="oypPrBtn"|id="printChip"/.test(html) && /header\.top #printChip,header\.top \.oyp-pr-slot\{display:none!important\}/.test(css), 'the scanner header has no printer button of its own');
ok(/req\.printJo !== false/.test(paste) && /req\.printTag !== false/.test(paste) && /jo_card/.test(paste) && /jewelry_tag/.test(paste), 'paste queues jo_card and jewelry_tag unless that flag is false');
ok(/filename: pageName\(state\.jo, state\.page, shot\)/.test(src), 'new pages still use pageName');
ok(/MAX_PX = 1600/.test(src) && /QUALITY = 0\.8/.test(src) && /PHOTO = \{ maxPx: MAX_PX, quality: QUALITY \}/.test(src), 'camera photos upload at 1600px JPEG 0.8');
ok(/jpeg-worker\.js/.test(src) && /OffscreenCanvas/.test(src) && /op: 'encode'/.test(src), 'resize and JPEG run in a worker when the phone has one');
ok(/Tap to scan the JO and choose which sticker to print\. If the JO has no number or it's hard to read, type it in the box\./.test(html), 'the start screen tells her to scan, choose a sticker, or type a hard number');
const scanAt = html.indexOf('id="btnScanJO"'), stickAt = html.indexOf('class="stickrow"'), joAt = html.indexOf('id="joInput"'), helpAt = html.indexOf('class="muted help"');
ok(scanAt > 0 && scanAt < stickAt && stickAt < joAt && joAt < helpAt, 'start screen order is Scan JO, switches, JO box, help');
ok(!/Type the JO number first/.test(src), 'Scan JO is not blocked when the JO box is empty');
ok(/state\.jo === 'OCR'/.test(src) && /op: 'readJo'/.test(src) && /ocrBase64/.test(src) && /p\.held/.test(src), 'an empty box keeps the photo and reads the JO-number zone');
ok(/id="capJoForm"/.test(html) && /id="capJoInput"/.test(html) && /id="btnCapJoSave"/.test(html) && /function askForJo\(\)/.test(src) && /function fileHeld\(jo\)/.test(src), 'an unclear read asks for the number on the capture screen');
ok(/const typed = realJO\(\$\('joInput'\)\.value\)/.test(src), 'a typed JO is used instead of the read');
const realJO = new Function(grab('normJO') + '\n' + grab('realJO') + '; return realJO;')();
const joBits = grab('normJO') + '\n' + grab('realJO') + '\n' + grab('uniqueJOs') + '\n';
const joFromRead = new Function(joBits + grab('joFromRead') + '; return joFromRead;')();
const joFromPage = new Function(joBits + grab('joFromPage') + '; return joFromPage;')();
ok(realJO('JO 26-014') === '26-014' && realJO('OCR') === '' && realJO('') === '', 'OCR is a hold, not a JO number');
ok(joFromRead({ ok: true, jo: '26-014', low: false }) === '26-014', 'a confident read is filed');
ok(joFromRead({ ok: true, jo: '26-014', low: true }) === '' && joFromRead({ ok: false, jo: '26-014' }) === '' && joFromRead({ ok: true, jo: '', low: false }) === '', 'a low or empty read is not filed');
const zoneLow = { ok: true, jo: '11-520', low: true, found: ['11-520'], text: 'DATE / JO# / 8 2012 / 11-520' };
ok(joFromRead(zoneLow) === '11-520', 'a low zone crop that names one JO is filed');
ok(joFromRead({ ok: true, jo: 'JO 11-520', low: true, found: ['11-520', '11-520'] }) === '11-520', 'duplicate found values still count as one JO');
ok(joFromRead({ ok: true, jo: '11-520', low: true, found: ['8 2012', 'DATE', '11-520', 'JO 11-520'] }) === '11-520', 'a date or label in found is ignored when one real JO remains');
ok(joFromRead({ ok: true, jo: '11-520', low: true, found: ['11-520', '26-014'] }) === '', 'a low crop with two JOs is not filed');
ok(joFromPage(zoneLow) === '11-520', 'a whole page that names one JO is filed even when the text is long');
ok(joFromPage({ ok: true, jo: '', low: true, found: ['11-520', '11 520'] }) === '11-520', 'the page read files that one unique JO');
ok(joFromPage({ ok: true, jo: '11-520', low: false, found: ['11-520', '26-014'] }) === '', 'a whole page with two JOs is not filed');
ok(joFromPage({ ok: true, jo: '11-520', low: false }) === '' && joFromPage({ ok: false, jo: '11-520', found: ['11-520'] }) === '', 'a page read with no single JO, or a failed read, is not filed');
ok(/if \(!zone\) return ''/.test(grab('ocrJoNumber')) && /joFromRead\(await postReadJo\(b64\)\)/.test(grab('ocrJoNumber')), 'no saved zone leaves the zone read empty');
ok(/ocrJoPage\(page\.image\)/.test(grab('readHeldJo')) && /if \(!jo && !realJO\(state\.jo\)\)/.test(grab('readHeldJo')) && /askForJo\(\)/.test(grab('readHeldJo')), 'the whole page is read once after an empty zone read, and only then is she asked');
ok(/joFromPage\(await postReadJo\(b64\)\)/.test(grab('ocrJoPage')) && /pageReadB64\(dataUrl\)/.test(grab('ocrJoPage')) && /b64\.length > READ_JO_MAX_B64/.test(grab('ocrJoPage')) && /op: 'readJo'/.test(grab('postReadJo')), 'the page retry is one readJo of a base64 kept under the cap');
const fitSrc = src.match(/const READ_JO_MAX_B64 = \d+;[^\n]*\n/)[0] + grab('jpegPayload') + '\n' + grab('readJoFit');
const fit = new Function(fitSrc + '\nreturn { READ_JO_MAX_B64, jpegPayload, readJoFit };')();
ok(fit.READ_JO_MAX_B64 <= 1600000 && 2000000 - fit.READ_JO_MAX_B64 >= 400000, 'the page cap is well under 2,000,000 characters');
ok(fit.jpegPayload('data:image/jpeg;base64,AAAA') === 'AAAA' && fit.readJoFit(1600, 400000) === 1600 && fit.readJoFit(1600, fit.READ_JO_MAX_B64 + 1) < 1600, 'readJoFit shrinks only when the base64 is over the cap');
function makePageRead(load, encode) {
  return new Function('READ_JO_MAX_B64', 'jpegPayload', 'readJoFit', 'loadDataUrl', 'canvasJpegB64', grab('pageReadB64') + '\nreturn pageReadB64;')(fit.READ_JO_MAX_B64, fit.jpegPayload, fit.readJoFit, load, encode);
}
function makeHeld(ocrJoNumber, ocrJoPage) {
  const cap = { reading: false, asking: false, pages: [{ held: true, image: 'data:image/jpeg;base64,PAGE1', page: 1 }] };
  const state = { jo: 'OCR' };
  const filed = [];
  let asked = 0;
  const fn = new Function('cap', 'state', 'realJO', 'renderCapture', 'ocrJoNumber', 'ocrJoPage', 'fileHeld', 'askForJo', 'console', grab('readHeldJo') + '\nreturn readHeldJo;')(cap, state, realJO, () => {}, ocrJoNumber, ocrJoPage, jo => { filed.push(jo); }, () => { asked += 1; }, { warn() {} });
  return { fn, cap, filed, asked: () => asked };
}
ok(/#btnNextPage,#btnCapDone,#btnCapJoSave\{[^}]*height:34px/.test(css) && /font-size:14px/.test(css), 'Save is the same 34px pill as Next page and Done');
ok(/#startView \.scanjo\{margin-top:0;margin-bottom:calc\(16px \* var\(--sp, 1\)\)\}/.test(css) && /#startView \.stickrow\{margin-bottom:calc\(16px \* var\(--sp, 1\)\)\}/.test(css) && /#startView \.jorow\{margin-bottom:calc\(16px \* var\(--sp, 1\)\)\}/.test(css), 'Scan JO, switches, and the JO box use the 16px staff gap');
ok(/app\.js\?v=20261022a/.test(html) && /style\.css\?v=20261021f/.test(html), 'cache-bust bumped');

(async () => {
  let pageCalls = 0;
  let h = makeHeld(async () => joFromRead(zoneLow), async () => { pageCalls += 1; return '99-999'; });
  await h.fn();
  ok(h.filed.join() === '11-520' && pageCalls === 0 && h.asked() === 0 && h.cap.reading === false, 'one JO in a low zone crop is filed without reading the whole page');

  let pageImg = '';
  h = makeHeld(async () => '', async img => { pageCalls += 1; pageImg = img; return joFromPage(zoneLow); });
  await h.fn();
  ok(pageCalls === 1 && pageImg === 'data:image/jpeg;base64,PAGE1' && h.filed.join() === '11-520' && h.asked() === 0, 'an empty zone read retries the whole page once and files its one JO');

  h = makeHeld(async () => '', async () => joFromPage({ ok: true, jo: '11-520', low: true, found: ['11-520', '26-014'] }));
  await h.fn();
  ok(h.filed.length === 0 && h.asked() === 1, 'a whole page with two JOs asks her to type the number');

  h = makeHeld(async () => { throw new Error('zone'); }, async () => joFromPage(zoneLow));
  await h.fn();
  ok(h.filed.join() === '11-520' && h.asked() === 0, 'a failed zone read still tries the whole page once');

  h = makeHeld(async () => '', async () => '');
  await h.fn();
  ok(h.filed.length === 0 && h.asked() === 1, 'she is asked only after the zone and the page both give nothing');

  const asIs = await makePageRead(async () => { throw new Error('should not load'); }, () => { throw new Error('should not encode'); })('data:image/jpeg;base64,AAAA');
  ok(asIs === 'AAAA', 'a page already well under the cap is sent as it is');
  const big = 'B'.repeat(fit.READ_JO_MAX_B64 + 500000);
  const edges = [];
  const shrunk = await makePageRead(
    async () => ({ naturalWidth: 1600, naturalHeight: 1000, width: 1600, height: 1000 }),
    (img, long) => { edges.push(long); return 'C'.repeat(Math.max(1, Math.round(long * long * 2))); }
  )('data:image/jpeg;base64,' + big);
  ok(edges.length >= 1 && edges[0] < 1600 && shrunk.length > 0 && shrunk.length <= fit.READ_JO_MAX_B64 && shrunk.length < big.length, 'a page over the cap is downscaled until the base64 is well under 2,000,000');
  const refused = await makePageRead(
    async () => ({ naturalWidth: 1600, naturalHeight: 1000, width: 1600, height: 1000 }),
    () => 'D'.repeat(fit.READ_JO_MAX_B64 + 1)
  )('data:image/jpeg;base64,' + big);
  ok(refused === '', 'a page that stays over the cap is not sent');
  console.log('capture tests passed:', n);
})().catch(e => { console.error(e); process.exit(1); });

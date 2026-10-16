/* OYP Card Scanner: voice input for the JO number (Web Speech API). */
(function (root) {
'use strict';
const UNITS = { zero:0, oh:0, o:0, nought:0, one:1, won:1, two:2, to:2, too:2, three:3, four:4, for:4, five:5, six:6, seven:7, eight:8, ate:8, nine:9 };
const TEENS = { ten:10, eleven:11, twelve:12, thirteen:13, fourteen:14, fifteen:15, sixteen:16, seventeen:17, eighteen:18, nineteen:19 };
const TENS = { twenty:20, thirty:30, forty:40, fourty:40, fifty:50, sixty:60, seventy:70, eighty:80, ninety:90 };
const SKIP = /^(jo|j\.?o\.?|job|order|number|no|num|card|hash|dash|hyphen|and)$/;

function spokenToDigits(s) {
  const toks = String(s || '').toLowerCase().replace(/\bj\s*\.?\s*o\b\.?/g, ' ').replace(/(\d)([a-z])/g, '$1 $2').replace(/([a-z])(\d)/g, '$1 $2')
    .split(/[\s,.\-\/#:]+/).filter(Boolean);
  let out = '';
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (/^\d+$/.test(t)) { out += t; continue; }
    if (SKIP.test(t)) continue;
    if ((t === 'double' || t === 'triple') && i + 1 < toks.length && toks[i + 1] in UNITS) {
      out += String(UNITS[toks[++i]]).repeat(t === 'double' ? 2 : 3); continue;
    }
    if (t in TENS) {
      const n = toks[i + 1];
      if (n && n in UNITS && UNITS[n] > 0) { out += TENS[t] + UNITS[n]; i++; } else out += TENS[t];
      continue;
    }
    if (t in TEENS) { out += TEENS[t]; continue; }
    if (t in UNITS) { out += UNITS[t]; continue; }
  }
  return out;
}
// YY + 1-4 digits -> YY-NNN (zero-padded to 3) or YY-NNNN; anything else -> ''
function spokenToJO(s) {
  const d = spokenToDigits(s); const m = d.match(/^(\d{2})(\d{1,4})$/);
  return m ? m[1] + '-' + (m[2].length < 3 ? m[2].padStart(3, '0') : m[2]) : '';
}
root.spokenToDigits = spokenToDigits; root.spokenToJO = spokenToJO;
if (typeof module !== 'undefined' && module.exports) { module.exports = { spokenToDigits, spokenToJO }; return; }

const SR = root.SpeechRecognition || root.webkitSpeechRecognition;
const btn = document.getElementById('btnMic'), input = document.getElementById('joInput');
if (!btn) return;
if (!SR) { btn.classList.add('hidden'); return; }
btn.classList.remove('hidden');
let rec = null;
btn.addEventListener('click', () => {
  if (rec) { rec.stop(); return; }
  // iOS only grants the camera inside a user gesture: open it now, during this tap, and reuse it later
  const cam = root.prewarmCamera ? root.prewarmCamera() : Promise.resolve(false);
  rec = new SR(); rec.lang = 'en-US'; rec.interimResults = false; rec.maxAlternatives = 1; rec.continuous = false;
  btn.classList.add('listening'); btn.setAttribute('aria-pressed', 'true');
  let heard = '', started = false;
  const finish = () => {
    if (started || !heard) return; started = true;
    const jo = spokenToJO(heard) || root.normJO(spokenToDigits(heard) || heard);
    input.value = jo;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    if (!/^\d{2}-\d{3,4}$/.test(jo)) return;
    // always auto-start; if the camera could not be opened during the tap, ask for one more tap
    cam.then(ok => { if (ok) document.getElementById('btnStart').click(); else root.askTapToStart && root.askTapToStart(); });
  };
  rec.onresult = e => {
    // iOS Safari may deliver several result events / interim results; take the latest transcript
    const r = e.results[e.results.length - 1];
    heard = r[0].transcript;
    if (r.isFinal !== false) finish();
  };
  const end = () => { rec = null; btn.classList.remove('listening'); btn.setAttribute('aria-pressed', 'false'); finish(); };
  rec.onend = end; rec.onerror = end;
  try { rec.start(); } catch (_) { end(); }
});
})(typeof window !== 'undefined' ? window : globalThis);

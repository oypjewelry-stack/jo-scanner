/**
 * OYP cost estimator + quotes (back office #/estimate). Paste as a new SCRIPT file "Costing" in the same project.
 * Needs JobSync.gs (isExec_, stripPricing_, jobKey_, jobRows_, jobAppend_, jobSet_, jobHeader_) and Auth.gs.
 * Hook (Auth.gs handleAction_, right after the JobSync line):
 *   if (typeof isCostAction_ === 'function' && isCostAction_(a)) return handleCost_(req, s.user); // Costing.gs
 * One-time: run setupCosting() — adds the tabs Rates and Quotes if missing and fills Rates with the owner's costing sheet
 * (only when Rates is new; an existing Rates tab is never changed).
 *
 * Formula (owner's costing sheet, 2026-10-17):
 *   materials = grams × rate per gram        → SRP × materials markup (2.5)
 *   labor     = hours × rate per hour        → SRP × 2.8 (stock / making of orders) or × 3 (repairs)
 *   stones    = carats × USD per ct × USD→PHP → SRP × 1.35
 *   cost = sum of raw costs; SRP = sum of marked-up parts; margin = price − cost (at SRP and at "Your price").
 * Visibility: admin + production_manager may estimate. Only executives (EXEC_ROLES, default admin) get markups, SRP,
 * Your price and margins; everyone else gets raw inputs and raw costs only, enforced here and by stripPricing_.
 */
var COST = {
  ROLES: { admin: true, production_manager: true },
  TABS: {
    Rates: ['rate_id', 'category', 'code', 'label', 'unit', 'rate', 'active', 'sort', 'note', 'updated_at', 'updated_by'],
    Quotes: ['quote_id', 'jo', 'version', 'amount', 'breakdown_json', 'status', 'gmail_draft_id', 'cost_total', 'srp_total',
      'created_at', 'created_by', 'updated_at', 'updated_by']
  },
  // category, code, label, unit, rate, sort   (from the owner's handwritten costing sheet)
  SEED: [
    ['material', 'alloy_14k', '14KT alloy', 'g', 8000, 10], ['material', 'alloy_18k', '18KT alloy', 'g', 11500, 11],
    ['material', 'gold_24k', '24KT gold', 'g', 8930, 20], ['material', 'gold_18k', '18KT gold', 'g', 6697.5, 21],
    ['material', 'gold_14k', '14KT gold', 'g', 5209.17, 22], ['material', 'silver', 'Silver', 'g', '', 30], ['material', 'platinum', 'Platinum', 'g', '', 31],
    ['labor', 'goldsmith', 'Goldsmith (Romy)', 'h', 174.25, 10], ['labor', 'stonesetter', 'Stone setter (Roy)', 'h', 220, 11], ['labor', 'polisher', 'Polisher', 'h', 132.5, 12],
    ['stone', 'diamond_usd_ct', 'Diamond (USD per carat)', 'USD/ct', 650, 10], ['fx', 'usd_php', 'USD → PHP (rate today)', 'PHP', 63, 10],
    ['markup', 'materials', 'Materials markup', 'x', 2.5, 10], ['markup', 'labor_stock', 'Labor markup · stock & making of orders', 'x', 2.8, 11],
    ['markup', 'labor_repair', 'Labor markup · repairs', 'x', 3, 12], ['markup', 'stones', 'Stones markup', 'x', 1.35, 13]
  ],
  RAW_CATEGORIES: { material: true, labor: true, stone: true, fx: true } // what a non-executive may see
};

function isCostAction_(a) { return /^cost[A-Z]/.test(String(a || '')); }
function handleCost_(req, user) {
  var acts = { costRates: costRates_, costCalc: costCalcAction_, costSave: costSave_, costQuotes: costQuotes_, costRateSave: costRateSave_ };
  if (!acts[req.action]) return { ok: false, error: 'Unknown action' };
  if (!COST.ROLES[user.role]) { audit_(user.username, 'denied', req.action, req.device_id, 'role ' + user.role); return { ok: false, error: 'Not allowed', code: 'FORBIDDEN' }; }
  if (!ss_().getSheetByName('Rates')) return { ok: false, error: 'The Sheet is not set up for costing yet (run setupCosting).', code: 'NO_TABS' };
  var exec = isExec_(user);
  if (!exec && costHasPriceInput_(req)) {
    audit_(user.username, 'denied', req.action, req.device_id, 'pricing input from role ' + user.role);
    return { ok: false, error: 'Markups and prices are for executives only', code: 'FORBIDDEN' };
  }
  var write = req.action === 'costSave' || req.action === 'costRateSave';
  var res = write ? withLock_(function () { return acts[req.action](req, user, exec); }) : acts[req.action](req, user, exec);
  return stripPricing_(res, user); // belt and braces
}
function costHasPriceInput_(req) {
  var e = req.estimate || {};
  return e.your_price != null && e.your_price !== '' || e.markups != null || (req.rate && req.rate.category === 'markup');
}

/** ONE-TIME SETUP: select setupCosting and click Run. Adds missing tabs; seeds Rates only if it was just created. */
function setupCosting() {
  var ss = ss_(), added = [], t = now_();
  Object.keys(COST.TABS).forEach(function (name) {
    if (ss.getSheetByName(name)) return;
    var sh = ss.insertSheet(name); sh.getRange(1, 1, 1, COST.TABS[name].length).setValues([COST.TABS[name]]); sh.setFrozenRows(1); added.push(name);
  });
  if (added.indexOf('Rates') >= 0) COST.SEED.forEach(function (r) {
    jobAppend_('Rates', { rate_id: 'rt-' + randHex_(8), category: r[0], code: r[1], label: r[2], unit: r[3], rate: r[4], active: true, sort: r[5],
      note: 'from costing sheet 2026-10-17', updated_at: t, updated_by: 'setup' });
  });
  audit_('setup', 'setupCosting', '', '', 'added ' + (added.join(', ') || 'none'));
  Logger.log('Sheet: ' + ss.getUrl() + '\nAdded tabs: ' + (added.join(', ') || 'none') + (added.indexOf('Rates') >= 0 ? '\nRates filled from the costing sheet.' : ''));
  return { added: added };
}

/* ---------- rates ---------- */
function costRateRows_() {
  return jobRows_('Rates').filter(function (r) { return r.code !== '' && String(r.active) !== 'false'; }).map(function (r) {
    return { rate_id: String(r.rate_id), category: String(r.category), code: String(r.code), label: String(r.label || r.code), unit: String(r.unit || ''),
      rate: r.rate === '' || r.rate == null ? null : Number(r.rate), sort: Number(r.sort) || 0, updated_at: jobStr_(r.updated_at) };
  }).sort(function (a, b) { return a.category < b.category ? -1 : a.category > b.category ? 1 : a.sort - b.sort; });
}
function costRates_(req, user, exec) {
  var all = costRateRows_(), raw = all.filter(function (r) { return COST.RAW_CATEGORIES[r.category]; });
  var out = { ok: true, rates: raw, exec: exec };
  if (exec) out.markups = all.filter(function (r) { return r.category === 'markup'; }).map(function (r) { return { code: r.code, label: r.label, markup: r.rate, rate_id: r.rate_id }; });
  return out;
}
/** Executives may change any rate; others none. Never deletes; the old value goes to AuditLog. */
function costRateSave_(req, user, exec) {
  if (!exec) return { ok: false, error: 'Only executives can change rates', code: 'FORBIDDEN' };
  var x = req.rate || {}, n = Number(x.value);
  if (!(n >= 0) || String(x.value).trim() === '') return { ok: false, error: 'Rate must be a number' };
  var r = jobRows_('Rates').filter(function (r) { return String(r.rate_id) === String(x.rate_id); })[0];
  if (!r) return { ok: false, error: 'No such rate' };
  if (x.seen != null && String(x.seen) !== String(r.rate)) return { ok: false, code: 'CONFLICT', error: 'Someone changed this rate meanwhile (now ' + r.rate + ')' };
  jobSet_('Rates', r._row, { rate: n, updated_at: now_(), updated_by: user.username });
  audit_(user.username, 'rateChange', String(r.code), req.device_id, r.category + ' ' + r.rate + ' -> ' + n);
  return { ok: true };
}

/* ---------- the calculation (same formula as estimate.js in the staff app) ---------- */
function costR2_(x) { return Math.round((Number(x) || 0) * 100) / 100; }
/**
 * est = { kind: 'stock'|'repair', materials: [{code, grams, rate?}], labor: [{code, hours, rate?}],
 *         stones: [{label, pcs, carats, usd_per_ct?, fx?}], your_price? }
 * rates = { material: {code: rate}, labor: {...}, stone: {diamond_usd_ct}, fx: {usd_php}, markup: {...} }
 */
function costCalc_(est, rates, withPrices) {
  est = est || {}; var mk = rates.markup || {};
  var line = function (qty, rate) { return costR2_((Number(qty) || 0) * (Number(rate) || 0)); };
  var mats = (est.materials || []).filter(function (m) { return Number(m.grams) > 0; }).map(function (m) {
    var rate = m.rate != null && m.rate !== '' ? Number(m.rate) : (rates.material || {})[m.code];
    return { code: m.code || '', label: m.label || '', grams: Number(m.grams), rate: rate == null ? null : Number(rate), cost: line(m.grams, rate) };
  });
  var labor = (est.labor || []).filter(function (l) { return Number(l.hours) > 0; }).map(function (l) {
    var rate = l.rate != null && l.rate !== '' ? Number(l.rate) : (rates.labor || {})[l.code];
    return { code: l.code || '', label: l.label || '', hours: Number(l.hours), rate: rate == null ? null : Number(rate), cost: line(l.hours, rate) };
  });
  var stones = (est.stones || []).filter(function (s) { return Number(s.carats) > 0; }).map(function (s) {
    var usd = s.usd_per_ct != null && s.usd_per_ct !== '' ? Number(s.usd_per_ct) : (rates.stone || {}).diamond_usd_ct;
    var fx = s.fx != null && s.fx !== '' ? Number(s.fx) : (rates.fx || {}).usd_php;
    return { label: s.label || 'Diamond', pcs: Number(s.pcs) || 0, carats: Number(s.carats), usd_per_ct: Number(usd) || 0, fx: Number(fx) || 0,
      cost: costR2_(Number(s.carats) * (Number(usd) || 0) * (Number(fx) || 0)) };
  });
  var sum = function (a) { return costR2_(a.reduce(function (t, x) { return t + x.cost; }, 0)); };
  var out = { kind: est.kind === 'repair' ? 'repair' : 'stock', materials: mats, labor: labor, stones: stones,
    cost: { materials: sum(mats), labor: sum(labor), stones: sum(stones) } };
  out.cost.total = costR2_(out.cost.materials + out.cost.labor + out.cost.stones);
  out.missing_rates = mats.concat(labor).filter(function (x) { return x.rate == null || isNaN(x.rate); }).map(function (x) { return x.code; });
  if (!withPrices) return out;
  var m = { materials: Number(mk.materials) || 0, labor: Number(out.kind === 'repair' ? mk.labor_repair : mk.labor_stock) || 0, stones: Number(mk.stones) || 0 };
  var srp = { materials: costR2_(out.cost.materials * m.materials), labor: costR2_(out.cost.labor * m.labor), stones: costR2_(out.cost.stones * m.stones) };
  srp.total = costR2_(srp.materials + srp.labor + srp.stones);
  out.markup = m; out.srp = srp;
  out.margin = { at_srp: costR2_(srp.total - out.cost.total), at_srp_pct: srp.total ? costR2_((srp.total - out.cost.total) / srp.total * 100) : null };
  var yp = est.your_price === '' || est.your_price == null ? null : Number(est.your_price);
  if (yp != null && !isNaN(yp)) { out.your_price = costR2_(yp); out.margin.at_your_price = costR2_(yp - out.cost.total); out.margin.at_your_price_pct = yp ? costR2_((yp - out.cost.total) / yp * 100) : null; }
  return out;
}
function costRateMap_() {
  var m = { material: {}, labor: {}, stone: {}, fx: {}, markup: {} };
  costRateRows_().forEach(function (r) { if (m[r.category] && r.rate != null) m[r.category][r.code] = r.rate; });
  return m;
}
function costCalcAction_(req, user, exec) { return { ok: true, result: costCalc_(req.estimate, costRateMap_(), exec) }; }

/* ---------- quotes on a JO ---------- */
/** Saves a new Quote version (status draft) with the server's own numbers. amount = Your price, else SRP (executives only). */
function costSave_(req, user, exec) {
  var jo = jobKey_(req.jo); if (!jo) return { ok: false, error: 'Type the JO number' };
  if (!ss_().getSheetByName('Quotes')) return { ok: false, error: 'No Quotes tab (run setupCosting)' };
  if (ss_().getSheetByName('JobOrders') && !jobRows_('JobOrders').some(function (j) { return jobKey_(j.jo) === jo; })) return { ok: false, error: 'No JO ' + jo + ' in the Sheet' };
  var rates = costRateMap_(), r = costCalc_(req.estimate, rates, true);
  if (!r.cost.total) return { ok: false, error: 'Nothing to save yet: add materials, labor or stones' };
  var mine = jobRows_('Quotes').filter(function (q) { return jobKey_(q.jo) === jo; });
  var version = mine.reduce(function (v, q) { return Math.max(v, Number(q.version) || 0); }, 0) + 1, t = now_(), id = 'q-' + randHex_(8);
  var breakdown = { inputs: req.estimate || {}, result: r, rates_used: rates, by_role: user.role, note: String(req.note || '').slice(0, 300) };
  if (!exec) { delete breakdown.inputs.your_price; } // a non-executive's save carries inputs + raw costs; the price is set by an executive later
  jobAppend_('Quotes', { quote_id: id, jo: jo, version: version, amount: exec ? (r.your_price != null ? r.your_price : r.srp.total) : '',
    breakdown_json: JSON.stringify(breakdown), status: 'draft', cost_total: r.cost.total, srp_total: exec ? r.srp.total : '',
    created_at: t, created_by: user.username, updated_at: t, updated_by: user.username });
  audit_(user.username, 'quoteSave', jo, req.device_id, 'v' + version + ' cost ' + r.cost.total + (exec ? ' price ' + (r.your_price != null ? r.your_price : r.srp.total) : ' (inputs only)'));
  return { ok: true, quote_id: id, version: version, jo: jo, result: exec ? r : costCalc_(req.estimate, rates, false) };
}
/** Quotes saved on a JO. Non-executives get version, date, who and raw cost only. */
function costQuotes_(req, user, exec) {
  var jo = jobKey_(req.jo); if (!jo) return { ok: false, error: 'Type the JO number' };
  var list = jobRows_('Quotes').filter(function (q) { return jobKey_(q.jo) === jo; }).map(function (q) {
    var o = { quote_id: String(q.quote_id), version: Number(q.version) || 0, status: String(q.status || ''), created_at: jobStr_(q.created_at), created_by: String(q.created_by || ''),
      cost_total: Number(q.cost_total) || 0 };
    var b = {}; try { b = JSON.parse(q.breakdown_json || '{}'); } catch (e) {}
    o.inputs = b.inputs ? { kind: b.inputs.kind, materials: b.inputs.materials, labor: b.inputs.labor, stones: b.inputs.stones } : null;
    if (exec) { o.quote_amount = q.amount === '' ? null : Number(q.amount); o.srp = q.srp_total === '' ? null : Number(q.srp_total); if (b.inputs && b.inputs.your_price != null) o.inputs.your_price = b.inputs.your_price; }
    return o;
  }).sort(function (a, b) { return b.version - a.version; });
  return { ok: true, jo: jo, quotes: list };
}

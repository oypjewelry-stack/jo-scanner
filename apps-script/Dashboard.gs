/**
 * OYP business dashboard (back office #/dashboard).
 * Paste as a new script file "Dashboard" in the same Apps Script project as Code.gs, Auth.gs and Customers.gs.
 * READ-ONLY: it never creates, writes or deletes a tab or row. Tabs that don't exist yet are reported in
 * `missing` and simply count as empty.
 * Reads: JobOrders, JobStages, Clients, Items, Consignees, Consignments, ConsignmentItems, Payments, Settings.
 * Hook (Auth.gs handleAction_, after the `logout` line):
 *   if (a === 'dashboard' && typeof dashboard_ === 'function') return dashboard_(req, s.user); // Dashboard.gs
 */
var DASH = {
  TZ_OFFSET_H: 8,                 // Asia/Manila, no daylight saving
  OVERDUE_DAYS_DEFAULT: 30,       // Settings key consign_overdue_days overrides this
  RECENT_PAYMENTS: 10,
  CARDS_PER_COLUMN: 40,
  // Job board columns -> the stage codes (spec §6, New + Repair templates) that sit in each column.
  COLUMNS: [
    ['intake', 'Intake', ['intake', 'quote_deposit', 'receive_inspect', 'diagnose_quote', 'repair_intake', 'assess']],
    ['design', 'Design', ['design', 'approval', 'stone_sourcing', 'model']],
    ['casting', 'Casting', ['casting', 'bench', 'repair']],
    ['setting', 'Setting', ['stone_setting', 'stone_reset', 'engraving']],
    ['polishing', 'Polishing', ['pre_polish', 'final_polish', 'plating', 'clean_polish']],
    ['qc', 'QC', ['qc', 'photo', 'final_costing']],
    ['pickup', 'Pickup', ['notify', 'pickup']]
  ],
  LOCATIONS: [['working', 'Being worked on'], ['queue', 'In queue'], ['pickup', 'For pickup'], ['vault', 'In vault'], ['showroom', 'Showroom'],
    ['consigned', 'Consigned'], ['sold', 'Sold']],
  OPEN_STATUSES: ['draft', 'active', 'done'] // done = finished, waiting for pickup; picked_up / cancelled are closed
};
// What each role may see. Sales + chart: admin only. Consignment (values follow cost rules): admin + PM.
// Payments (billing): admin + accounting. Client names: everyone except bench staff.
var DASH_ROLES = {
  admin:              { sales: true,  consign: true,  payments: true,  clients: true,  inquiries: true },
  production_manager: { sales: false, consign: true,  payments: false, clients: true,  inquiries: false },
  accounting:         { sales: false, consign: false, payments: true,  clients: true,  inquiries: false },
  staff:              { sales: false, consign: false, payments: false, clients: false, inquiries: false }
};

function dashboard_(req, user) {
  var can = DASH_ROLES[user.role];
  if (!can) return { ok: false, error: 'Not allowed', code: 'FORBIDDEN' };
  var missing = [], T = function (name) { return dashRead_(name, missing); };
  var now = new Date(), today = dashDay_(now), month = today.slice(0, 7);

  var settings = {}; T('Settings').forEach(function (r) { settings[String(r.key)] = r.value; });
  var overdueDays = Number(settings.consign_overdue_days) > 0 ? Number(settings.consign_overdue_days) : DASH.OVERDUE_DAYS_DEFAULT;

  var clients = {}; if (can.clients) T('Clients').forEach(function (c) { clients[String(c.client_id)] = { name: String(c.name || ''), phone: String(c.phone || '') }; });

  /* ---- jobs ---- */
  // Once JobOrders has a 'location' column (JobSync.gs), only 'Being worked on' JOs sit on the production board.
  var allJobs = T('JobOrders').filter(function (j) { return j.jo !== '' && j.jo != null; });
  var useLoc = allJobs.some(function (j) { return 'location' in j; });
  var live = function (j) { return String(j.status || '') !== 'cancelled'; };
  var jobs = useLoc ? allJobs.filter(function (j) { return live(j) && String(j.location || '') === 'working'; })
    : allJobs.filter(function (j) { return DASH.OPEN_STATUSES.indexOf(String(j.status || 'draft')) >= 0; });
  var colOf = {}; DASH.COLUMNS.forEach(function (c) { c[2].forEach(function (code) { colOf[code] = c[0]; }); });
  var board = DASH.COLUMNS.map(function (c) { return { key: c[0], label: c[1], count: 0, cards: [] }; });
  var byKey = {}; board.forEach(function (c) { byKey[c.key] = c; });
  var stageSince = {}; T('JobStages').forEach(function (s) { // when the current stage started, per JO
    if (s.status === 'doing' && s.started_at) { var k = String(s.jo) + '|' + s.stage_code; stageSince[k] = dashDay_(s.started_at); }
  });
  var activeJobs = 0, reviews = 0, pastDue = 0;
  if (useLoc) {
    allJobs.forEach(function (j) {
      if (!live(j)) return;
      if (j.review_state === 'draft' || String(j.status || '') === 'draft') reviews++;
      var d = dashDay_(j.due_date), loc = String(j.location || '');
      if (d && d < today && (loc === 'working' || loc === 'queue')) pastDue++;
    });
    activeJobs = jobs.length;
  }
  jobs.forEach(function (j) {
    var st = String(j.status || 'draft'), stage = String(j.current_stage || ''), due = dashDay_(j.due_date);
    if (!useLoc && st === 'active') activeJobs++;
    if (!useLoc && (st === 'draft' || j.review_state === 'draft')) reviews++;
    var late = !!(due && due < today && st !== 'done');
    if (!useLoc && late) pastDue++;
    var col = !useLoc && st === 'done' ? 'pickup' : (colOf[stage] || 'intake');
    var card = { jo: String(j.jo), description: String(j.description || ''), type: String(j.type || ''), stage: stage,
      status: st, due: due, late: late, review: st === 'draft' || j.review_state === 'draft',
      since: stageSince[String(j.jo) + '|' + stage] || '' };
    if (can.clients && clients[String(j.client_id)]) card.client = clients[String(j.client_id)].name;
    byKey[col].count++; byKey[col].cards.push(card);
  });
  board.forEach(function (c) {
    c.cards.sort(function (a, b) { return (b.late - a.late) || String(a.due || '9999').localeCompare(String(b.due || '9999')) || a.jo.localeCompare(b.jo); });
    c.cards = c.cards.slice(0, DASH.CARDS_PER_COLUMN);
  });

  /* ---- payments ---- */
  var pays = can.payments || can.sales ? T('Payments') : [];
  var pendingPays = pays.filter(function (p) { return p.status === 'pending'; }).length;

  var out = { ok: true, generated_at: now.toISOString(), today: today, role: user.role, can: can, overdue_days: overdueDays,
    counts: { active_jobs: activeJobs, pending_work: reviews + pastDue + (can.payments ? pendingPays : 0),
      pending_breakdown: { reviews: reviews, past_due: pastDue, payments: can.payments ? pendingPays : null } },
    board: board, missing: missing };

  /* ---- consignment ---- */
  if (can.consign) {
    var heads = {}, people = {}, items = {};
    T('Consignments').forEach(function (h) { heads[String(h.consignment_id)] = h; });
    T('Consignees').forEach(function (p) { people[String(p.consignee_id)] = String(p.name || ''); });
    T('Items').forEach(function (i) { items[String(i.item_id)] = i; });
    var outItems = T('ConsignmentItems').filter(function (ci) { return String(ci.status || 'consigned') === 'consigned'; }).map(function (ci) {
      var h = heads[String(ci.consignment_id)] || {}, it = items[String(ci.item_id)] || {}, d = dashDay_(h.date_out);
      var days = d ? dashDaysBetween_(d, today) : null;
      return { ci_id: String(ci.ci_id || ''), consignment_id: String(ci.consignment_id || ''), item_id: String(ci.item_id || ''),
        jo: String(ci.jo || it.jo || ''), description: String(it.name || it.description || ''), consignee: people[String(h.consignee_id)] || '',
        date_out: d, days_out: days, overdue: days != null && days > overdueDays, value: Number(ci.agreed_value || it.agreed_value) || null };
    }).sort(function (a, b) { return (b.days_out || 0) - (a.days_out || 0); });
    var outJos = {}; outItems.forEach(function (x) { if (x.jo) outJos[x.jo] = true; });
    var consignedJos = allJobs.filter(function (j) { return live(j) && String(j.location || '') === 'consigned' && !outJos[String(j.jo)]; }).length;
    out.counts.consigned_out = outItems.length + consignedJos; // items on consignment sheets + JOs marked Consigned
    out.counts.consigned_jos = consignedJos;
    if (useLoc) {
      var loc = {}; DASH.LOCATIONS.forEach(function (l) { loc[l[0]] = 0; }); loc.unset = 0;
      allJobs.forEach(function (j) { if (!live(j)) return; var k = String(j.location || ''); if (k in loc && k !== 'unset') loc[k]++; else loc.unset++; });
      out.locations = DASH.LOCATIONS.map(function (l) { return { key: l[0], label: l[1], count: loc[l[0]] }; }).concat([{ key: 'unset', label: 'No location yet', count: loc.unset }]);
    }
    out.counts.overdue_consignments = outItems.filter(function (x) { return x.overdue; }).length;
    out.consignments = outItems;
  }

  /* ---- recent payments (billing) ---- */
  if (can.payments) {
    out.payments = pays.filter(function (p) { return p.status !== 'rejected' && p.pay_id !== ''; })
      .map(function (p) { return { pay_id: String(p.pay_id), jo: String(p.jo || ''), date: dashDay_(p.date || p.confirmed_at), amount: Number(p.amount) || 0,
        method: String(p.method || ''), kind: String(p.kind || ''), payer: String(p.payer || ''), status: String(p.status || ''), source: String(p.source || '') }; })
      .sort(function (a, b) { return String(b.date).localeCompare(String(a.date)); }).slice(0, DASH.RECENT_PAYMENTS);
  }

  /* ---- sales (admin only): confirmed payments received ---- */
  if (can.sales) {
    var months = [], d0 = new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1));
    for (var i = 5; i >= 0; i--) { var m = new Date(Date.UTC(d0.getUTCFullYear(), d0.getUTCMonth() - i, 1)); months.push(m.toISOString().slice(0, 7)); }
    var byMonth = {}; months.forEach(function (k) { byMonth[k] = 0; });
    pays.forEach(function (p) {
      if (p.status !== 'confirmed') return;
      var k = dashDay_(p.date || p.confirmed_at).slice(0, 7);
      if (k in byMonth) byMonth[k] += Number(p.amount) || 0;
    });
    out.counts.month_sales = byMonth[month];
    out.sales = { month: month, months: months.map(function (k) { return { month: k, total: byMonth[k] }; }) };
  }

  /* ---- later: per-JO email inquiries (placeholder hook, nothing read yet) ---- */
  if (can.inquiries) out.inquiries = typeof dashInquiries_ === 'function' ? dashInquiries_(jobs) : null;
  return out;
}

/* ---------- helpers (read-only) ---------- */
function dashRead_(name, missing) { // like readOpt_, but notes which tabs are absent and never creates one
  var sh = ss_().getSheetByName(name);
  if (!sh) { if (missing.indexOf(name) < 0) missing.push(name); return []; }
  if (sh.getLastRow() < 2) return [];
  var v = sh.getDataRange().getValues(), h = v[0].map(function (x) { return String(x).trim(); }), out = [];
  for (var i = 1; i < v.length; i++) {
    if (v[i].every(function (x) { return x === '' || x === null; })) continue;
    var o = {}; for (var j = 0; j < h.length; j++) if (h[j]) o[h[j]] = v[i][j]; out.push(o);
  }
  return out;
}
function dashDay_(d) { // any date-ish value -> 'yyyy-MM-dd' in Manila time, or ''
  if (d === '' || d == null) return '';
  if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d.trim())) return d.trim();
  var x = d instanceof Date ? d : new Date(d);
  if (isNaN(x.getTime())) return '';
  return new Date(x.getTime() + DASH.TZ_OFFSET_H * 36e5).toISOString().slice(0, 10);
}
function dashDaysBetween_(a, b) { return Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5); }

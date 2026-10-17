// Realistic sample data for the dashboard (tests + mockup screenshots). Dates are relative to "today" (Manila).
module.exports = function seedDash(g, opts = {}) {
  const day = n => new Date(Date.now() + 8 * 36e5 + n * 864e5).toISOString().slice(0, 10); // n days from today, Manila
  const mk = (name, rows) => { const sh = g.SpreadsheetApp.openById().insertSheet(name); rows.forEach(r => sh.appendRow(r)); return sh; };
  mk('Clients', [['client_id', 'name', 'aliases', 'phone', 'email', 'billing_info', 'notes', 'portal_code'],
    ['cl-a', 'Maria Santos', '', '0917 123 4567', 'maria@example.com', '', '', ''], ['cl-b', 'Ben Cruz', '', '0918 555 0000', '', '', '', ''],
    ['cl-c', 'Cora Lim', '', '0919 777 8888', '', '', '', ''], ['cl-d', 'Dino Reyes', '', '0920 111 2222', '', '', '', ''],
    ['cl-e', 'Elena Tan', '', '0921 333 4444', '', '', '', ''], ['cl-f', 'Franco Uy', '', '0922 999 1212', '', '', '', '']]);
  const J = (jo, type, status, stage, client, desc, metal, due, review = 'reviewed') => [jo, type, '', '', status, stage, '', client, desc, metal, '', '', due, '', '', '', review];
  mk('JobOrders', [['jo', 'type', 'parent_jo', 'root_jo', 'status', 'current_stage', 'item_id', 'client_id', 'description', 'metal', 'karat', 'size', 'due_date', 'rate_snapshot_id', 'product_photo_file_id', 'drive_folder_id', 'review_state'],
    J('26-001', 'new', 'active', 'bench', 'cl-a', 'Silver coin necklace', 'Silver 925', day(5)),
    J('26-002', 'new', 'active', 'qc', 'cl-b', 'Cufflinks, brushed', '18k gold', day(1)),
    J('26-003', 'new', 'active', 'stone_setting', 'cl-c', 'Combi earrings', '14k white', day(3)),
    J('26-004', 'new', 'active', 'design', 'cl-d', 'Signet ring, family crest', '18k yellow', day(21)),
    J('26-005', 'new', 'active', 'final_polish', 'cl-e', 'Tennis bracelet', '14k white', day(-2)),
    J('26-005B', 'revision', 'active', 'intake', 'cl-e', 'Bracelet clasp redo', '14k white', day(12)),
    J('26-006', 'repair', 'active', 'repair', 'cl-f', 'Chain clasp repair', '18k yellow', day(4)),
    J('26-007', 'new', 'draft', 'intake', 'cl-a', 'Pearl pendant', 'Silver 925', '', 'draft'),
    J('26-008', 'new', 'active', 'casting', 'cl-b', 'Wedding bands (pair)', 'Platinum', day(9)),
    J('26-009', 'new', 'done', 'notify', 'cl-c', 'Engagement ring', '18k white', day(-1)),
    J('26-010', 'new', 'active', 'approval', 'cl-d', 'Baptism bracelet', '18k yellow', day(14)),
    J('25-118', 'new', 'picked_up', 'pickup', 'cl-a', 'Old job (closed)', '', day(-40)),
    J('26-011', 'repair', 'cancelled', 'intake', 'cl-b', 'Cancelled', '', '')]);
  mk('JobStages', [['stage_id', 'jo', 'seq', 'stage_code', 'status', 'started_at', 'ended_at', 'assignee'],
    ['s1', '26-001', 9, 'bench', 'doing', day(-3), '', 'Thea'], ['s2', '26-002', 14, 'qc', 'doing', day(-1), '', 'Susan'],
    ['s3', '26-005', 12, 'final_polish', 'doing', day(-6), '', 'Jun']]);
  mk('Payments', [['pay_id', 'jo', 'date', 'amount', 'method', 'kind', 'payer', 'receipt_file_id', 'status', 'source'],
    ['p1', '26-001', day(-1), 3500, 'GCash', 'deposit', 'Maria Santos', '', 'confirmed', 'telegram'],
    ['p2', '26-002', day(-2), 25000, 'Bank transfer', 'deposit', 'Ben Cruz', '', 'confirmed', 'manual'],
    ['p3', '26-009', day(0), 42800, 'BDO', 'balance', 'Cora Lim', '', 'pending', 'telegram'],
    ['p4', '26-004', day(-4), 15000, 'Cash', 'deposit', 'Dino Reyes', '', 'confirmed', 'manual'],
    ['p5', '26-005', day(-9), 38000, 'GCash', 'deposit', 'Elena Tan', '', 'confirmed', 'telegram'],
    ['p6', '26-006', day(-5), 1800, 'Cash', 'balance', 'Franco Uy', '', 'rejected', 'telegram'],
    ['p7', '26-008', day(-12), 30000, 'Bank transfer', 'deposit', 'Ben Cruz', '', 'confirmed', 'manual'],
    ['p8', '25-118', day(-45), 52000, 'Bank transfer', 'balance', 'Maria Santos', '', 'confirmed', 'manual'],
    ['p9', '25-110', day(-75), 61500, 'Cash', 'balance', 'Walk-in', '', 'confirmed', 'manual'],
    ['p10', '25-101', day(-105), 44200, 'GCash', 'balance', 'Walk-in', '', 'confirmed', 'manual'],
    ['p11', '25-090', day(-140), 70300, 'Cash', 'balance', 'Walk-in', '', 'confirmed', 'manual']]);
  if (opts.noConsign) return;
  mk('Items', [['item_id', 'jo', 'item_type', 'name', 'description', 'metal', 'karat', 'weight_g', 'photo_file_id', 'status', 'qr_printed_at', 'agreed_value'],
    ['OYP-25090-01', '25-090', 'ring', 'Emerald cocktail ring', '', '18k', '', 6.2, '', 'consigned', '', 68000],
    ['OYP-25094-01', '25-094', 'pendant', 'Sampaguita pendant', '', '14k', '', 3.1, '', 'consigned', '', 18500],
    ['OYP-25101-01', '25-101', 'earrings', 'Pearl drop earrings', '', 'Silver', '', 4.4, '', 'consigned', '', 7800],
    ['OYP-26003-01', '26-003', 'ring', 'Halo ring', '', '18k white', '', 4.9, '', 'consigned', '', 54000],
    ['OYP-25110-01', '25-110', 'bracelet', 'Link bracelet', '', '18k', '', 12.0, '', 'in_stock', '', 82000]]);
  mk('Consignees', [['consignee_id', 'name', 'relation', 'phone', 'address', 'notes', 'active'], ['cn-1', 'Tita Lorna', 'relative', '', '', '', true], ['cn-2', 'Gallery Uno', 'shop', '', '', '', true]]);
  mk('Consignments', [['consignment_id', 'consignee_id', 'date_out', 'released_by', 'received_by_name', 'status', 'sheet_file_id', 'show_values', 'notes'],
    ['CS-26-001', 'cn-1', day(-47), 'miriam', 'Lorna', 'partial', '', true, ''], ['CS-26-002', 'cn-2', day(-34), 'miriam', 'Uno', 'open', '', false, ''],
    ['CS-26-003', 'cn-1', day(-8), 'susan', 'Lorna', 'open', '', true, '']]);
  mk('ConsignmentItems', [['ci_id', 'consignment_id', 'item_id', 'jo', 'agreed_value', 'status', 'returned_at', 'returned_to', 'sold_at', 'pay_id'],
    ['ci-1', 'CS-26-001', 'OYP-25090-01', '25-090', 68000, 'consigned', '', '', '', ''], ['ci-2', 'CS-26-001', 'OYP-25110-01', '25-110', 82000, 'returned', day(-20), 'miriam', '', ''],
    ['ci-3', 'CS-26-002', 'OYP-25094-01', '25-094', 18500, 'consigned', '', '', '', ''], ['ci-4', 'CS-26-002', 'OYP-25101-01', '25-101', 7800, 'consigned', '', '', '', ''],
    ['ci-5', 'CS-26-003', 'OYP-26003-01', '26-003', 54000, 'consigned', '', '', '', '']]);
};

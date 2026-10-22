const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = __dirname;
const PUBLIC = path.join(ROOT, 'public');
const DATA_DIR = path.resolve(process.env.ERP_DATA_DIR || path.join(ROOT, 'data'));
const DB_FILE = path.join(DATA_DIR, 'db.json');
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '127.0.0.1';
const TIME_ZONE = process.env.TZ || 'Asia/Kolkata';
const MIME = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8' };
const clients = new Set();
let mutationQueue = Promise.resolve();

function todayIso() {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: TIME_ZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  const value = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}
function freshDb() {
  return {
    business: { name: '', currency: 'INR' },
    sync: { lastSyncAt: null, lastSource: '', entity: '', created: 0, updated: 0, mode: '' },
    orders: [], inventory: [], invoices: [], invoiceReminders: [], workflows: [
      { id: 'wf-stock', name: 'Smart replenishment', description: 'Prepare a purchase request when available stock reaches its reorder point.', trigger: 'Available stock at or below reorder point', runs: 0, active: true, icon: 'inventory', color: 'violet' },
      { id: 'wf-invoice', name: 'Invoice follow-up', description: 'Prepare a reminder draft for an overdue open invoice.', trigger: 'Invoice due date has passed', runs: 0, active: true, icon: 'receipt', color: 'amber' },
      { id: 'wf-orders', name: 'Order triage', description: 'Summarise open orders and highlight high-priority work.', trigger: 'Manual workflow run', runs: 0, active: true, icon: 'orders', color: 'blue' }
    ],
    approvals: [], activity: [], nextOrder: 1, nextSku: 1, nextInvoice: 1, nextReminder: 1, nextApproval: 1, nextEvent: 1
  };
}
function readDb() {
  if (!fs.existsSync(DB_FILE)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(DB_FILE, `${JSON.stringify(freshDb(), null, 2)}\n`);
  }
  const db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  if (!db.sync) db.sync = freshDb().sync;
  return db;
}
function writeDb(db) {
  const temp = `${DB_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(db, null, 2)}\n`);
  fs.renameSync(temp, DB_FILE);
}
function send(res, status, data, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(type.startsWith('application/json') ? JSON.stringify(data) : data);
}
function body(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', chunk => {
      raw += chunk;
      if (raw.length > 5_000_000) { reject(new Error('Request body is too large.')); req.destroy(); }
    });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON body.')); } });
    req.on('error', reject);
  });
}
function mutate(work) {
  const task = mutationQueue.then(async () => {
    const db = readDb();
    const result = await work(db);
    writeDb(db);
    publishUpdate();
    return result;
  });
  mutationQueue = task.catch(() => {});
  return task;
}
function publishUpdate() {
  const message = `event: workspace.updated\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`;
  for (const client of clients) client.write(message);
}
function addEvent(db, agent, title, description, status, icon, color) {
  const event = { id: `EV-${String(db.nextEvent++).padStart(5, '0')}`, agent, title, description, status, icon, color, createdAt: new Date().toISOString() };
  db.activity.unshift(event);
  db.activity = db.activity.slice(0, 250);
  return event;
}
function nextId(db, counter, prefix, width = 5) {
  const id = `${prefix}-${String(db[counter]++).padStart(width, '0')}`;
  return id;
}
function calculateDerived(db) {
  const today = todayIso();
  const currentMonth = today.slice(0, 7);
  const openOrders = db.orders.filter(order => !['Shipped', 'Cancelled'].includes(order.status));
  const monthOrderValue = db.orders.filter(order => order.createdAt?.slice(0, 7) === currentMonth && order.status !== 'Cancelled').reduce((sum, order) => sum + order.amount, 0);
  const lowStockCount = db.inventory.filter(item => item.onHand - item.reserved <= item.reorderLevel).length;
  const overdueCount = db.invoices.filter(invoice => invoice.status === 'Open' && invoice.dueDate < today).length;
  const workflowRuns = db.workflows.reduce((sum, workflow) => sum + workflow.runs, 0);
  const shippedCount = db.orders.filter(order => order.status === 'Shipped').length;
  const months = [];
  const now = new Date(`${today}T12:00:00`);
  for (let offset = 5; offset >= 0; offset--) {
    const date = new Date(now.getFullYear(), now.getMonth() - offset, 1);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
    const value = db.orders.filter(order => order.createdAt?.slice(0, 7) === key && order.status !== 'Cancelled').reduce((sum, order) => sum + order.amount, 0);
    months.push({ key, label: date.toLocaleDateString('en-IN', { month: 'short' }), value });
  }
  const invoices = db.invoices.map(invoice => ({ ...invoice, status: invoice.status === 'Open' && invoice.dueDate && invoice.dueDate < today ? 'Overdue' : invoice.status }));
  return {
    today,
    metrics: { monthOrderValue, openOrders: openOrders.length, lowStock: lowStockCount, overdueInvoices: overdueCount, workflowRuns, shippedOrders: shippedCount },
    months,
    invoices
  };
}
function findIntent(command) {
  const text = command.toLowerCase();
  if (/stock|inventory|replenish|purchase order|supplier|restock/.test(text)) return 'inventory';
  if (/invoice|payment|overdue|reminder|finance/.test(text)) return 'invoice';
  if (/order|shipment|fulfil|fulfill|priority/.test(text)) return 'orders';
  return 'overview';
}
async function chooseIntent(command, db) {
  if (!process.env.OPENAI_API_KEY) return { intent: findIntent(command), mode: 'local-rules', rationale: 'Matched your request to a supported business workflow.' };
  const tool = {
    type: 'function', name: 'plan_erp_workflow',
    description: 'Select the one ERP workflow that best matches the request. This only plans; application code performs fixed actions and keeps purchases behind human approval.',
    strict: true,
    parameters: {
      type: 'object',
      properties: { intent: { type: 'string', enum: ['inventory', 'invoice', 'orders', 'overview'] }, rationale: { type: 'string' } },
      required: ['intent', 'rationale'], additionalProperties: false
    }
  };
  const context = {
    lowStockItems: db.inventory.filter(item => item.onHand - item.reserved <= item.reorderLevel).map(({ name, onHand, reserved, reorderLevel }) => ({ name, available: onHand - reserved, reorderLevel })),
    overdueInvoiceCount: db.invoices.filter(invoice => invoice.status === 'Open' && invoice.dueDate < todayIso()).length,
    openOrderCount: db.orders.filter(order => !['Shipped', 'Cancelled'].includes(order.status)).length
  };
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
    signal: AbortSignal.timeout(20000),
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-6-astra',
      instructions: 'Route this request for an ERP. Choose exactly one supported intent using the plan_erp_workflow function. Do not invent data or claim actions have happened. Use overview if unclear. Keep rationale to one sentence.',
      input: JSON.stringify({ request: command, actualWorkspaceSummary: context }),
      tools: [tool], tool_choice: { type: 'function', name: 'plan_erp_workflow' }, parallel_tool_calls: false
    })
  });
  if (!response.ok) throw new Error(`AI provider returned ${response.status}`);
  const result = await response.json();
  const planned = result.output?.find(item => item.type === 'function_call' && item.name === 'plan_erp_workflow');
  if (!planned) throw new Error('AI provider did not return a workflow plan');
  const parsed = JSON.parse(planned.arguments);
  if (!['inventory', 'invoice', 'orders', 'overview'].includes(parsed.intent)) throw new Error('AI provider returned an unsupported workflow');
  return { intent: parsed.intent, mode: 'openai', rationale: String(parsed.rationale || '').slice(0, 240) };
}
function runAgent(db, command, plan) {
  const intent = plan.intent;
  const workflowId = ({ inventory: 'wf-stock', invoice: 'wf-invoice', orders: 'wf-orders' })[intent];
  const workflow = db.workflows.find(item => item.id === workflowId);
  if (intent !== 'overview' && workflow && !workflow.active) {
    return { intent, agentMode: plan.mode, rationale: plan.rationale, summary: `The ${workflow.name} workflow is paused. Enable it before running it.`, toolCalls: [], ranAt: new Date().toISOString(), paused: true };
  }
  const toolCalls = [];
  let summary = '';
  const runIds = intent === 'overview' ? ['wf-stock', 'wf-invoice', 'wf-orders'] : workflowId ? [workflowId] : [];
  runIds.forEach(id => { const entry = db.workflows.find(item => item.id === id); if (entry?.active) entry.runs += 1; });

  if (intent === 'inventory' || intent === 'overview') {
    toolCalls.push('inventory.findBelowReorderPoint');
    const low = db.inventory.filter(item => item.onHand - item.reserved <= item.reorderLevel);
    let created = 0;
    for (const item of low) {
      const pending = db.approvals.some(approval => approval.itemId === item.id && approval.status === 'Pending');
      if (pending) continue;
      const available = item.onHand - item.reserved;
      const quantity = Math.max(item.reorderLevel * 2 - available, item.reorderLevel + 1);
      const approval = {
        id: nextId(db, 'nextApproval', 'PR'), kind: 'Purchase request', title: `Replenish ${item.name}`,
        description: `Available: ${available} · reorder point: ${item.reorderLevel} · proposed quantity: ${quantity}.`,
        amount: quantity * item.unitCost, itemId: item.id, quantity, supplier: item.supplier || '', createdAt: new Date().toISOString(), status: 'Pending'
      };
      db.approvals.unshift(approval);
      addEvent(db, 'Inventory workflow', 'Purchase request prepared', `${item.name} · ${quantity} units · awaiting review`, 'Pending', 'inventory', 'violet');
      created++;
    }
    if (created) toolCalls.push('approvals.createPurchaseRequest');
    summary = low.length === 0
      ? `Checked ${db.inventory.length} inventory records. No products are at or below their reorder point.`
      : `Checked ${db.inventory.length} inventory records. ${created} purchase request${created === 1 ? '' : 's'} created for review; ${low.length - created} already have a pending request.`;
  }
  if (intent === 'invoice') {
    toolCalls.push('invoices.findOverdueOpen');
    const overdue = db.invoices.filter(invoice => invoice.status === 'Open' && invoice.dueDate < todayIso());
    let created = 0;
    for (const invoice of overdue) {
      const existing = db.invoiceReminders.some(reminder => reminder.invoiceId === invoice.id && reminder.status === 'Draft');
      if (existing) continue;
      const invoiceNumber = invoice.invoiceNumber || invoice.id;
      const reminder = {
        id: nextId(db, 'nextReminder', 'REM'), invoiceId: invoice.id, customer: invoice.customer,
        amount: invoice.amount, dueDate: invoice.dueDate,
        subject: `Payment reminder · invoice ${invoiceNumber}`,
        body: `Hello ${invoice.customer},\n\nOur records show invoice ${invoiceNumber} for ${formatCurrency(invoice.amount, db.business.currency)} was due on ${invoice.dueDate}. Please let us know if payment has been sent or if you need a copy of the invoice.\n\nThank you.`,
        status: 'Draft', createdAt: new Date().toISOString()
      };
      db.invoiceReminders.unshift(reminder);
      created++;
    }
    if (created) toolCalls.push('invoices.createReminderDrafts');
    summary = overdue.length === 0 ? 'There are no overdue open invoices in the records.' : `Found ${overdue.length} overdue open invoices and prepared ${created} new reminder drafts. Nothing was emailed.`;
    addEvent(db, 'Invoice workflow', 'Overdue invoice scan completed', `${overdue.length} overdue · ${created} new reminder drafts`, 'Completed', 'receipt', 'amber');
  }
  if (intent === 'orders') {
    toolCalls.push('orders.listOpen', 'orders.rankByPriority');
    const open = db.orders.filter(order => !['Shipped', 'Cancelled'].includes(order.status));
    const high = open.filter(order => order.priority === 'High');
    summary = `Reviewed ${open.length} open orders from your records; ${high.length} are marked high priority.`;
    addEvent(db, 'Order workflow', 'Open orders prioritised', `${high.length} high-priority orders out of ${open.length} open orders`, 'Completed', 'orders', 'blue');
  }
  if (intent === 'overview') {
    toolCalls.push('invoices.findOverdueOpen', 'orders.listOpen');
    const overdue = db.invoices.filter(invoice => invoice.status === 'Open' && invoice.dueDate < todayIso()).length;
    const openOrders = db.orders.filter(order => !['Shipped', 'Cancelled'].includes(order.status)).length;
    summary = `Scanned ${db.inventory.length} products, ${openOrders} open orders, and ${overdue} overdue invoices using your saved records.`;
    addEvent(db, 'Operations workflow', 'Workspace scan completed', `${db.inventory.length} products · ${openOrders} open orders · ${overdue} overdue invoices`, 'Completed', 'spark', 'blue');
  }
  addEvent(db, 'Astra workflow', 'Workflow run completed', `Intent: ${intent} · Mode: ${plan.mode} · Tools: ${toolCalls.join(', ') || 'none'}`, 'Completed', 'spark', 'blue');
  return { intent, summary, toolCalls, ranAt: new Date().toISOString(), agentMode: plan.mode, rationale: plan.rationale };
}
function autoTrigger(db, intent, reason) {
  const workflowId = ({ inventory: 'wf-stock', invoice: 'wf-invoice' })[intent];
  const workflow = db.workflows.find(item => item.id === workflowId);
  if (!workflow || !workflow.active) return null;
  return runAgent(db, reason, { intent, mode: 'local-rules', rationale: 'A saved record met this workflow’s trigger.' });
}
async function runBackgroundAutomation() {
  const current = readDb();
  const lowStockNeedsRequest = current.workflows.find(item => item.id === 'wf-stock')?.active && current.inventory.some(item => item.onHand - item.reserved <= item.reorderLevel && !current.approvals.some(approval => approval.itemId === item.id && approval.status === 'Pending'));
  const invoiceNeedsDraft = current.workflows.find(item => item.id === 'wf-invoice')?.active && current.invoices.some(invoice => invoice.status === 'Open' && invoice.dueDate < todayIso() && !current.invoiceReminders.some(reminder => reminder.invoiceId === invoice.id && reminder.status === 'Draft'));
  if (!lowStockNeedsRequest && !invoiceNeedsDraft) return;
  await mutate(db => {
    const needsStock = db.workflows.find(item => item.id === 'wf-stock')?.active && db.inventory.some(item => item.onHand - item.reserved <= item.reorderLevel && !db.approvals.some(approval => approval.itemId === item.id && approval.status === 'Pending'));
    const needsInvoice = db.workflows.find(item => item.id === 'wf-invoice')?.active && db.invoices.some(invoice => invoice.status === 'Open' && invoice.dueDate < todayIso() && !db.invoiceReminders.some(reminder => reminder.invoiceId === invoice.id && reminder.status === 'Draft'));
    if (needsStock) autoTrigger(db, 'inventory', 'Automatic stock threshold check');
    if (needsInvoice) autoTrigger(db, 'invoice', 'Automatic overdue invoice check');
  });
}
function formatCurrency(amount, currency = 'INR') {
  try { return new Intl.NumberFormat('en-IN', { style: 'currency', currency, maximumFractionDigits: 2 }).format(amount); }
  catch { return `${currency} ${Number(amount).toFixed(2)}`; }
}
function initials(name) { return String(name).trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase(); }
function validateDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
function csvNumber(value, label, { integer = false, min = 0 } = {}) {
  const normalized = typeof value === 'string' ? value.replace(/[₹,$\s]/g, '') : value;
  const number = Number(normalized);
  if (!Number.isFinite(number) || number < min || (integer && !Number.isInteger(number))) {
    throw new Error(`${label} must be a valid ${integer ? 'whole number' : 'number'} of at least ${min}.`);
  }
  return number;
}
function normalizeCsvRows(entity, rows) {
  if (!['inventory', 'invoices'].includes(entity)) throw new Error('Choose inventory or invoices for this CSV.');
  if (!Array.isArray(rows) || rows.length === 0 || rows.length > 10000) throw new Error('CSV must contain between 1 and 10,000 data rows.');
  const rowKeys = new Set();
  const skuKeys = new Set();
  return rows.map((raw, index) => {
    const rowNumber = index + 2;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`Row ${rowNumber} is not a valid CSV record.`);
    if (entity === 'inventory') {
      const sku = String(raw.sku || '').trim().slice(0, 40);
      const externalId = String(raw.externalId || '').trim().slice(0, 100);
      const name = String(raw.name || '').trim().slice(0, 100);
      if (!name || (!sku && !externalId)) throw new Error(`Row ${rowNumber} needs a product name and SKU or external ID.`);
      const key = externalId ? `id:${externalId.toLowerCase()}` : `sku:${sku.toLowerCase()}`;
      if (rowKeys.has(key)) throw new Error(`Row ${rowNumber} repeats a product key.`);
      rowKeys.add(key);
      if (sku) {
        const normalizedSku = sku.toLowerCase();
        if (skuKeys.has(normalizedSku)) throw new Error(`Row ${rowNumber} repeats SKU ${sku}.`);
        skuKeys.add(normalizedSku);
      }
      const optionalNumber = (value, label) => value == null || String(value).trim() === '' ? null : csvNumber(value, `Row ${rowNumber} ${label}`);
      return {
        externalId, sku, name,
        category: raw.category == null ? null : String(raw.category).trim().slice(0, 60),
        onHand: csvNumber(raw.onHand, `Row ${rowNumber} on-hand stock`, { integer: true }),
        reorderLevel: raw.reorderLevel == null || String(raw.reorderLevel).trim() === '' ? 0 : csvNumber(raw.reorderLevel, `Row ${rowNumber} reorder point`, { integer: true }),
        unitCost: optionalNumber(raw.unitCost, `unit cost`),
        sellingPrice: optionalNumber(raw.sellingPrice, `selling price`),
        supplier: raw.supplier == null ? null : String(raw.supplier).trim().slice(0, 100)
      };
    }
    const externalId = String(raw.externalId || raw.invoiceNumber || '').trim().slice(0, 100);
    const invoiceNumber = String(raw.invoiceNumber || '').trim().slice(0, 100);
    const customer = String(raw.customer || '').trim().slice(0, 100);
    if (!externalId || !customer) throw new Error(`Row ${rowNumber} needs an invoice number or external ID and a customer.`);
    if (rowKeys.has(externalId.toLowerCase())) throw new Error(`Row ${rowNumber} repeats invoice ${externalId}.`);
    rowKeys.add(externalId.toLowerCase());
    const issueDate = String(raw.issueDate || '').trim();
    const dueDate = String(raw.dueDate || '').trim();
    const rawStatus = String(raw.status || 'Open').trim().toLowerCase();
    if (!['open', 'overdue', 'paid', 'untracked'].includes(rawStatus)) throw new Error(`Row ${rowNumber} status must be Open, Overdue, Paid, or Untracked.`);
    const untracked = rawStatus === 'untracked';
    if (!validateDate(issueDate) || (!untracked && !validateDate(dueDate)) || (dueDate && (!validateDate(dueDate) || dueDate < issueDate))) throw new Error(`Row ${rowNumber} needs a valid issue date; tracked invoices also need a due date on or after issue date.`);
    const currency = String(raw.currency || '').trim().toUpperCase();
    if (currency && !/^[A-Z]{3}$/.test(currency)) throw new Error(`Row ${rowNumber} currency must be a three-letter code such as GBP or INR.`);
    return { externalId, invoiceNumber, customer, amount: csvNumber(raw.amount, `Row ${rowNumber} amount`, { min: 0.01 }), issueDate, dueDate, status: rawStatus === 'paid' ? 'Paid' : untracked ? 'Untracked' : 'Open', currency };
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
      const db = readDb();
      return send(res, 200, { ...db, derived: calculateDerived(db), agentMode: process.env.OPENAI_API_KEY ? 'openai' : 'local-rules' });
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write(`event: connected\ndata: {}\n\n`);
      clients.add(res);
      const heartbeat = setInterval(() => res.write(': keep-alive\n\n'), 20000);
      res.on('close', () => { clearInterval(heartbeat); clients.delete(res); });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/agent/run') {
      const payload = await body(req);
      const command = String(payload.command || '').trim().slice(0, 240);
      if (!command) return send(res, 400, { error: 'Enter a workflow request first.' });
      let plan;
      try { plan = await chooseIntent(command, readDb()); }
      catch (error) {
        console.warn(`AI planner unavailable; local rules used: ${error.message}`);
        plan = { intent: findIntent(command), mode: 'local-fallback', rationale: 'AI planning was unavailable; local rules selected the workflow.' };
      }
      const result = await mutate(db => runAgent(db, command, plan));
      return send(res, 200, result);
    }
    if (req.method === 'POST' && url.pathname === '/api/import/csv') {
      const payload = await body(req);
      const entity = String(payload.entity || '');
      const records = normalizeCsvRows(entity, payload.records);
      const currencies = new Set(records.map(record => record.currency).filter(Boolean));
      if (currencies.size > 1) throw new Error('One CSV import can contain only one currency.');
      const importCurrency = currencies.values().next().value || '';
      const sourceName = path.basename(String(payload.sourceName || 'CSV file')).slice(0, 100);
      const mode = payload.mode === 'live' ? 'live' : 'manual';
      const result = await mutate(db => {
        if (entity === 'invoices' && importCurrency) {
          const hasExistingRecords = db.orders.length || db.inventory.length || db.invoices.length;
          if (hasExistingRecords && db.business.currency !== importCurrency) throw new Error(`This workspace uses ${db.business.currency}; this CSV uses ${importCurrency}. Import it into an empty workspace or convert it first.`);
          db.business.currency = importCurrency;
        }
        let created = 0;
        let updated = 0;
        if (entity === 'inventory') {
          for (const record of records) {
            let item = db.inventory.find(row => record.externalId && row.externalId === record.externalId)
              || db.inventory.find(row => record.sku && row.sku.toLowerCase() === record.sku.toLowerCase());
            const sku = record.sku || item?.sku || nextId(db, 'nextSku', 'SKU');
            if (db.inventory.some(row => row.sku.toLowerCase() === sku.toLowerCase() && row !== item)) throw new Error(`SKU ${sku} already belongs to another product.`);
            if (item) {
              if (record.onHand < item.reserved) throw new Error(`SKU ${sku} has ${item.reserved} units reserved; the CSV cannot reduce on-hand below that.`);
              const changes = record.name !== item.name || sku !== item.sku || record.onHand !== item.onHand || record.reorderLevel !== item.reorderLevel
                || (record.category !== null && record.category !== item.category) || (record.supplier !== null && record.supplier !== item.supplier)
                || (record.unitCost !== null && record.unitCost !== item.unitCost) || (record.sellingPrice !== null && record.sellingPrice !== item.sellingPrice)
                || (record.externalId && record.externalId !== item.externalId);
              if (!changes) continue;
              item.sku = sku; item.name = record.name; item.onHand = record.onHand; item.reorderLevel = record.reorderLevel;
              if (record.category !== null) item.category = record.category;
              if (record.supplier !== null) item.supplier = record.supplier;
              if (record.unitCost !== null) item.unitCost = record.unitCost;
              if (record.sellingPrice !== null) item.sellingPrice = record.sellingPrice;
              if (record.externalId) item.externalId = record.externalId;
              item.updatedAt = new Date().toISOString();
              updated++;
            } else {
              item = { id: crypto.randomUUID(), externalId: record.externalId || '', sku, name: record.name, category: record.category || '', onHand: record.onHand, reserved: 0, reorderLevel: record.reorderLevel, unitCost: record.unitCost ?? 0, sellingPrice: record.sellingPrice ?? 0, supplier: record.supplier || '', createdAt: new Date().toISOString() };
              db.inventory.unshift(item);
              created++;
            }
          }
          if (created || updated) {
            const low = db.inventory.some(item => item.onHand - item.reserved <= item.reorderLevel);
            if (low) autoTrigger(db, 'inventory', 'CSV inventory sync reached a reorder point');
          }
        } else {
          for (const record of records) {
            let invoice = db.invoices.find(row => row.externalId === record.externalId)
              || db.invoices.find(row => row.invoiceNumber === (record.invoiceNumber || record.externalId) || row.id === (record.invoiceNumber || record.externalId));
            if (invoice) {
              const invoiceNumber = record.invoiceNumber || record.externalId;
              const changes = invoice.customer !== record.customer || invoice.amount !== record.amount || invoice.issueDate !== record.issueDate
                || invoice.dueDate !== record.dueDate || invoice.status !== record.status || invoice.externalId !== record.externalId || invoice.invoiceNumber !== invoiceNumber;
              if (!changes) continue;
              invoice.customer = record.customer; invoice.amount = record.amount; invoice.issueDate = record.issueDate;
              invoice.dueDate = record.dueDate; invoice.status = record.status; invoice.externalId = record.externalId; invoice.invoiceNumber = invoiceNumber;
              if (record.status === 'Paid') {
                invoice.paidAt ||= new Date().toISOString();
                db.invoiceReminders.filter(reminder => reminder.invoiceId === invoice.id && reminder.status === 'Draft').forEach(reminder => { reminder.status = 'Closed · invoice paid'; });
              } else delete invoice.paidAt;
              invoice.updatedAt = new Date().toISOString();
              updated++;
            } else {
              const id = nextId(db, 'nextInvoice', 'INV');
              invoice = { id, invoiceNumber: record.invoiceNumber || record.externalId, externalId: record.externalId, customer: record.customer, amount: record.amount, issueDate: record.issueDate, dueDate: record.dueDate, status: record.status, createdAt: new Date().toISOString() };
              if (record.status === 'Paid') invoice.paidAt = invoice.createdAt;
              db.invoices.unshift(invoice);
              created++;
            }
          }
          if (created || updated) {
            const overdue = db.invoices.some(invoice => invoice.status === 'Open' && invoice.dueDate < todayIso());
            if (overdue) autoTrigger(db, 'invoice', 'CSV invoice sync found an overdue invoice');
          }
        }
        db.sync = { ...(db.sync || {}), lastSyncAt: new Date().toISOString(), lastSource: sourceName, entity, created, updated, mode };
        if (created || updated) addEvent(db, 'CSV sync', `${entity === 'inventory' ? 'Inventory' : 'Invoice'} records synced`, `${sourceName} · ${created} created · ${updated} updated`, 'Completed', 'activity', 'green');
        return { entity, sourceName, created, updated, unchanged: records.length - created - updated, lastSyncAt: db.sync.lastSyncAt };
      });
      return send(res, 200, result);
    }
    if (req.method === 'POST' && url.pathname === '/api/inventory') {
      const payload = await body(req);
      const name = String(payload.name || '').trim().slice(0, 100);
      const skuInput = String(payload.sku || '').trim().slice(0, 40);
      const stock = Number(payload.stock);
      const reorderLevel = Number(payload.reorderLevel);
      const unitCost = Number(payload.unitCost);
      const sellingPrice = Number(payload.sellingPrice);
      if (!name || !Number.isInteger(stock) || stock < 0 || !Number.isInteger(reorderLevel) || reorderLevel < 0 || !Number.isFinite(unitCost) || unitCost < 0 || !Number.isFinite(sellingPrice) || sellingPrice < 0) return send(res, 400, { error: 'Enter a product, whole-number stock/reorder level, and valid unit prices.' });
      const result = await mutate(db => {
        const sku = skuInput || nextId(db, 'nextSku', 'SKU');
        if (db.inventory.some(item => item.sku.toLowerCase() === sku.toLowerCase())) throw new Error('That SKU already exists.');
        const item = { id: crypto.randomUUID(), sku, name, category: String(payload.category || '').trim().slice(0, 60), onHand: stock, reserved: 0, reorderLevel, unitCost, sellingPrice, supplier: String(payload.supplier || '').trim().slice(0, 100), createdAt: new Date().toISOString() };
        db.inventory.unshift(item);
        addEvent(db, 'Inventory desk', 'Product created', `${item.sku} · ${item.name} · opening stock ${item.onHand}`, 'Completed', 'inventory', 'violet');
        if (item.onHand <= item.reorderLevel) autoTrigger(db, 'inventory', 'Automatic low-stock trigger');
        return item;
      });
      return send(res, 201, { item: result });
    }
    const inventoryMatch = url.pathname.match(/^\/api\/inventory\/([^/]+)\/adjust$/);
    if (req.method === 'POST' && inventoryMatch) {
      const payload = await body(req);
      const quantity = Number(payload.quantity);
      const reason = String(payload.reason || '').trim().slice(0, 120);
      if (!Number.isInteger(quantity) || quantity === 0 || !reason) return send(res, 400, { error: 'Enter a non-zero whole-number adjustment and a reason.' });
      const result = await mutate(db => {
        const item = db.inventory.find(row => row.id === decodeURIComponent(inventoryMatch[1]));
        if (!item) throw new Error('Product not found.');
        if (item.onHand + quantity < item.reserved) throw new Error('Adjustment cannot reduce stock below units reserved for open orders.');
        item.onHand += quantity;
        addEvent(db, 'Inventory desk', 'Stock adjusted', `${item.sku} · ${quantity > 0 ? '+' : ''}${quantity} · ${reason}`, 'Completed', 'inventory', 'violet');
        if (item.onHand - item.reserved <= item.reorderLevel) autoTrigger(db, 'inventory', 'Automatic stock adjustment trigger');
        return item;
      });
      return send(res, 200, { item: result });
    }
    if (req.method === 'POST' && url.pathname === '/api/orders') {
      const payload = await body(req);
      const customer = String(payload.customer || '').trim().slice(0, 100);
      const inventoryId = String(payload.inventoryId || '');
      const quantity = Number(payload.quantity);
      if (!customer || !inventoryId || !Number.isInteger(quantity) || quantity < 1) return send(res, 400, { error: 'Choose a customer, an inventory product, and a whole-number quantity.' });
      const result = await mutate(db => {
        const item = db.inventory.find(row => row.id === inventoryId);
        if (!item) throw new Error('Choose a product from the current inventory.');
        const available = item.onHand - item.reserved;
        if (quantity > available) throw new Error(`Only ${available} units are available.`);
        item.reserved += quantity;
        const order = { id: nextId(db, 'nextOrder', 'SO'), customer, initials: initials(customer), inventoryId: item.id, sku: item.sku, item: item.name, quantity, unitPrice: item.sellingPrice, amount: item.sellingPrice * quantity, status: 'Processing', priority: payload.priority === 'High' ? 'High' : 'Normal', createdAt: new Date().toISOString() };
        db.orders.unshift(order);
        addEvent(db, 'Order desk', 'Sales order created', `${order.id} · ${customer} · ${quantity} × ${item.name}; stock reserved`, 'Completed', 'orders', 'blue');
        if (item.onHand - item.reserved <= item.reorderLevel) autoTrigger(db, 'inventory', 'Automatic order reservation trigger');
        return order;
      });
      return send(res, 201, { order: result });
    }
    if (req.method === 'PATCH' && url.pathname.startsWith('/api/orders/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      const payload = await body(req);
      const result = await mutate(db => {
        const order = db.orders.find(item => item.id === id);
        if (!order) throw new Error('Order not found.');
        const nextStatus = payload.status;
        const allowed = (order.status === 'Processing' && ['Ready to ship', 'Cancelled'].includes(nextStatus)) || (order.status === 'Ready to ship' && ['Shipped', 'Cancelled'].includes(nextStatus));
        if (!allowed) throw new Error('That order status change is not allowed.');
        const item = db.inventory.find(row => row.id === order.inventoryId);
        if (nextStatus === 'Shipped' && item) { item.reserved -= order.quantity; item.onHand -= order.quantity; }
        else if (nextStatus === 'Cancelled' && item) item.reserved -= order.quantity;
        order.status = nextStatus;
        order.updatedAt = new Date().toISOString();
        addEvent(db, 'Order desk', `Order ${nextStatus.toLowerCase()}`, `${order.id} · ${order.customer}`, nextStatus, 'orders', 'blue');
        return order;
      });
      return send(res, 200, { order: result });
    }
    if (req.method === 'POST' && url.pathname === '/api/invoices') {
      const payload = await body(req);
      const customer = String(payload.customer || '').trim().slice(0, 100);
      const amount = Number(payload.amount);
      const issueDate = String(payload.issueDate || '');
      const dueDate = String(payload.dueDate || '');
      if (!customer || !Number.isFinite(amount) || amount <= 0 || !validateDate(issueDate) || !validateDate(dueDate) || dueDate < issueDate) return send(res, 400, { error: 'Enter a customer, positive amount, and valid due date on or after the issue date.' });
      const result = await mutate(db => {
        const id = nextId(db, 'nextInvoice', 'INV');
        const invoice = { id, invoiceNumber: id, customer, amount, issueDate, dueDate, status: 'Open', createdAt: new Date().toISOString() };
        db.invoices.unshift(invoice);
        addEvent(db, 'Finance desk', 'Invoice recorded', `${invoice.invoiceNumber} · ${customer} · ${formatCurrency(amount, db.business.currency)}`, 'Completed', 'receipt', 'amber');
        if (invoice.dueDate < todayIso()) autoTrigger(db, 'invoice', 'Automatic overdue invoice trigger');
        return invoice;
      });
      return send(res, 201, { invoice: result });
    }
    if (req.method === 'PATCH' && url.pathname.startsWith('/api/invoices/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop());
      const payload = await body(req);
      if (payload.status !== 'Paid') return send(res, 400, { error: 'Only marking an invoice paid is supported.' });
      const result = await mutate(db => {
        const invoice = db.invoices.find(item => item.id === id);
        if (!invoice) throw new Error('Invoice not found.');
        if (invoice.status !== 'Open') throw new Error('This invoice is already closed.');
        invoice.status = 'Paid'; invoice.paidAt = new Date().toISOString();
        db.invoiceReminders.filter(reminder => reminder.invoiceId === id && reminder.status === 'Draft').forEach(reminder => { reminder.status = 'Closed · invoice paid'; });
        addEvent(db, 'Finance desk', 'Invoice marked paid', `${invoice.invoiceNumber || invoice.id} · ${invoice.customer}`, 'Paid', 'receipt', 'amber');
        return invoice;
      });
      return send(res, 200, { invoice: result });
    }
    const approvalMatch = url.pathname.match(/^\/api\/approvals\/([^/]+)$/);
    if (req.method === 'POST' && approvalMatch) {
      const payload = await body(req);
      if (!['approve', 'reject', 'receive'].includes(payload.decision)) return send(res, 400, { error: 'Decision must be approve, reject, or receive.' });
      const id = decodeURIComponent(approvalMatch[1]);
      const result = await mutate(db => {
        const approval = db.approvals.find(item => item.id === id);
        if (!approval) throw new Error('Purchase request not found.');
        if (payload.decision === 'receive') {
          if (approval.status !== 'Approved') throw new Error('Approve the purchase request before receiving goods.');
          const item = db.inventory.find(row => row.id === approval.itemId);
          if (!item) throw new Error('The inventory item no longer exists.');
          item.onHand += approval.quantity;
          approval.status = 'Received'; approval.receivedAt = new Date().toISOString();
          addEvent(db, 'Inventory desk', 'Purchase received', `${approval.id} · ${item.name} · +${approval.quantity} units`, 'Received', 'inventory', 'violet');
        } else {
          if (approval.status !== 'Pending') throw new Error('This request has already been reviewed.');
          approval.status = payload.decision === 'approve' ? 'Approved' : 'Rejected';
          approval.reviewedAt = new Date().toISOString();
          addEvent(db, 'Approval desk', `Purchase request ${approval.status.toLowerCase()}`, `${approval.id} · ${approval.title}`, approval.status, 'inventory', 'violet');
        }
        return approval;
      });
      return send(res, 200, { approval: result });
    }
    const workflowMatch = url.pathname.match(/^\/api\/workflows\/([^/]+)$/);
    if (req.method === 'PATCH' && workflowMatch) {
      const payload = await body(req);
      const result = await mutate(db => {
        const workflow = db.workflows.find(item => item.id === decodeURIComponent(workflowMatch[1]));
        if (!workflow) throw new Error('Workflow not found.');
        workflow.active = Boolean(payload.active);
        addEvent(db, 'Workflow manager', `${workflow.name} ${workflow.active ? 'enabled' : 'paused'}`, 'Workflow setting changed by a workspace user', workflow.active ? 'Active' : 'Paused', workflow.icon, workflow.color);
        return workflow;
      });
      return send(res, 200, { workflow: result });
    }
    if (req.method === 'PATCH' && url.pathname === '/api/business') {
      const payload = await body(req);
      const name = String(payload.name || '').trim().slice(0, 100);
      if (!name) return send(res, 400, { error: 'Enter your business or workspace name.' });
      const result = await mutate(db => {
        db.business.name = name;
        addEvent(db, 'Workspace settings', 'Business name updated', name, 'Completed', 'grid', 'green');
        return db.business;
      });
      return send(res, 200, { business: result });
    }
    if (req.method === 'GET' && url.pathname === '/api/export') {
      const json = JSON.stringify(readDb(), null, 2);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Disposition': 'attachment; filename="erp-backup.json"', 'Cache-Control': 'no-store' });
      return res.end(json);
    }
    if (req.method === 'GET' && url.pathname === '/download/online-retail-uci.csv') {
      const file = path.join(PUBLIC, 'datasets', 'online-retail-uci.csv');
      if (!fs.existsSync(file)) return send(res, 404, 'Dataset not found', 'text/plain; charset=utf-8');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="online-retail-uci.csv"',
        'Content-Length': fs.statSync(file).size,
        'Cache-Control': 'no-store'
      });
      return fs.createReadStream(file).pipe(res);
    }
    if (req.method === 'GET' && url.pathname === '/download/uci-retail-invoices-5000.csv') {
      const file = path.join(PUBLIC, 'datasets', 'uci-retail-invoices-5000.csv');
      if (!fs.existsSync(file)) return send(res, 404, 'Dataset not found', 'text/plain; charset=utf-8');
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="uci-retail-invoices-5000.csv"',
        'Content-Length': fs.statSync(file).size,
        'Cache-Control': 'no-store'
      });
      return fs.createReadStream(file).pipe(res);
    }
    if (req.method === 'GET') {
      const requested = url.pathname === '/' ? '/index.html' : decodeURIComponent(url.pathname);
      const file = path.resolve(PUBLIC, `.${requested}`);
      if (!file.startsWith(`${PUBLIC}${path.sep}`) && file !== path.join(PUBLIC, 'index.html')) return send(res, 403, { error: 'Forbidden.' });
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, 'Not found', 'text/plain; charset=utf-8');
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
      return res.end(fs.readFileSync(file));
    }
    return send(res, 404, { error: 'Route not found.' });
  } catch (error) {
    const status = /not found/i.test(error.message) ? 404 : /already|not allowed|cannot|only /i.test(error.message) ? 409 : /enter |choose |valid |whole-number|positive/i.test(error.message) ? 400 : 500;
    if (status === 500) console.error(error);
    return send(res, status, { error: error.message || 'The request could not be completed.' });
  }
});

readDb();
server.listen(PORT, HOST, () => console.log(`Astra ERP is running at http://${HOST}:${PORT}`));
const automationTimer = setInterval(() => runBackgroundAutomation().catch(error => console.error('Background workflow error:', error)), 60000);
automationTimer.unref();
setTimeout(() => runBackgroundAutomation().catch(error => console.error('Startup workflow error:', error)), 250);

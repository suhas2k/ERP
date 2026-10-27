const initialView = new URLSearchParams(window.location.search).get('view');
const state = { db: null, view: initialView === 'sync' ? 'sync' : 'overview', command: '', busy: false, result: null, syncTimer: null, csvLive: { handle: null, timer: null, entity: 'inventory', fileName: '', fingerprint: '', busy: false, message: '' } };
const viewRoot = document.querySelector('#view');

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}
const iconPaths = {
  grid: '<rect x="4" y="4" width="6" height="6" rx="1"/><rect x="14" y="4" width="6" height="6" rx="1"/><rect x="4" y="14" width="6" height="6" rx="1"/><rect x="14" y="14" width="6" height="6" rx="1"/>',
  orders: '<path d="M4 5h16M4 12h16M4 19h16"/><circle cx="7" cy="5" r="1"/><circle cx="7" cy="12" r="1"/><circle cx="7" cy="19" r="1"/>',
  inventory: '<path d="m12 3 8 4.5v9L12 21l-8-4.5v-9L12 3Z"/><path d="m4.5 7.8 7.5 4.3 7.5-4.3M12 12v9"/>',
  receipt: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3Z"/><path d="M9 8h6M9 12h6M9 16h3"/>',
  workflow: '<rect x="3" y="4" width="7" height="6" rx="2"/><rect x="14" y="14" width="7" height="6" rx="2"/><path d="M10 7h3a2 2 0 0 1 2 2v5M14 17h-3a2 2 0 0 1-2-2v-5"/>',
  checklist: '<path d="m4 7 2 2 4-4M4 17l2 2 4-4M12 7h8M12 17h8"/>',
  activity: '<path d="M3 12h4l3-8 4 16 3-8h4"/>',
  spark: '<path d="m12 3 1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7L12 3Z"/><path d="m19 15 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  chevron: '<path d="m9 18 6-6-6-6"/>',
  box: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="M3 8v8l9 5 9-5V8M12 13v8"/>',
  users: '<path d="M16 21v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2M9.5 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM20 8a3 3 0 0 1-2 2.8M21 21v-2a4 4 0 0 0-3-3.9"/>',
  calendar: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M16 3v4M8 3v4M3 10h18"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  x: '<path d="m18 6-12 12M6 6l12 12"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 1 1 4.3 1.7c-1.1 1.1-1.8 1.3-1.8 3M12 17h.01"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4"/>',
  theme: '<path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>'
};
function icon(name, size = 18) {
  return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (iconPaths[name] || iconPaths.spark) + '</svg>';
}
function currency(amount) {
  const code = state.db?.business?.currency || 'INR';
  try { return new Intl.NumberFormat('en-IN', { style: 'currency', currency: code, maximumFractionDigits: 2 }).format(Number(amount) || 0); }
  catch { return code + ' ' + (Number(amount) || 0).toFixed(2); }
}
function dateText(value) {
  if (!value) return '—';
  const date = new Date(value.length === 10 ? value + 'T12:00:00' : value);
  return Number.isNaN(date.getTime()) ? esc(value) : date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
}
function timeText(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function statusClass(status) {
  const value = String(status || '').toLowerCase();
  if (value.includes('overdue') || value.includes('cancel') || value.includes('reject') || value.includes('declin')) return 'rejected';
  if (value === 'untracked') return 'untracked';
  if (value.includes('ready')) return 'ready';
  if (value.includes('ship')) return 'shipped';
  if (value.includes('process')) return 'processing';
  if (value.includes('pending') || value === 'open') return 'pending';
  if (value.includes('approv')) return 'approved';
  return 'completed';
}
function pill(status) { return '<span class="status-pill status-' + statusClass(status) + '">' + esc(status) + '</span>'; }
function actionButton(label, action, iconName, attributes = '') {
  return '<button class="primary-button" data-action="' + esc(action) + '" ' + attributes + '>' + icon(iconName, 14) + esc(label) + '</button>';
}
function pageHeading(title, description, actions = '') {
  return '<div class="page-heading"><div><div class="eyebrow">ASTRA OPERATIONS</div><h1>' + esc(title) + '</h1><p>' + esc(description) + '</p></div>' + (actions ? '<div class="heading-actions">' + actions + '</div>' : '') + '</div>';
}
function metricCard(label, value, foot, iconName, color) {
  return '<article class="metric-card"><div class="metric-head"><span>' + esc(label) + '</span><span class="metric-icon ' + esc(color) + '">' + icon(iconName, 16) + '</span></div><div class="metric-value">' + esc(value) + '</div><div class="metric-foot">' + esc(foot) + '</div></article>';
}
function activityIcon(item) {
  return '<span class="activity-icon ' + esc(item.color || 'green') + '">' + icon(item.icon || 'activity') + '</span>';
}
function activityFeed(items, limit) {
  if (!items.length) return '<div class="empty-state">No activity has been recorded yet.</div>';
  return '<div class="activity-list">' + items.slice(0, limit).map(item => '<div class="activity-item">' + activityIcon(item) + '<div class="activity-main"><strong>' + esc(item.title) + '</strong><p>' + esc(item.description) + '</p></div><span class="activity-time">' + esc(timeText(item.createdAt)) + '</span></div>').join('') + '</div>';
}
function commandCard() {
  const result = state.result;
  const resultMarkup = result ? '<div class="agent-result"><span class="result-icon">' + icon(result.paused ? 'clock' : 'check') + '</span><div><strong>' + esc(result.summary) + '</strong><p class="agent-rationale">' + esc(result.rationale || ('Planner: ' + result.agentMode)) + '</p>' + (result.toolCalls?.length ? '<div class="tool-chips">' + result.toolCalls.map(tool => '<span class="tool-chip">' + esc(tool) + '</span>').join('') + '</div>' : '') + '</div></div>' : '';
  return '<section class="command-card"><div class="command-top"><span class="command-spark">' + icon('spark') + '</span><strong class="command-heading">Run a workflow on your records</strong><span class="command-caption">Uses saved data only</span><span class="demo-badge">' + (state.db.agentMode === 'openai' ? 'AI PLANNER' : 'LOCAL RULES') + '</span></div><form id="agentForm"><div class="command-row"><label class="command-input-wrap"><input id="agentCommand" aria-label="Describe a workflow task" name="command" class="command-input" maxlength="240" placeholder="e.g. Check stock and prepare purchase requests" value="' + esc(state.command) + '" required></label><button class="primary-button run-button" type="submit" ' + (state.busy ? 'disabled' : '') + '>' + icon('spark', 14) + (state.busy ? 'Running…' : 'Run workflow') + '</button></div></form><div class="command-suggestions"><span class="suggestion-label">Try</span><button class="suggestion-chip" data-command="Check inventory and prepare purchase requests">Check stock</button><button class="suggestion-chip" data-command="Find overdue invoices and draft reminders">Find overdue invoices</button><button class="suggestion-chip" data-command="Prioritise open orders">Prioritise orders</button></div>' + resultMarkup + '</section>';
}
async function api(url, options = {}) {
  const headers = new Headers(options.headers || {});
  if (options.body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  const response = await fetch(url, { ...options, headers, cache: 'no-store' });
  const contentType = response.headers.get('content-type') || '';
  const payload = contentType.includes('application/json') ? await response.json() : await response.text();
  if (!response.ok) throw new Error(payload?.error || ('Request failed (' + response.status + ').'));
  return payload;
}
async function refresh() {
  const db = await api('/api/bootstrap');
  state.db = db;
  const name = db.business.name || 'Your workspace';
  const businessName = document.querySelector('#businessName');
  if (businessName) businessName.textContent = name;
  const initials = name === 'Your workspace' ? 'W' : (name.trim().split(/\s+/).slice(0, 2).map(part => part[0] || '').join('').toUpperCase() || 'W');
  document.querySelectorAll('.workspace-avatar,.profile-avatar,.top-avatar').forEach(node => { node.textContent = initials; });
  document.querySelector('#navOrders').textContent = db.orders.length;
  document.querySelector('#navInventory').textContent = db.inventory.length;
  document.querySelector('#navInvoices').textContent = db.invoices.length;
  document.querySelector('#navWorkflows').textContent = db.workflows.reduce((total, item) => total + item.runs, 0);
  document.querySelector('#sidebarPending').textContent = db.approvals.filter(item => item.status === 'Pending').length;
  document.querySelectorAll('[data-icon]').forEach(node => { node.innerHTML = icon(node.dataset.icon, 16); });
  document.querySelectorAll('.nav-item[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === state.view));
  const labels = { overview: 'Overview', orders: 'Orders', inventory: 'Inventory', invoices: 'Invoices', workflows: 'Workflows', approvals: 'Approvals', sync: 'Live data sync', activity: 'Activity log' };
  document.querySelector('#breadcrumbCurrent').textContent = labels[state.view] || 'Overview';
  render();
  return db;
}
function setView(view) {
  const allowed = ['overview', 'orders', 'inventory', 'invoices', 'workflows', 'approvals', 'sync', 'activity'];
  state.view = allowed.includes(view) ? view : 'overview';
  document.querySelectorAll('.nav-item[data-view]').forEach(button => button.classList.toggle('active', button.dataset.view === state.view));
  const labels = { overview: 'Overview', orders: 'Orders', inventory: 'Inventory', invoices: 'Invoices', workflows: 'Workflows', approvals: 'Approvals', sync: 'Live data sync', activity: 'Activity log' };
  document.querySelector('#breadcrumbCurrent').textContent = labels[state.view];
  document.querySelector('#sidebar').classList.remove('open');
  document.querySelector('#mobileScrim').classList.remove('visible');
  render();
}
function toast(message, error = false) {
  const region = document.querySelector('#toastRegion');
  const node = document.createElement('div');
  node.className = 'toast' + (error ? ' error' : '');
  node.textContent = message;
  region.append(node);
  setTimeout(() => node.remove(), 3600);
}
function setCsvMessage(message, error = false) {
  state.csvLive.message = message;
  if (state.view === 'sync') render();
  if (error) toast(message, true);
}
async function importCsvFile(file, mode = 'manual', entity = document.querySelector('#csvEntity')?.value || 'inventory') {
  if (!file) return;
  try {
    if (file.size > 4_000_000) throw new Error('CSV is larger than 4 MB. Split it into smaller files and import each one.');
    const csvText = await file.text();
    const detected = AstraCsvSync.detect(csvText);
    if (detected === 'ambiguous') throw new Error('CSV headers match both Inventory and Invoices. Keep only the columns for one import type, then retry.');
    if (detected) entity = detected;
    state.csvLive.entity = entity;
    const selector = document.querySelector('#csvEntity');
    if (selector) selector.value = entity;
    const records = AstraCsvSync.parse(csvText, entity);
    const result = await api('/api/import/csv', { method: 'POST', body: JSON.stringify({ entity, records, sourceName: file.name, mode }) });
    setCsvMessage(`${result.created} new · ${result.updated} updated · ${result.unchanged} unchanged (${result.sourceName})`);
    await refresh();
    if (result.created || result.updated) toast(`CSV sync saved: ${result.created} new and ${result.updated} updated.`);
    else toast('CSV checked. No saved records changed.');
  } catch (error) {
    setCsvMessage(error.message, true);
  }
}
async function pollLiveCsv() {
  const live = state.csvLive;
  if (!live.handle || live.busy) return;
  live.busy = true;
  try {
    const permission = await live.handle.queryPermission({ mode: 'read' });
    if (permission !== 'granted') {
      clearInterval(live.timer); live.timer = null; live.handle = null;
      throw new Error('File read permission ended. Connect the CSV again to continue live sync.');
    }
    const file = await live.handle.getFile();
    const fingerprint = `${file.lastModified}:${file.size}`;
    if (fingerprint === live.fingerprint) return;
    if (file.size > 4_000_000) throw new Error('CSV is larger than 4 MB. Use a smaller compatible CSV; the full UCI source is an analysis file, not an inventory or invoice import.');
    const csvText = await file.text();
    const detected = AstraCsvSync.detect(csvText);
    if (detected === 'ambiguous') throw new Error('CSV headers match both Inventory and Invoices. Keep only the columns for one import type, then retry.');
    if (detected) live.entity = detected;
    const selector = document.querySelector('#csvEntity');
    if (selector) selector.value = live.entity;
    const records = AstraCsvSync.parse(csvText, live.entity);
    const result = await api('/api/import/csv', { method: 'POST', body: JSON.stringify({ entity: live.entity, records, sourceName: file.name, mode: 'live' }) });
    live.fingerprint = fingerprint;
    const message = `Watching ${file.name} · ${result.created} new · ${result.updated} updated · checks every 3 seconds`;
    const changed = result.created || result.updated;
    live.message = message;
    if (state.view === 'sync') render();
    if (changed) toast(`Live file update saved: ${result.created} new and ${result.updated} updated.`);
    await refresh();
  } catch (error) {
    if (live.message !== error.message) toast(error.message, true);
    live.message = error.message;
    if (state.view === 'sync') render();
  } finally { live.busy = false; }
}
async function startLiveCsv() {
  if (!window.showOpenFilePicker) {
    setCsvMessage('Live file watching is unavailable in this browser. Use Import once, or open localhost in Chrome or Edge.', true);
    return;
  }
  try {
    const [handle] = await window.showOpenFilePicker({ multiple: false, types: [{ description: 'CSV file', accept: { 'text/csv': ['.csv'] } }] });
    const permission = await handle.requestPermission({ mode: 'read' });
    if (permission !== 'granted') throw new Error('Read access was not granted for the selected CSV.');
    clearInterval(state.csvLive.timer);
    state.csvLive.handle = handle;
    state.csvLive.entity = document.querySelector('#csvEntity')?.value || 'inventory';
    state.csvLive.fileName = handle.name;
    state.csvLive.fingerprint = '';
    state.csvLive.message = 'Connecting to ' + handle.name + '…';
    render();
    await pollLiveCsv();
    if (state.csvLive.handle) state.csvLive.timer = setInterval(() => pollLiveCsv(), 3000);
  } catch (error) {
    if (error.name === 'AbortError') return;
    setCsvMessage(error.message || 'Could not connect to that CSV file.', true);
  }
}
function stopLiveCsv() {
  clearInterval(state.csvLive.timer);
  state.csvLive.timer = null; state.csvLive.handle = null; state.csvLive.fingerprint = '';
  setCsvMessage('Live sync stopped. Your saved records remain in this workspace.');
}

function orderRows(orders, actions) {
  if (!orders.length) return '<tr><td colspan="7"><div class="empty-inline">No orders recorded yet.</div></td></tr>';
  return orders.map(order => {
    const next = order.status === 'Processing' ? 'Ready to ship' : order.status === 'Ready to ship' ? 'Shipped' : '';
    const action = actions && next ? '<button class="soft-link" data-order-id="' + esc(order.id) + '" data-status="' + esc(next) + '">' + (next === 'Shipped' ? 'Ship ' : 'Advance ') + icon('chevron', 10) + '</button>' : '';
    return '<tr><td><span class="order-id">' + esc(order.id) + '</span></td><td><div class="customer-cell"><span class="customer-avatar">' + esc(order.initials || '•') + '</span><span><span class="customer-name">' + esc(order.customer) + '</span><div class="customer-product">' + esc(order.quantity + ' × ' + order.item) + '</div></span></div></td><td>' + currency(order.amount) + '</td><td>' + pill(order.status) + '</td><td><span class="priority-' + (order.priority === 'High' ? 'high' : 'normal') + '">' + esc(order.priority) + '</span></td><td>' + new Date(order.createdAt).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) + '</td><td>' + action + '</td></tr>';
  }).join('');
}
function ordersTable(orders, actions) {
  return '<div class="table-scroll"><table class="data-table"><thead><tr><th>Order</th><th>Customer & product</th><th>Order value</th><th>Status</th><th>Priority</th><th>Created</th><th></th></tr></thead><tbody>' + orderRows(orders, actions) + '</tbody></table></div>';
}
function revenueChart(months) {
  const values = months.map(item => item.value);
  const maximum = Math.max(1, ...values);
  const points = values.map((value, index) => ({ x: 48 + index * 114.4, y: 130 - (value / maximum) * 105 }));
  const hasValues = values.some(value => value > 0);
  let graph = '';
  if (hasValues) {
    const line = points.map((point, index) => (index ? 'L' : 'M') + point.x.toFixed(1) + ' ' + point.y.toFixed(1)).join(' ');
    const area = line + ' L ' + points[points.length - 1].x.toFixed(1) + ' 133 L ' + points[0].x.toFixed(1) + ' 133 Z';
    graph = '<path class="chart-area" d="' + area + '"/><path class="chart-line" d="' + line + '"/>' + points.map((point, index) => values[index] > 0 ? '<circle class="chart-dot" cx="' + point.x.toFixed(1) + '" cy="' + point.y.toFixed(1) + '" r="3.5"/>' : '').join('');
  }
  return '<div class="chart-wrap"><svg viewBox="0 0 640 170" preserveAspectRatio="none" role="img" aria-label="Order value for the last six months"><defs><linearGradient id="revenueFill" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#78ba91" stop-opacity=".18"/><stop offset="1" stop-color="#78ba91" stop-opacity=".01"/></linearGradient></defs>' +
    '<line class="chart-gridline" x1="43" y1="16" x2="628" y2="16"/><line class="chart-gridline" x1="43" y1="55" x2="628" y2="55"/><line class="chart-gridline" x1="43" y1="94" x2="628" y2="94"/><line class="chart-gridline" x1="43" y1="133" x2="628" y2="133"/>' +
    '<text class="chart-label" x="0" y="19">' + esc(currency(maximum)) + '</text><text class="chart-label" x="0" y="58">' + esc(currency(maximum * .66)) + '</text><text class="chart-label" x="0" y="97">' + esc(currency(maximum * .33)) + '</text><text class="chart-label" x="12" y="136">0</text>' +
    graph + months.map((month, index) => '<text class="chart-label" x="' + (points[index].x - 9).toFixed(1) + '" y="157">' + esc(month.label.toUpperCase()) + '</text>').join('') + '</svg>' +
    (!hasValues ? '<div class="chart-empty">Add orders to see your real monthly order value.</div>' : '') + '</div>';
}
function dashboard() {
  const db = state.db;
  const metrics = db.derived.metrics;
  const lowItems = db.inventory.filter(item => item.onHand - item.reserved <= item.reorderLevel);
  const overdue = db.derived.invoices.filter(item => item.status === 'Overdue');
  const pending = db.approvals.filter(item => item.status === 'Pending').length;
  const monthName = new Date(db.derived.today + 'T12:00:00').toLocaleDateString('en-IN', { month: 'long' });
  let brief = 'No exceptions found in the saved records.';
  let briefDetail = 'Add products, orders, and invoices to calculate operational alerts.';
  if (lowItems.length || overdue.length || pending) {
    const parts = [];
    if (lowItems.length) parts.push(lowItems.length + ' products at or below reorder point');
    if (overdue.length) parts.push(overdue.length + ' overdue invoices');
    if (pending) parts.push(pending + ' purchase requests awaiting approval');
    brief = parts.join(' · ');
    briefDetail = 'Based on records saved in this workspace. Review each item before taking action.';
  }
  const setup = !db.inventory.length ? '<section class="panel setup-panel"><div class="setup-icon">' + icon('spark') + '</div><div><h2>Start with your actual records</h2><p>This workspace has no sample companies, products, or transactions. Add your own inventory to begin.</p></div><div class="setup-actions">' + actionButton('Add product', 'add-product', 'plus') + '<button class="secondary-button" data-action="set-business">Set business name</button></div></section>' : '';
  return pageHeading('Operations overview', 'Live figures from your saved workspace records.', '<div class="date-control">' + icon('calendar') + dateText(db.derived.today) + '</div>') +
    commandCard() + setup +
    '<div class="metrics-grid">' +
      metricCard('Order value · ' + monthName, currency(metrics.monthOrderValue), 'Saved non-cancelled orders', 'receipt', 'green') +
      metricCard('Open orders', String(metrics.openOrders), 'Processing or ready to ship', 'orders', 'blue') +
      metricCard('Low-stock products', String(metrics.lowStock), 'At or below reorder point', 'inventory', 'amber') +
      metricCard('Overdue invoices', String(metrics.overdueInvoices), 'Open and past due date', 'clock', 'violet') +
    '</div>' +
    '<div class="chart-grid"><section class="panel"><div class="revenue-head"><div><div class="panel-heading" style="margin-bottom:4px"><div><h2>Order value by month</h2><p>Calculated from your saved sales orders</p></div></div><div class="revenue-total">' + currency(metrics.monthOrderValue) + '</div><div class="revenue-sub">' + db.orders.length + ' orders recorded · last six months</div></div><span class="demo-badge">LIVE RECORDS</span></div>' + revenueChart(db.derived.months) + '<div class="chart-legend"><span><i class="legend-dot"></i>Sales order value</span><span>' + esc(db.business.currency || 'INR') + ' · monthly</span></div></section>' +
    '<section class="panel insight-panel"><div class="insight-label">' + icon('spark') + ' CURRENT WORK QUEUE</div><div class="insight-content"><strong>' + esc(brief) + '</strong><p>' + esc(briefDetail) + '</p></div><div class="insight-kpis"><div class="insight-kpi"><small>Purchase requests</small><b>' + pending + ' awaiting review</b></div><div class="insight-kpi"><small>Workflow runs</small><b>' + metrics.workflowRuns + ' recorded</b></div></div><button class="insight-link" data-view="' + (pending ? 'approvals' : 'inventory') + '">' + (pending ? 'Review purchase requests ' : 'Review inventory ') + icon('arrow', 12) + '</button></section></div>' +
    '<div class="lower-grid"><section class="panel orders-panel"><div class="panel-heading"><div class="table-title"><h2>Recent orders</h2><span class="tiny-count">' + db.orders.length + ' total</span></div><button class="view-all" data-view="orders">View orders ' + icon('arrow', 12) + '</button></div>' + ordersTable(db.orders.slice(0, 5), false) + '</section><section class="panel activity-panel"><div class="panel-heading"><div><h2>Recent activity</h2><p>Saved actions, newest first</p></div><button class="view-all" data-view="activity">See all</button></div>' + activityFeed(db.activity, 5) + '</section></div>';
}
function ordersView() {
  const db = state.db;
  const noProducts = db.inventory.length === 0;
  return pageHeading('Orders', 'Create orders against inventory and track stock reservation through shipment.', actionButton('New order', 'new-order', 'plus', noProducts ? 'disabled title="Add inventory before creating orders"' : '')) +
    (noProducts ? '<div class="subtle-banner"><strong>First step:</strong> add your actual products in Inventory. Sales orders reserve their selected quantities.</div>' : '') +
    '<section class="panel orders-panel"><div class="panel-heading"><div><h2>Sales orders</h2><p>Only orders entered into this workspace appear here.</p></div><span class="tiny-count">' + db.orders.length + ' records</span></div>' + ordersTable(db.orders, true) + '</section>';
}
function inventoryView() {
  const db = state.db;
  const low = db.inventory.filter(item => item.onHand - item.reserved <= item.reorderLevel).length;
  const rows = db.inventory.map(item => {
    const available = item.onHand - item.reserved;
    const percent = Math.min(100, Math.round(item.onHand / Math.max(1, item.reorderLevel * 2.5) * 100));
    const lowState = available <= item.reorderLevel;
    return '<tr><td><span class="order-id">' + esc(item.sku) + '</span></td><td><div class="customer-name">' + esc(item.name) + '</div><div class="customer-product">' + esc(item.category || '—') + '</div></td><td>' + item.onHand + '</td><td>' + item.reserved + '</td><td><div class="inventory-stock"><b>' + available + '</b><span class="stock-track"><span class="stock-fill ' + (lowState ? 'low' : '') + '" style="width:' + percent + '%"></span></span></div></td><td>' + item.reorderLevel + '</td><td>' + (item.supplier ? esc(item.supplier) : '—') + '</td><td>' + (lowState ? '<span class="low-stock-label">Reorder</span>' : pill('In stock')) + '</td><td><button class="soft-link" data-adjust-id="' + esc(item.id) + '">Adjust</button></td></tr>';
  }).join('');
  const empty = '<div class="empty-state">No products recorded. Add your actual product and opening stock to start.</div>';
  return pageHeading('Inventory', 'On-hand, reserved, and available quantities update as you work.', actionButton('Add product', 'add-product', 'plus')) +
    '<div class="metrics-grid">' + metricCard('Products', db.inventory.length, 'Saved inventory records', 'box', 'blue') + metricCard('Low stock', low, 'At or below reorder point', 'inventory', 'amber') + metricCard('Units reserved', db.inventory.reduce((n, item) => n + item.reserved, 0), 'For open sales orders', 'orders', 'violet') + metricCard('Purchase requests', db.approvals.filter(a => a.status === 'Pending').length, 'Awaiting review', 'checklist', 'green') + '</div>' +
    '<section class="panel orders-panel"><div class="panel-heading"><div><h2>Products and stock</h2><p>Available = on-hand stock minus units reserved for open orders.</p></div><span class="tiny-count">' + db.inventory.length + ' products</span></div>' +
    (db.inventory.length ? '<div class="table-scroll"><table class="data-table inventory-table"><thead><tr><th>SKU</th><th>Product</th><th>On hand</th><th>Reserved</th><th>Available</th><th>Reorder at</th><th>Supplier</th><th>Status</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' : empty) + '</section>';
}
function csvSyncView() {
  const saved = state.db.sync || {};
  const live = Boolean(state.csvLive.handle);
  const entity = live ? state.csvLive.entity : (document.querySelector('#csvEntity')?.value || state.csvLive.entity || 'inventory');
  const lastSync = saved.lastSyncAt ? dateText(saved.lastSyncAt.slice(0, 10)) + ' · ' + new Date(saved.lastSyncAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : 'No sync yet';
  const status = live ? 'Watching ' + state.csvLive.fileName + ' · checks every 3 seconds' : 'No live file connected';
  const liveAction = live
    ? '<button class="secondary-button" data-action="disconnect-live-csv">' + icon('x', 14) + 'Stop live sync</button>'
    : '<button class="primary-button" data-action="connect-live-csv">' + icon('activity', 14) + 'Connect live CSV</button>';
  return pageHeading('Live data sync', 'Connect a real CSV export and keep this workspace updated while the file is saved.', '') +
    '<div class="subtle-banner"><strong>Real records only:</strong> imported rows are saved into this workspace, and changes are sent to every open app tab immediately. This does not connect to a company ERP by itself.</div>' +
    '<section class="panel"><div class="panel-heading"><div><h2>Connect a CSV file</h2><p>For an Excel workbook, use Save As → CSV UTF-8 first.</p></div><span class="demo-badge">' + (live ? 'LIVE FILE' : 'LOCAL FILE') + '</span></div>' +
    '<div class="form-row"><label class="form-field">CSV contains<select id="csvEntity" ' + (live ? 'disabled' : '') + '><option value="inventory" ' + (entity === 'inventory' ? 'selected' : '') + '>Inventory products</option><option value="invoices" ' + (entity === 'invoices' ? 'selected' : '') + '>Invoices</option></select></label><div class="form-field"><span>Connection</span><div class="form-note" role="status">' + esc(state.csvLive.message || status) + '</div></div></div>' +
    '<div class="page-title-actions">' + liveAction + '<button class="secondary-button" data-action="import-csv">Import once</button></div>' +
    '<input id="csvFileInput" type="file" accept=".csv,text/csv" hidden>' +
    '<div class="section-spacer"></div><div class="insight-kpis"><div class="insight-kpi"><small>Last saved sync</small><b>' + esc(lastSync) + '</b></div><div class="insight-kpi"><small>Last file</small><b>' + esc(saved.lastSource || '—') + '</b></div><div class="insight-kpi"><small>Last import result</small><b>' + (saved.created || 0) + ' new · ' + (saved.updated || 0) + ' updated</b></div></div></section>' +
    '<div class="section-spacer"></div><section class="panel"><div class="panel-heading"><div><h2>Prepare your CSV columns</h2><p>Templates contain headers only; fill them with your own saved records.</p></div></div>' +
    '<div class="activity-list"><div class="activity-item"><div class="activity-main"><strong>Inventory template</strong><p>SKU, product name, on-hand quantity, reorder point, cost, selling price, supplier</p></div><a class="mini-button" href="/templates/inventory-template.csv" download>Download blank template</a></div><div class="activity-item"><div class="activity-main"><strong>Invoice template</strong><p>Invoice number, customer, amount, issue date, due date, status, optional currency</p></div><a class="mini-button" href="/templates/invoices-template.csv" download>Download blank template</a></div><div class="activity-item"><div class="activity-main"><strong>UCI historical invoice sample</strong><p>5,000 real invoice summaries, GBP, under 4 MB. Missing payment status and due dates remain Untracked and blank. Choose Invoices to import.</p></div><a class="mini-button" href="/download/uci-retail-invoices-5000.csv">Download import-ready CSV</a></div><div class="activity-item"><div class="activity-main"><strong>Full UCI transaction source</strong><p>541,909 original historical line items, 47 MB. Kept unchanged for analysis; too large and in a different format for this importer.</p></div><a class="mini-button" href="/download/online-retail-uci.csv">Download full source</a></div></div>' +
    '<p class="form-note">Live sync reads the chosen CSV every 3 seconds while this browser tab stays open. Saving the file in Excel triggers an import; other open ERP tabs refresh immediately. Rows are matched by external ID or SKU/invoice number. Imports add and update rows; they never delete records.</p></section>';
}
function invoicesView() {
  const db = state.db;
  const invoices = db.derived.invoices;
  const rows = invoices.map(invoice => {
    const action = invoice.status === 'Open' || invoice.status === 'Overdue' ? '<button class="soft-link" data-invoice-paid="' + esc(invoice.id) + '">Mark paid</button>' : '';
    return '<tr><td><span class="order-id">' + esc(invoice.invoiceNumber || invoice.id) + '</span></td><td><span class="customer-name">' + esc(invoice.customer) + '</span></td><td>' + currency(invoice.amount) + '</td><td>' + dateText(invoice.issueDate) + '</td><td>' + dateText(invoice.dueDate) + '</td><td>' + pill(invoice.status) + '</td><td>' + action + '</td></tr>';
  }).join('');
  const drafts = db.invoiceReminders.filter(item => item.status === 'Draft');
  return pageHeading('Invoices', 'Record invoices, track due dates, and tie reminder drafts to real invoices.', actionButton('Record invoice', 'new-invoice', 'plus')) +
    '<div class="metrics-grid">' + metricCard('Invoices', invoices.length, 'Saved finance records', 'receipt', 'blue') + metricCard('Open balance', currency(invoices.filter(i => i.status === 'Open' || i.status === 'Overdue').reduce((n, i) => n + i.amount, 0)), 'Unpaid invoice amount', 'clock', 'amber') + metricCard('Overdue', invoices.filter(i => i.status === 'Overdue').length, 'Past due date and unpaid', 'activity', 'violet') + metricCard('Reminder drafts', drafts.length, 'Not emailed', 'checklist', 'green') + '</div>' +
    '<section class="panel orders-panel"><div class="panel-heading"><div><h2>Invoice register</h2><p>Due status is calculated from today and each saved due date.</p></div></div>' +
    (invoices.length ? '<div class="table-scroll"><table class="data-table"><thead><tr><th>Invoice</th><th>Customer</th><th>Amount</th><th>Issued</th><th>Due date</th><th>Status</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' : '<div class="empty-state">No invoices recorded. Add invoices from your actual finance records.</div>') + '</section>' +
    '<div class="section-spacer"></div><section class="panel"><div class="panel-heading"><div><h2>Reminder drafts</h2><p>Drafts are saved locally; nothing is emailed automatically.</p></div></div>' +
    (drafts.length ? '<div class="activity-list">' + drafts.map(reminder => '<div class="activity-item">' + activityIcon({ icon: 'receipt', color: 'amber' }) + '<div class="activity-main"><strong>' + esc(reminder.subject) + '</strong><p>' + esc(reminder.customer) + ' · ' + currency(reminder.amount) + ' · draft</p></div><button class="mini-button" data-copy-reminder="' + esc(reminder.id) + '">Copy draft</button></div>').join('') + '</div>' : '<div class="empty-state">No reminder drafts. Run the invoice workflow to check overdue records.</div>') + '</section>';
}
function workflowsView() {
  const db = state.db;
  const cards = db.workflows.map(workflow => '<article class="workflow-card ' + (workflow.active ? '' : 'workflow-inactive') + '"><div class="workflow-card-top"><span class="workflow-icon ' + esc(workflow.color) + '">' + icon(workflow.icon) + '</span><button class="toggle ' + (workflow.active ? 'on' : '') + '" role="switch" aria-checked="' + workflow.active + '" aria-label="' + (workflow.active ? 'Pause ' : 'Enable ') + esc(workflow.name) + '" data-toggle="' + esc(workflow.id) + '" data-active="' + !workflow.active + '"><span></span></button></div><h2>' + esc(workflow.name) + '</h2><p>' + esc(workflow.description) + '</p><div class="workflow-trigger">' + icon('clock') + '<span>Trigger: ' + esc(workflow.trigger) + '</span></div><div class="workflow-card-footer"><span><b>' + (workflow.active ? 'Active' : 'Paused') + '</b> · ' + workflow.runs + ' runs recorded</span><button class="soft-link" data-command="' + esc(workflow.id === 'wf-stock' ? 'Check inventory and prepare purchase requests' : workflow.id === 'wf-invoice' ? 'Find overdue invoices and draft reminders' : 'Prioritise open orders') + '">Run now</button></div></article>').join('');
  return pageHeading('Workflows', 'Manage actions that use your saved business records.', actionButton('Run workspace scan', 'focus-agent', 'spark')) +
    '<div class="subtle-banner"><strong>Honest mode:</strong> local rules run without an AI key. With an OpenAI key on the server, the model selects a workflow; this app does not call external suppliers or email customers.</div>' +
    '<div class="workflow-grid">' + cards + '</div><div class="section-spacer"></div><section class="panel"><div class="panel-heading"><div><h2>Recent workflow activity</h2><p>Every action is stored in this workspace.</p></div><button class="view-all" data-view="activity">Activity log ' + icon('arrow', 12) + '</button></div>' + activityFeed(db.activity, 5) + '</section>';
}
function approvalsView() {
  const db = state.db;
  const pending = db.approvals.filter(item => item.status === 'Pending');
  const history = db.approvals.filter(item => item.status !== 'Pending');
  const renderRequest = item => '<article class="approval-card"><span class="approval-symbol">' + icon('receipt') + '</span><div class="approval-body"><div class="approval-meta"><span class="approval-id">' + esc(item.id) + '</span>' + pill(item.status) + '<span class="approval-id">' + esc(timeText(item.createdAt)) + '</span></div><h3>' + esc(item.title) + '</h3><p>' + esc(item.description) + '</p><div class="approval-sub"><span>' + icon('users') + esc(item.supplier || 'Supplier not specified') + '</span><span>' + icon('box') + item.quantity + ' units</span></div></div><div class="approval-value">' + currency(item.amount) + '</div><div class="approval-actions">' +
    (item.status === 'Pending' ? '<button class="mini-button" data-decision="reject" data-approval-id="' + esc(item.id) + '">Decline</button><button class="mini-button approve" data-decision="approve" data-approval-id="' + esc(item.id) + '">Approve request</button>' : item.status === 'Approved' ? '<button class="mini-button approve" data-decision="receive" data-approval-id="' + esc(item.id) + '">Record receipt</button>' : '') + '</div></article>';
  return pageHeading('Approvals', 'Review purchase requests before ordering; record goods received to update stock.', '') +
    '<div class="subtle-banner"><strong>Stock handling:</strong> approving records an internal purchase request. Stock changes only after you record the received quantity.</div>' +
    '<section><div class="panel-heading"><div><h2>Waiting for review</h2><p>' + pending.length + ' purchase requests</p></div></div>' + (pending.length ? '<div class="approval-list">' + pending.map(renderRequest).join('') + '</div>' : '<div class="empty-state">No purchase requests waiting for review.</div>') + '</section>' +
    (history.length ? '<div class="section-spacer"></div><section><div class="panel-heading"><div><h2>Purchase request history</h2><p>Approve, receive, and decline events are retained.</p></div></div><div class="approval-list">' + history.slice(0, 10).map(renderRequest).join('') + '</div></section>' : '');
}
function activityView() {
  const db = state.db;
  return pageHeading('Activity log', 'Saved changes from your workspace and workflow runs.', '<a class="secondary-button" href="/api/export">' + icon('receipt') + 'Export data backup</a>') +
    '<section class="panel"><div class="panel-heading"><div><h2>Workspace events</h2><p>' + db.activity.length + ' events · newest first</p></div><span class="demo-badge">LOCAL RECORDS</span></div>' +
    (db.activity.length ? '<div class="activity-log-list">' + db.activity.map(item => '<div class="activity-log-row">' + activityIcon(item) + '<div class="log-copy"><strong>' + esc(item.title) + '</strong><span class="log-agent"> · ' + esc(item.agent) + '</span><p>' + esc(item.description) + '</p><span class="log-meta">' + esc(new Date(item.createdAt).toLocaleString('en-IN')) + ' · ' + pill(item.status) + '</span></div></div>').join('') + '</div>' : '<div class="empty-state">No events yet. Updates to orders, stock, invoices, and workflows are recorded here.</div>') + '</section>';
}
function render() {
  if (!state.db) return;
  const renderers = { overview: dashboard, orders: ordersView, inventory: inventoryView, invoices: invoicesView, workflows: workflowsView, approvals: approvalsView, sync: csvSyncView, activity: activityView };
  viewRoot.innerHTML = (renderers[state.view] || dashboard)();
}
function modal(title, eyebrow, content, formId) {
  const root = document.querySelector('#modalRoot');
  root.innerHTML = '<div class="modal-backdrop" data-close-modal="true"><section class="modal-card" role="dialog" aria-modal="true" aria-labelledby="modalTitle"><div class="modal-header"><div><span class="eyebrow">' + esc(eyebrow) + '</span><h2 id="modalTitle">' + esc(title) + '</h2></div><button class="icon-button" data-close-modal="true" aria-label="Close">' + icon('x') + '</button></div><form id="' + esc(formId) + '">' + content + '<div class="modal-footer"><button class="secondary-button" type="button" data-close-modal="true">Cancel</button><button class="primary-button" type="submit">' + icon('check') + 'Save record</button></div></form></section></div>';
  root.querySelector('input,select')?.focus();
}
function openProductModal() {
  modal('Add inventory product', 'INVENTORY', '<label class="form-field">Product name<input name="name" maxlength="100" required></label><div class="form-row"><label class="form-field">SKU (optional)<input name="sku" maxlength="40" placeholder="Auto-generated if blank"></label><label class="form-field">Category<input name="category" maxlength="60"></label></div><div class="form-row"><label class="form-field">Opening on-hand quantity<input name="stock" type="number" min="0" step="1" required value="0"></label><label class="form-field">Reorder point<input name="reorderLevel" type="number" min="0" step="1" required value="0"></label></div><div class="form-row"><label class="form-field">Unit cost<input name="unitCost" type="number" min="0" step="0.01" required></label><label class="form-field">Selling price<input name="sellingPrice" type="number" min="0" step="0.01" required></label></div><label class="form-field">Supplier (optional)<input name="supplier" maxlength="100"></label>', 'productForm');
}
function openOrderModal() {
  const items = state.db.inventory.filter(item => item.onHand - item.reserved > 0);
  if (!items.length) { toast('Add available inventory before recording an order.', true); setView('inventory'); return; }
  const options = items.map(item => '<option value="' + esc(item.id) + '">' + esc(item.sku + ' · ' + item.name + ' · ' + (item.onHand - item.reserved) + ' available · ' + currency(item.sellingPrice)) + '</option>').join('');
  modal('Create sales order', 'ORDERS', '<label class="form-field">Customer or business name<input name="customer" maxlength="100" required></label><label class="form-field">Product<select name="inventoryId" required>' + options + '</select></label><div class="form-row"><label class="form-field">Quantity<input name="quantity" type="number" min="1" step="1" required value="1"></label><label class="form-field">Priority<select name="priority"><option>Normal</option><option>High</option></select></label></div><p class="form-note">Available stock is reserved when this order is saved. The order total uses the product selling price.</p>', 'orderForm');
}
function openInvoiceModal() {
  const today = state.db.derived.today;
  const due = new Date(today + 'T12:00:00'); due.setDate(due.getDate() + 30);
  const dueDate = due.getFullYear() + '-' + String(due.getMonth() + 1).padStart(2, '0') + '-' + String(due.getDate()).padStart(2, '0');
  modal('Record invoice', 'FINANCE', '<label class="form-field">Customer<input name="customer" maxlength="100" required></label><label class="form-field">Invoice amount (' + esc(state.db.business.currency || 'INR') + ')<input name="amount" type="number" min="0.01" step="0.01" required></label><div class="form-row"><label class="form-field">Issue date<input name="issueDate" type="date" required value="' + esc(today) + '"></label><label class="form-field">Due date<input name="dueDate" type="date" required value="' + esc(dueDate) + '"></label></div>', 'invoiceForm');
}
function openAdjustModal(id) {
  const item = state.db.inventory.find(row => row.id === id);
  if (!item) return;
  modal('Adjust stock · ' + item.name, item.sku, '<p class="form-note">Current on-hand: ' + item.onHand + ' · reserved: ' + item.reserved + '. Positive adds stock; negative records a stock correction.</p><label class="form-field">Quantity change<input name="quantity" type="number" step="1" required placeholder="e.g. 5 or -2"></label><label class="form-field">Reason<input name="reason" maxlength="120" required placeholder="e.g. Supplier delivery or stock count"></label>', 'adjustForm');
  document.querySelector('#adjustForm').dataset.itemId = id;
}
function openBusinessModal() {
  const currentCurrency = state.db?.business?.currency || 'INR';
  modal('Workspace settings', 'SETTINGS', '<label class="form-field">Business or workspace name<input name="name" maxlength="100" placeholder="e.g. Acme Operations" value="' + esc(state.db.business.name) + '"></label><label class="form-field">Workspace currency<select name="currency"><option value="INR"' + (currentCurrency === 'INR' ? ' selected' : '') + '>INR (₹) · Indian Rupee</option><option value="USD"' + (currentCurrency === 'USD' ? ' selected' : '') + '>USD ($) · US Dollar</option><option value="EUR"' + (currentCurrency === 'EUR' ? ' selected' : '') + '>EUR (€) · Euro</option><option value="GBP"' + (currentCurrency === 'GBP' ? ' selected' : '') + '>GBP (£) · British Pound</option></select></label><p class="form-note">Changes the display and calculation currency across your workspace.</p>', 'businessForm');
}
async function submitForm(form) {
  const save = form.querySelector('button[type="submit"]');
  save.disabled = true;
  const data = Object.fromEntries(new FormData(form).entries());
  try {
    if (form.id === 'productForm') await api('/api/inventory', { method: 'POST', body: JSON.stringify(data) });
    if (form.id === 'orderForm') await api('/api/orders', { method: 'POST', body: JSON.stringify(data) });
    if (form.id === 'invoiceForm') await api('/api/invoices', { method: 'POST', body: JSON.stringify(data) });
    if (form.id === 'adjustForm') await api('/api/inventory/' + encodeURIComponent(form.dataset.itemId) + '/adjust', { method: 'POST', body: JSON.stringify(data) });
    if (form.id === 'businessForm') await api('/api/business', { method: 'PATCH', body: JSON.stringify(data) });
    document.querySelector('#modalRoot').innerHTML = '';
    await refresh();
    toast('Saved to your workspace.');
  } catch (error) { save.disabled = false; toast(error.message, true); }
}
document.addEventListener('click', async event => {
  const nav = event.target.closest('[data-view]');
  if (nav) { setView(nav.dataset.view); return; }
  if (event.target.closest('[data-close-modal]')) { document.querySelector('#modalRoot').innerHTML = ''; return; }
  const suggestion = event.target.closest('[data-command]');
  if (suggestion) {
    state.command = suggestion.dataset.command;
    if (suggestion.classList.contains('suggestion-chip')) {
      const input = document.querySelector('#agentCommand');
      if (input) { input.value = state.command; input.focus(); }
      return;
    }
    setView('overview');
    runWorkflow(state.command);
    return;
  }
  const action = event.target.closest('[data-action]');
  if (action) {
    if (action.dataset.action === 'connect-live-csv') { startLiveCsv(); return; }
    if (action.dataset.action === 'disconnect-live-csv') { stopLiveCsv(); return; }
    if (action.dataset.action === 'import-csv') { document.querySelector('#csvFileInput')?.click(); return; }
    if (action.dataset.action === 'add-product') { openProductModal(); return; }
    if (action.dataset.action === 'new-order') { openOrderModal(); return; }
    if (action.dataset.action === 'new-invoice') { openInvoiceModal(); return; }
    if (action.dataset.action === 'set-business') { openBusinessModal(); return; }
    if (action.dataset.action === 'focus-agent') { setView('overview'); setTimeout(() => document.querySelector('#agentCommand')?.focus(), 20); return; }
    if (action.dataset.action === 'export') { window.location.href = '/api/export'; return; }
  }
  const adjust = event.target.closest('[data-adjust-id]');
  if (adjust) { openAdjustModal(adjust.dataset.adjustId); return; }
  const order = event.target.closest('[data-order-id]');
  if (order) {
    try { await api('/api/orders/' + encodeURIComponent(order.dataset.orderId), { method: 'PATCH', body: JSON.stringify({ status: order.dataset.status }) }); await refresh(); toast('Order status saved.'); }
    catch (error) { toast(error.message, true); }
    return;
  }
  const paid = event.target.closest('[data-invoice-paid]');
  if (paid) {
    try { await api('/api/invoices/' + encodeURIComponent(paid.dataset.invoicePaid), { method: 'PATCH', body: JSON.stringify({ status: 'Paid' }) }); await refresh(); toast('Invoice marked paid.'); }
    catch (error) { toast(error.message, true); }
    return;
  }
  const decision = event.target.closest('[data-decision]');
  if (decision) {
    try {
      await api('/api/approvals/' + encodeURIComponent(decision.dataset.approvalId), { method: 'POST', body: JSON.stringify({ decision: decision.dataset.decision }) });
      await refresh();
      toast(decision.dataset.decision === 'approve' ? 'Request approved. Record receipt when stock arrives.' : decision.dataset.decision === 'receive' ? 'Receipt saved; stock is updated.' : 'Purchase request declined.');
    } catch (error) { toast(error.message, true); }
    return;
  }
  const toggle = event.target.closest('[data-toggle]');
  if (toggle) {
    try { await api('/api/workflows/' + encodeURIComponent(toggle.dataset.toggle), { method: 'PATCH', body: JSON.stringify({ active: toggle.dataset.active === 'true' }) }); await refresh(); toast('Workflow setting saved.'); }
    catch (error) { toast(error.message, true); }
    return;
  }
  const copy = event.target.closest('[data-copy-reminder]');
  if (copy) {
    const reminder = state.db.invoiceReminders.find(item => item.id === copy.dataset.copyReminder);
    if (reminder) {
      try { await navigator.clipboard.writeText(reminder.subject + '\n\n' + reminder.body); toast('Draft copied. It has not been emailed.'); }
      catch { toast('Clipboard access unavailable in this browser.', true); }
    }
    return;
  }
  if (event.target.closest('#themeToggle')) {
    toggleTheme();
    return;
  }
  if (event.target.closest('#helpButton')) toast('Add your records first. Workspace figures are calculated from saved data.');
  if (event.target.closest('#notificationButton')) setView('approvals');
});
document.addEventListener('change', event => {
  if (event.target.id === 'csvEntity' && !state.csvLive.handle) state.csvLive.entity = event.target.value;
  if (event.target.id === 'csvFileInput') {
    const file = event.target.files?.[0];
    if (file) importCsvFile(file, 'manual', document.querySelector('#csvEntity')?.value || 'inventory');
    event.target.value = '';
  }
});
document.addEventListener('submit', event => {
  const form = event.target;
  if (form.id === 'agentForm') {
    event.preventDefault();
    runWorkflow(document.querySelector('#agentCommand').value.trim());
  } else if (['productForm', 'orderForm', 'invoiceForm', 'adjustForm', 'businessForm'].includes(form.id)) {
    event.preventDefault();
    submitForm(form);
  }
});
document.addEventListener('keydown', event => { if (event.key === 'Escape') document.querySelector('#modalRoot').innerHTML = ''; });
async function runWorkflow(command) {
  if (!command || state.busy) { if (!command) toast('Describe a task to run.', true); return; }
  state.command = command; state.busy = true; state.result = null; render();
  try {
    state.result = await api('/api/agent/run', { method: 'POST', body: JSON.stringify({ command }) });
    state.busy = false;
    await refresh();
    if (state.result.paused) toast(state.result.summary, true);
    else toast('Workflow completed against saved records.');
  } catch (error) { state.busy = false; render(); toast(error.message, true); }
}
function connectLiveUpdates() {
  const source = new EventSource('/api/events');
  source.onopen = () => { const status = document.querySelector('#connectionStatus'); if (status) status.innerHTML = '<span class="system-dot"></span> Workspace updates connected'; };
  source.onerror = () => { const status = document.querySelector('#connectionStatus'); if (status) status.innerHTML = '<span class="system-dot offline"></span> Reconnecting workspace updates…'; };
  source.addEventListener('workspace.updated', () => {
    clearTimeout(state.syncTimer);
    state.syncTimer = setTimeout(() => refresh().catch(() => {}), 180);
  });
}
function getTheme() {
  return localStorage.getItem('astra_theme') || 'dark';
}
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  if (theme === 'dark') document.documentElement.classList.add('dark');
  else document.documentElement.classList.remove('dark');
  localStorage.setItem('astra_theme', theme);
  const toggleBtn = document.querySelector('#themeToggle');
  if (toggleBtn) {
    toggleBtn.innerHTML = icon(theme === 'dark' ? 'sun' : 'theme', 16);
    toggleBtn.setAttribute('title', theme === 'dark' ? 'Switch to Classic Light Theme' : 'Switch to Stitch Precision Dark Theme');
  }
}
function toggleTheme() {
  const current = getTheme();
  const next = current === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  toast(next === 'dark' ? 'Switched to Stitch Precision Dark Theme' : 'Switched to Classic Light Theme');
}
document.querySelector('#openSidebar')?.addEventListener('click', () => { document.querySelector('#sidebar').classList.add('open'); document.querySelector('#mobileScrim').classList.add('visible'); });
document.querySelector('#closeSidebar')?.addEventListener('click', () => { document.querySelector('#sidebar').classList.remove('open'); document.querySelector('#mobileScrim').classList.remove('visible'); });
document.querySelector('#mobileScrim')?.addEventListener('click', () => { document.querySelector('#sidebar').classList.remove('open'); document.querySelector('#mobileScrim').classList.remove('visible'); });

applyTheme(getTheme());

refresh().then(connectLiveUpdates).catch(error => { viewRoot.innerHTML = '<div class="empty-state">Could not load the workspace: ' + esc(error.message) + '. Start the project with npm start, then reload.</div>'; });

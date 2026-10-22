(function (global) {
  const aliases = {
    inventory: {
      sku: ['sku', 'product_code', 'item_code', 'product_sku'],
      externalId: ['externalid', 'external_id', 'product_id', 'item_id', 'id'],
      name: ['name', 'product', 'product_name', 'item_name'],
      category: ['category', 'product_category'],
      onHand: ['onhand', 'on_hand', 'stock', 'quantity', 'qty', 'current_stock'],
      reorderLevel: ['reorderlevel', 'reorder_level', 'reorder_point', 'reorderpoint', 'minimum_stock', 'min_stock'],
      unitCost: ['unitcost', 'unit_cost', 'cost', 'purchase_price'],
      sellingPrice: ['sellingprice', 'selling_price', 'price', 'unit_price'],
      supplier: ['supplier', 'vendor']
    },
    invoices: {
      externalId: ['externalid', 'external_id', 'invoice_id', 'id'],
      invoiceNumber: ['invoicenumber', 'invoice_number', 'invoice_no', 'invoice'],
      customer: ['customer', 'customer_name', 'client'],
      amount: ['amount', 'total', 'invoice_amount', 'total_amount'],
      issueDate: ['issuedate', 'issue_date', 'invoice_date', 'date'],
      dueDate: ['duedate', 'due_date', 'payment_due'],
      status: ['status', 'payment_status'],
      currency: ['currency', 'currency_code']
    }
  };

  function splitRows(text) {
    const input = String(text || '').replace(/^\uFEFF/, '');
    const rows = [];
    let row = [], cell = '', quoted = false;
    for (let i = 0; i < input.length; i++) {
      const char = input[i];
      if (quoted) {
        if (char === '"' && input[i + 1] === '"') { cell += '"'; i++; }
        else if (char === '"') quoted = false;
        else cell += char;
      } else if (char === '"' && cell.length === 0) quoted = true;
      else if (char === ',') { row.push(cell); cell = ''; }
      else if (char === '\n' || char === '\r') {
        if (char === '\r' && input[i + 1] === '\n') i++;
        row.push(cell); rows.push(row); row = []; cell = '';
      } else cell += char;
    }
    if (quoted) throw new Error('CSV has an unclosed quoted field. Save it again from Excel and retry.');
    if (cell.length || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(cells => cells.some(value => String(value).trim() !== ''));
  }

  function normalizeHeader(value) {
    return String(value || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
  }

  function detect(text) {
    const rows = splitRows(text);
    const headers = new Set((rows[0] || []).map(normalizeHeader));
    const has = (entity, field) => aliases[entity][field].some(name => headers.has(name));
    const invoice = has('invoices', 'customer') && has('invoices', 'amount') && has('invoices', 'issueDate') && (has('invoices', 'invoiceNumber') || has('invoices', 'externalId'));
    const inventory = has('inventory', 'name') && has('inventory', 'onHand') && (has('inventory', 'sku') || has('inventory', 'externalId'));
    if (invoice && !inventory) return 'invoices';
    if (inventory && !invoice) return 'inventory';
    if (invoice && inventory) return 'ambiguous';
    return null;
  }

  function parse(text, entity) {
    const fields = aliases[entity];
    if (!fields) throw new Error('Choose inventory or invoices before importing the CSV.');
    const rows = splitRows(text);
    if (rows.length < 2) throw new Error('CSV needs a header row and at least one data row.');
    const lookup = new Map();
    for (const [field, names] of Object.entries(fields)) for (const name of names) lookup.set(name, field);
    const columns = rows[0].map(header => lookup.get(normalizeHeader(header)) || null);
    const recognized = columns.filter(Boolean);
    if (new Set(recognized).size !== recognized.length) throw new Error('CSV has duplicate columns for the same field. Keep one column per field.');
    const has = field => columns.includes(field);
    const required = entity === 'inventory' ? ['name', 'onHand'] : ['customer', 'amount', 'issueDate'];
    const missing = required.filter(field => !has(field));
    if (entity === 'inventory' && !has('sku') && !has('externalId')) missing.push('sku or externalId');
    if (entity === 'invoices' && !has('invoiceNumber') && !has('externalId')) missing.push('invoiceNumber or externalId');
    if (missing.length) throw new Error('CSV is missing required columns: ' + missing.join(', ') + '.');
    return rows.slice(1).map((values, rowIndex) => {
      const record = {};
      columns.forEach((field, index) => { if (field) record[field] = String(values[index] ?? '').trim(); });
      if (Object.values(record).every(value => value === '')) return null;
      return record;
    }).filter(Boolean);
  }

  global.AstraCsvSync = { parse, detect };
})(window);

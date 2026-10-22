# Astra ERP — real records, live updates

Astra is a local ERP workspace for recording and working with **your own business data**. It starts with no example customers, orders, products, invoices, or revenue. Nothing is pre-filled to make the dashboard look busy.

## What works

- **Inventory:** create a product with SKU, opening quantity, reorder point, cost, selling price, and supplier. Adjust stock with a recorded reason.
- **Sales orders:** create an order from a saved product. The server checks available stock and reserves it. Shipping deducts on-hand stock; cancelling releases the reservation.
- **Invoices:** record an invoice with issue date, due date, customer, and amount. Overdue status is calculated from today's date. Mark invoices paid.
- **Workflow actions:** check saved stock, prepare a purchase request for each low-stock product, create reminder drafts for saved overdue invoices, and summarize saved open orders.
- **Automatic triggers:** when saved stock reaches its reorder point or an invoice is entered past due, the active workflow prepares the corresponding request/draft. A background scan checks overdue invoices once a minute while the server is running.
- **Human review:** approving a purchase request does not change stock. Record the goods receipt when they arrive to add units to on-hand quantity.
- **Live updates:** the server sends Server-Sent Events to open tabs. When one tab saves a record, other tabs refresh from the same saved workspace.
- **Live CSV sync:** connect a selected inventory or invoice CSV. The browser checks it every 3 seconds while that tab stays open, upserts changed rows, and pushes updates to all open ERP tabs. Excel workbooks must be saved as CSV UTF-8 first. Imports never delete records.
- **Persistence and backup:** changes are saved in data/db.json; export a JSON backup from the activity log.
- **Optional real AI planner:** add an OpenAI API key to let a model choose among the supported workflows. Without a key, transparent local keyword rules work. Neither mode invents records or sends purchases/emails.

## Run locally

Requirements: Node.js 18+ and a modern browser. There are no npm dependencies.

From this project directory:

~~~powershell
npm start
~~~

Open http://127.0.0.1:3000. The server binds to loopback by default, so the app is available on this computer only.

Change the port if needed:

~~~powershell
$env:PORT = "3100"
npm start
~~~

The data is local to this machine. Back up data/db.json or use **Export data backup** before moving the project. Do not put sensitive customer information into this classroom-sized local app until you add authentication, access controls, and a production database.

### Optional live AI planning

PowerShell, in the same window used to start the server:

~~~powershell
$env:OPENAI_API_KEY = "your-api-key"
$env:OPENAI_MODEL = "gpt-6-astra"
npm start
~~~

Keep the key on the server; never put it in browser code or commit it. API access and usage charges depend on your OpenAI account. The model receives the typed request and counts/names from the real workspace, and it may select only inventory, invoice, orders, or overview. Server code validates that result and performs the action. The OpenAI integration uses the [Responses API function-calling pattern](https://developers.openai.com/api/docs/guides/function-calling). If the API is unavailable, the app reports that it used local rules.

## First-use workflow

1. Open **Inventory → Add product** and enter a real product and its opening stock. Selling price is used when orders are created.
2. Open **Orders → New order**, choose a saved product and quantity, and enter the customer. Available units are reserved.
3. Move the order to **Ready to ship**, then **Shipped**. On shipment, on-hand and reserved quantities are updated. Cancelling releases reserved stock.
4. Open **Invoices → Record invoice** and enter a real invoice date and due date. Mark it paid when payment is received.
5. Use **Run a workflow on your records** to check inventory, scan overdue invoices, or prioritize open orders.
6. Review purchase requests in **Approvals**. Approve or decline; after physical delivery, record receipt to update stock.
7. Open the app in a second tab and save a change in either tab to see the other tab update live.
8. For a spreadsheet source, open **Live data sync**, download the blank template, fill it with actual rows, save it as CSV UTF-8, choose Inventory or Invoices, and connect the file. Save the spreadsheet to publish changes. Use **Import once** in browsers that do not support continuous local-file access.

### CSV headers

Inventory requires `name` and `onHand`, plus `sku` or `externalId`. Optional columns are `category`, `reorderLevel`, `unitCost`, `sellingPrice`, and `supplier`. Invoices require a customer, amount, issue date, and `invoiceNumber` or `externalId`; tracked invoice statuses (`Open`, `Overdue`, or `Paid`) require a due date. `Untracked` invoices may omit due dates when the source does not contain them. An optional three-letter `currency` column sets the workspace currency for the import, and is rejected if existing records use another currency. Dates use `YYYY-MM-DD`. Existing products match by external ID or SKU; invoices match by external ID or invoice number. Imports create or update matching records and do not remove rows missing from the file.

The Live data sync page includes a 5,000-invoice UCI historical sample prepared from the public Online Retail dataset. It is under 4 MB and uses GBP. Invoice totals are summed from the source quantity and unit price; missing customer names, payment status, and due dates are not invented. Rows without complete positive invoice data are excluded. The original 541,909-line source CSV remains available separately and is not accepted by the inventory/invoice importer.

Continuous file watching uses the browser's local file access support and runs only while the selected file's ERP tab stays open. The file contents are sent to this local app on the same computer. This is a real-time spreadsheet bridge; it is not a direct connection to Tally, Odoo, or another company's ERP API.

## Architecture

~~~text
Browser pages
  ├── HTML / CSS / JavaScript
  ├── REST requests for saves and edits
  └── EventSource for live refreshes
        │
        ▼
Node.js server (loopback by default)
  ├── Input validation and serialized writes
  ├── Inventory, sales, finance, and workflow rules
  ├── Optional Responses API planner
  └── data/db.json (persistent local workspace)
~~~

## Main routes

| Method | Route | Purpose |
|---|---|---|
| GET | /api/bootstrap | Load records and calculated dashboard totals |
| GET | /api/events | Subscribe to live workspace updates |
| GET | /api/export | Download a backup of the local data |
| POST | /api/inventory | Create a product |
| POST | /api/import/csv | Upsert inventory or invoices from parsed CSV records |
| POST | /api/inventory/:id/adjust | Record a stock adjustment and reason |
| POST | /api/orders | Create an order and reserve available stock |
| PATCH | /api/orders/:id | Advance, ship, or cancel an order |
| POST | /api/invoices | Record an invoice |
| PATCH | /api/invoices/:id | Mark an invoice paid |
| POST | /api/agent/run | Run a supported workflow on current records |
| POST | /api/approvals/:id | Approve/decline a request or record received goods |
| PATCH | /api/workflows/:id | Pause or enable a workflow |
| PATCH | /api/business | Set the workspace label |

## Boundaries

This is a working local project, not a connection to an existing company account. The workspace becomes real when you enter your actual records. No live ERP, accounting package, supplier, email, or payment provider was connected in this workspace. The app therefore does not pretend to sync external records or send messages.

The JSON store and loopback server suit a single-computer college project. To use it for a real team, add a database such as PostgreSQL, login and role-based access, server deployment, backups, audit retention, and authenticated integrations. Do not expose the local server to the internet as-is.

## Viva summary

> Astra ERP stores the user's own inventory, sales orders, and invoices. Orders reserve stock, shipment issues the stock, and cancellations release it. The workflow engine checks these saved records and drafts purchase requests or invoice reminders. A person approves procurement and records received goods. Server-Sent Events refresh open tabs after a write. Optional model function calling only chooses the workflow; application code validates and executes it. No sample business transactions are inserted.

**Files:** server.js (REST server/workflows), public/app.js (UI and live refresh), public/styles.css (design), data/db.json (local records).

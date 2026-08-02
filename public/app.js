const $ = (sel) => document.querySelector(sel)
const app = $('#app')

const state = {
  status: null,
  user: null,
  csrfToken: sessionStorage.getItem('csrfToken') || '',
  menu: [],
  categories: [],
  category: 'All',
  tables: [],
  selectedTableId: '',
  orderMeta: { table: '', customerName: '', paymentMethod: 'Cash', paidAmount: '', note: '' },
  cart: [],
  recentKots: [],
  recentBills: [],
  tab: 'tables',
  lastPrintable: '',
  message: '',
  error: '',
}

const money = (paise = 0) => `₹${(Number(paise || 0) / 100).toFixed(2)}`
const toPaise = (value) => Math.round((Number(value) || 0) * 100)
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]))

async function api(path, opts = {}) {
  const method = String(opts.method || 'GET').toUpperCase()
  const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken
  const res = await fetch(path, { credentials: 'include', ...opts, method, headers })
  const text = await res.text()
  let body = {}
  try { body = text ? JSON.parse(text) : {} } catch {}
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { status: res.status, body })
  return body
}

function setMsg(message = '', error = '') {
  state.message = message
  state.error = error
  render()
}

async function boot() {
  try {
    state.status = await api('/api/status')
    const me = await api('/api/me')
    state.user = me.user
    if (state.user) await loadStartupData()
  } catch {
    state.user = null
  }
  render()
}

async function loadMenu() {
  const res = await api('/api/menu')
  state.menu = res.items || []
  state.categories = ['All', ...(res.categories || [])]
}

async function loadTables() {
  const res = await api('/api/tables')
  state.tables = res.tables || []
}

async function loadStartupData() {
  await loadMenu()
  await loadTables()
}

function totals(items = state.cart) {
  const subtotal = items.reduce((sum, item) => sum + item.pricePaise * item.quantity, 0)
  const tax = items.reduce((sum, item) => sum + Math.round(item.pricePaise * item.quantity * (item.taxBps || 0) / 10000), 0)
  return { subtotal, tax, total: subtotal + tax, count: items.reduce((sum, item) => sum + item.quantity, 0) }
}

function itemPayload(item) {
  if (item.type === 'CUSTOM_ITEM') return {
    type: 'CUSTOM_ITEM',
    name: item.name,
    pricePaise: item.pricePaise,
    taxBps: item.taxBps,
    quantity: item.quantity,
    reason: item.reason,
  }
  return { menuItemId: item.id, quantity: item.quantity }
}

function addItem(item) {
  const found = state.cart.find(line => line.id === item.id && line.type !== 'CUSTOM_ITEM')
  if (found) found.quantity += 1
  else state.cart.push({ ...item, quantity: 1 })
  render()
}

function setMeta(key, value) {
  state.orderMeta[key] = value
}

function addItemById(itemId) {
  const item = state.menu.find(entry => entry.id === itemId)
  if (item) addItem(item)
}

function changeQty(index, delta) {
  const line = state.cart[index]
  if (!line) return
  line.quantity += delta
  if (line.quantity <= 0) state.cart.splice(index, 1)
  render()
}

function addCustomItem() {
  const name = $('#customName').value.trim()
  const price = toPaise($('#customPrice').value)
  const reason = $('#customReason').value.trim()
  if (!name || price <= 0 || !reason) return setMsg('', 'Custom item needs name, price, and reason')
  state.cart.push({ id: `custom-${Date.now()}`, type: 'CUSTOM_ITEM', name, pricePaise: price, taxBps: 500, quantity: 1, reason })
  $('#customName').value = ''
  $('#customPrice').value = ''
  $('#customReason').value = ''
  render()
}

async function selectTable(tableId) {
  try {
    const res = await api(`/api/tables/${encodeURIComponent(tableId)}/order`)
    state.selectedTableId = tableId
    state.orderMeta.table = res.table.name
    state.cart = (res.order?.items || []).map(item => ({ ...item }))
    state.tab = 'order'
    setMsg('')
  } catch (e) { setMsg('', e.message) }
}

async function saveTableOrder(silent = false) {
  if (!state.selectedTableId) return setMsg('', 'Select a table first')
  try {
    await api(`/api/tables/${encodeURIComponent(state.selectedTableId)}/order`, {
      method: 'PUT',
      body: JSON.stringify({ items: state.cart.map(itemPayload) }),
    })
    await loadTables()
    if (!silent) setMsg('Table order saved')
  } catch (e) { setMsg('', e.message) }
}

function receiptFor(kind, doc) {
  const lines = []
  lines.push(state.status?.restaurant?.name || 'Restaurant')
  lines.push(`${kind}: ${doc.number}`)
  lines.push(`Time: ${new Date(doc.createdAt).toLocaleString()}`)
  if (doc.table) lines.push(`Table: ${doc.table}`)
  lines.push(`Staff: ${doc.staff}`)
  lines.push('------------------------------')
  for (const item of doc.items || []) {
    const qty = item.quantity || 1
    const total = (item.totalPaise || item.pricePaise * qty)
    lines.push(`${qty} x ${item.name}`)
    lines.push(`    ${money(total)}`)
    if (item.reason) lines.push(`    custom: ${item.reason}`)
  }
  if (doc.totals) {
    lines.push('------------------------------')
    lines.push(`Subtotal ${money(doc.totals.subtotalPaise)}`)
    lines.push(`Tax      ${money(doc.totals.taxPaise)}`)
    lines.push(`Total    ${money(doc.totals.grandTotalPaise)}`)
    lines.push(`Paid     ${money(doc.paidPaise)}`)
    lines.push(`Balance  ${money(doc.balancePaise)}`)
  }
  return lines.join('\n')
}

async function sendKot() {
  try {
    const table = state.orderMeta.table.trim()
    const note = state.orderMeta.note.trim()
    const res = await api('/api/kot', { method: 'POST', body: JSON.stringify({ tableId: state.selectedTableId || undefined, table, note, items: state.cart.map(itemPayload) }) })
    if (state.selectedTableId) await loadTables()
    state.lastPrintable = receiptFor('KOT', res.kot)
    setMsg(`KOT ${res.kot.number} saved`)
  } catch (e) { setMsg('', e.message) }
}

async function makeBill() {
  try {
    const table = state.orderMeta.table.trim()
    const customerName = state.orderMeta.customerName.trim()
    const paymentMethod = state.orderMeta.paymentMethod
    const paidAmount = state.orderMeta.paidAmount || (totals().total / 100)
    const res = await api('/api/bill', { method: 'POST', body: JSON.stringify({ tableId: state.selectedTableId || undefined, table, customerName, paymentMethod, paidAmount, items: state.cart.map(itemPayload) }) })
    state.lastPrintable = receiptFor('BILL', res.bill)
    state.cart = []
    state.selectedTableId = ''
    state.orderMeta = { table: '', customerName: '', paymentMethod: 'Cash', paidAmount: '', note: '' }
    await loadTables()
    setMsg(`Bill ${res.bill.number} saved`)
  } catch (e) { setMsg('', e.message) }
}

function printLast() {
  if (!state.lastPrintable) return setMsg('', 'Nothing to print yet')
  const box = $('#printBox')
  box.textContent = state.lastPrintable
  box.classList.add('printable')
  window.print()
}

function printDoc(kind, id) {
  const doc = (kind === 'KOT' ? state.recentKots : state.recentBills).find(entry => entry.id === id)
  if (!doc) return setMsg('', 'Document not found')
  state.lastPrintable = receiptFor(kind, doc)
  render()
  setTimeout(printLast, 50)
}

async function setupOwner() {
  try {
    const body = {
      restaurantName: $('#setupRestaurant').value.trim(),
      outletName: $('#setupOutlet').value.trim(),
      ownerName: $('#setupOwnerName').value.trim(),
      ownerUsername: $('#setupUsername').value.trim(),
      ownerPassword: $('#setupPassword').value,
      phone: $('#setupPhone').value.trim(),
      address: $('#setupAddress').value.trim(),
    }
    await api('/api/setup', { method: 'POST', body: JSON.stringify(body) })
    state.status = await api('/api/status')
    setMsg('Setup complete. Sign in now.')
  } catch (e) { setMsg('', e.message) }
}

async function login() {
  try {
    const res = await api('/api/login', { method: 'POST', body: JSON.stringify({ username: $('#loginUsername').value.trim(), password: $('#loginPassword').value }) })
    state.user = res.user
    state.csrfToken = res.csrfToken
    sessionStorage.setItem('csrfToken', state.csrfToken)
    await loadStartupData()
    setMsg('')
  } catch (e) { setMsg('', e.message) }
}

async function logout() {
  try { await api('/api/logout', { method: 'POST' }) } catch {}
  state.user = null
  state.csrfToken = ''
  sessionStorage.removeItem('csrfToken')
  state.cart = []
  state.tables = []
  state.selectedTableId = ''
  state.orderMeta = { table: '', customerName: '', paymentMethod: 'Cash', paidAmount: '', note: '' }
  render()
}

async function addMenuItem() {
  try {
    const body = {
      category: $('#newCategory').value.trim(),
      name: $('#newItem').value.trim(),
      price: $('#newPrice').value,
      taxBps: Number($('#newTax').value || 5) * 100,
    }
    await api('/api/menu', { method: 'POST', body: JSON.stringify(body) })
    await loadMenu()
    setMsg('Menu item added')
  } catch (e) { setMsg('', e.message) }
}

async function addUser() {
  try {
    const body = {
      name: $('#staffName').value.trim(),
      username: $('#staffUsername').value.trim(),
      password: $('#staffPassword').value,
      role: $('#staffRole').value,
    }
    await api('/api/users', { method: 'POST', body: JSON.stringify(body) })
    setMsg('Staff user added')
  } catch (e) { setMsg('', e.message) }
}

async function addTable() {
  try {
    const body = {
      name: $('#newTableName').value.trim(),
      capacity: $('#newTableCapacity').value,
      section: $('#newTableSection').value.trim() || 'Dining',
    }
    await api('/api/tables', { method: 'POST', body: JSON.stringify(body) })
    await loadTables()
    setMsg('Table added')
  } catch (e) { setMsg('', e.message) }
}

async function renderReport() {
  try {
    const report = await api('/api/reports/today')
    $('#reportBox').innerHTML = `
      <div class="grid2">
        <div class="panel"><div class="sub">Bills</div><div class="title">${report.billCount}</div></div>
        <div class="panel"><div class="sub">Sales</div><div class="title">${money(report.totalPaise)}</div></div>
      </div>
      <div class="panel">
        <b>Today Bills</b>
        ${(report.bills || []).slice().reverse().map(b => `<div class="listrow"><b>${escapeHtml(b.number)}</b><div class="meta">${escapeHtml(b.paymentMethod)} · ${money(b.totals.grandTotalPaise)} · ${new Date(b.createdAt).toLocaleTimeString()}</div></div>`).join('') || '<div class="sub">No bills yet.</div>'}
      </div>`
  } catch (e) { $('#reportBox').innerHTML = `<div class="error">${escapeHtml(e.message)}</div>` }
}

async function downloadExport() {
  try {
    const exportData = await api('/api/export')
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `mobile-pos-export-${new Date().toISOString().slice(0,10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) { setMsg('', e.message) }
}

function setupView() {
  return `<main class="screen">
    <div class="panel">
      <h1 class="title">Set Up POS</h1>
      <div class="sub">Create the owner account and restaurant profile. Use a strong password; there is no default.</div>
      <label class="label">Restaurant</label><input class="input" id="setupRestaurant" placeholder="Restaurant name">
      <div class="grid2"><div><label class="label">Outlet</label><input class="input" id="setupOutlet" value="Main Outlet"></div><div><label class="label">Phone</label><input class="input" id="setupPhone"></div></div>
      <label class="label">Address</label><textarea class="textarea" id="setupAddress"></textarea>
      <label class="label">Owner Name</label><input class="input" id="setupOwnerName" value="Owner">
      <div class="grid2"><div><label class="label">Username</label><input class="input" id="setupUsername" value="owner"></div><div><label class="label">Password</label><input class="input" id="setupPassword" type="password" placeholder="8+ characters"></div></div>
      <button class="btn block" onclick="setupOwner()">Create POS</button>
    </div>
    ${messages()}
  </main>`
}

function loginView() {
  return `<main class="screen">
    <div class="panel">
      <h1 class="title">${escapeHtml(state.status?.restaurant?.name || 'Mobile POS')}</h1>
      <div class="sub">Sign in to start billing from this phone.</div>
      <label class="label">Username</label><input class="input" id="loginUsername" autocomplete="username" value="owner">
      <label class="label">Password</label><input class="input" id="loginPassword" type="password" autocomplete="current-password">
      <button class="btn block" onclick="login()">Sign In</button>
    </div>
    ${messages()}
  </main>`
}

function tablesView() {
  const sections = [...new Set(state.tables.map(t => t.section || 'Dining'))]
  return `<main class="screen">
    <div class="panel">
      <h1 class="title">Tables</h1>
      <div class="sub">Select a table to open its running order. Final bill frees the table.</div>
    </div>
    ${sections.map(section => `
      <div class="sectionTitle">${escapeHtml(section)}</div>
      <div class="tableGrid">
        ${state.tables.filter(t => (t.section || 'Dining') === section).map(table => `
          <button class="tableCard ${table.status}" onclick="selectTable('${escapeHtml(table.id)}')">
            <b>${escapeHtml(table.name)}</b>
            <span>${table.status === 'occupied' ? 'Occupied' : 'Available'}${table.capacity ? ` · ${table.capacity} pax` : ''}</span>
            ${table.status === 'occupied' ? `<strong>${table.itemCount} items · ${money(table.totalPaise)}</strong>` : '<em>Tap to start</em>'}
          </button>
        `).join('')}
      </div>
    `).join('')}
    <button class="btn secondary block" onclick="state.selectedTableId='';state.orderMeta={table:'Parcel',customerName:'',paymentMethod:'Cash',paidAmount:'',note:''};state.cart=[];state.tab='order';render()">Quick Parcel / No Table</button>
    ${messages()}
  </main>`
}

function orderView() {
  const visible = state.category === 'All' ? state.menu : state.menu.filter(i => i.category === state.category)
  const t = totals()
  const selected = state.tables.find(table => table.id === state.selectedTableId)
  return `<main class="screen">
    <div class="panel">
      <div class="row" style="margin-bottom:8px">
        <div style="flex:1"><b>${selected ? escapeHtml(selected.name) : escapeHtml(state.orderMeta.table || 'No table')}</b><div class="meta">${selected ? 'Running table order' : 'Parcel / direct bill'}</div></div>
        <button class="btn secondary" onclick="state.tab='tables';render()">Change</button>
      </div>
      <div class="grid2">
        <input class="input" id="tableName" placeholder="Table / parcel" value="${escapeHtml(state.orderMeta.table)}" oninput="setMeta('table', this.value)" ${selected ? 'readonly' : ''}>
        <select class="select" id="paymentMethod" onchange="setMeta('paymentMethod', this.value)"><option ${state.orderMeta.paymentMethod === 'Cash' ? 'selected' : ''}>Cash</option><option ${state.orderMeta.paymentMethod === 'UPI' ? 'selected' : ''}>UPI</option><option ${state.orderMeta.paymentMethod === 'Card' ? 'selected' : ''}>Card</option></select>
      </div>
      <div class="grid2">
        <input class="input" id="customerName" placeholder="Customer name" style="margin-top:8px" value="${escapeHtml(state.orderMeta.customerName)}" oninput="setMeta('customerName', this.value)">
        <input class="input" id="paidAmount" type="number" placeholder="Paid amount" style="margin-top:8px" value="${escapeHtml(state.orderMeta.paidAmount)}" oninput="setMeta('paidAmount', this.value)">
      </div>
      <textarea class="textarea" id="orderNote" placeholder="Kitchen note" style="margin-top:8px" oninput="setMeta('note', this.value)">${escapeHtml(state.orderMeta.note)}</textarea>
    </div>
    <div class="chips">${state.categories.map(c => `<button class="chip ${c === state.category ? 'active' : ''}" onclick="state.category='${escapeHtml(c)}';render()">${escapeHtml(c)}</button>`).join('')}</div>
    <div class="items">${visible.map(item => `<button class="item" onclick="addItemById('${escapeHtml(item.id)}')"><b>${escapeHtml(item.name)}</b><span>${escapeHtml(item.category)} · ${money(item.pricePaise)}</span></button>`).join('')}</div>
    <div class="panel">
      <b>Custom item</b>
      <input class="input" id="customName" placeholder="Name" style="margin-top:8px">
      <div class="grid2"><input class="input" id="customPrice" type="number" placeholder="Price"><input class="input" id="customReason" placeholder="Reason"></div>
      <button class="btn secondary block" onclick="addCustomItem()">Add Custom Item</button>
    </div>
    ${cartView()}
    ${state.lastPrintable ? `<div class="panel"><button class="btn dark block" onclick="printLast()">Print Last KOT/Bill</button><pre id="printBox" class="receipt">${escapeHtml(state.lastPrintable)}</pre></div>` : '<pre id="printBox" class="receipt hide"></pre>'}
    ${messages()}
    ${state.cart.length ? `<div class="cartbar"><div class="total">${t.count} items · ${money(t.total)}</div>${state.selectedTableId ? '<button class="btn secondary" onclick="saveTableOrder()">Save</button>' : ''}<button class="btn secondary" onclick="sendKot()">KOT</button><button class="btn good" onclick="makeBill()">Bill</button></div>` : ''}
  </main>`
}

function cartView() {
  if (!state.cart.length) return '<div class="notice">Cart is empty. Tap menu items to add them.</div>'
  return `<div class="panel"><b>Cart</b>${state.cart.map((line, i) => `<div class="cartline"><div><b>${escapeHtml(line.name)}</b><div class="meta">${money(line.pricePaise)} each${line.reason ? ` · ${escapeHtml(line.reason)}` : ''}</div></div><div class="qty"><button onclick="changeQty(${i},-1)">-</button><b>${line.quantity}</b><button onclick="changeQty(${i},1)">+</button></div></div>`).join('')}</div>`
}

function listView(kind) {
  const target = kind === 'kots' ? '/api/kots' : '/api/bills'
  setTimeout(async () => {
    try {
      const res = await api(target)
      const docs = res[kind] || []
      if (kind === 'kots') state.recentKots = docs
      else state.recentBills = docs
      const label = kind === 'kots' ? 'KOT' : 'BILL'
      $(`#${kind}Box`).innerHTML = docs.map(d => `<div class="listrow"><b>${escapeHtml(d.number)}</b><div class="meta">${escapeHtml(d.table || 'No table')} · ${escapeHtml(d.staff)} · ${new Date(d.createdAt).toLocaleString()}</div><button class="btn secondary" onclick="printDoc('${label}','${escapeHtml(d.id)}')">Print</button></div>`).join('') || '<div class="sub">Nothing yet.</div>'
    } catch (e) { $(`#${kind}Box`).innerHTML = `<div class="error">${escapeHtml(e.message)}</div>` }
  }, 0)
  return `<main class="screen"><div class="panel"><h1 class="title">${kind === 'kots' ? 'KOTs' : 'Bills'}</h1><div id="${kind}Box" class="sub">Loading...</div></div><pre id="printBox" class="receipt hide"></pre></main>`
}

function reportView() {
  setTimeout(renderReport, 0)
  return `<main class="screen"><div id="reportBox"></div><button class="btn secondary block" onclick="downloadExport()">Download Backup JSON</button>${messages()}</main>`
}

function manageView() {
  const ownerOnly = state.user?.role === 'OWNER'
  return `<main class="screen">
    ${ownerOnly ? `<div class="panel"><h1 class="title">Manage</h1><div class="sub">Owner-only menu and staff setup.</div>
      <label class="label">Add Menu Item</label>
      <input class="input" id="newCategory" placeholder="Category">
      <input class="input" id="newItem" placeholder="Item name" style="margin-top:8px">
      <div class="grid2"><input class="input" id="newPrice" type="number" placeholder="Price"><input class="input" id="newTax" type="number" value="5" placeholder="GST %"></div>
      <button class="btn block" onclick="addMenuItem()">Add Item</button>
      <label class="label">Add Table</label>
      <div class="grid2"><input class="input" id="newTableName" placeholder="T-5 / Rooftop 1"><input class="input" id="newTableCapacity" type="number" placeholder="Pax"></div>
      <input class="input" id="newTableSection" placeholder="Section" value="Dining" style="margin-top:8px">
      <button class="btn secondary block" onclick="addTable()">Add Table</button>
      <label class="label">Add Staff</label>
      <input class="input" id="staffName" placeholder="Staff name">
      <div class="grid2"><input class="input" id="staffUsername" placeholder="Username"><select class="select" id="staffRole"><option>STAFF</option><option>OWNER</option></select></div>
      <input class="input" id="staffPassword" type="password" placeholder="Password, 6+ chars" style="margin-top:8px">
      <button class="btn dark block" onclick="addUser()">Add Staff</button>
    </div>` : '<div class="panel"><h1 class="title">Manage</h1><div class="sub">Owner login required.</div></div>'}
    <button class="btn secondary block" onclick="logout()">Logout</button>
    ${messages()}
  </main>`
}

function messages() {
  return `${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}${state.message ? `<div class="success">${escapeHtml(state.message)}</div>` : ''}`
}

function shell(content) {
  return `<div class="app"><header class="topbar"><div class="brand"><b>${escapeHtml(state.status?.restaurant?.name || 'Mobile POS')}</b><span>${escapeHtml(state.user?.name || '')}</span></div><button class="pill" onclick="logout()">Logout</button></header>${content}<nav class="tabs">${[
    ['tables','Tables'], ['order','Order'], ['kots','KOT'], ['bills','Bills'], ['report','Report'], ['manage','Manage']
  ].map(([key,label]) => `<button class="tab ${state.tab === key ? 'active' : ''}" onclick="state.tab='${key}';render()">${label}</button>`).join('')}</nav></div>`
}

function render() {
  if (!state.status) { app.innerHTML = '<main class="screen"><div class="panel">Loading...</div></main>'; return }
  if (!state.status.setupComplete) { app.innerHTML = setupView(); return }
  if (!state.user) { app.innerHTML = loginView(); return }
  const views = { tables: tablesView, order: orderView, kots: () => listView('kots'), bills: () => listView('bills'), report: reportView, manage: manageView }
  app.innerHTML = shell((views[state.tab] || orderView)())
}

Object.assign(window, { state, render, setupOwner, login, logout, addItemById, changeQty, addCustomItem, sendKot, makeBill, printLast, printDoc, receiptFor, addMenuItem, addTable, addUser, downloadExport, selectTable, saveTableOrder, setMeta })
boot()

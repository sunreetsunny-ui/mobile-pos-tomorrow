const $ = (sel) => document.querySelector(sel)
const app = $('#app')

const emptyMeta = () => ({ table: '', customerName: '', paymentMethod: 'Cash', paidAmount: '', note: '' })

const state = {
  status: null,
  user: null,
  csrfToken: sessionStorage.getItem('csrfToken') || '',
  menu: [],
  categories: [],
  category: 'All',
  tables: [],
  selectedTableId: '',
  orderMeta: emptyMeta(),
  cart: [],
  menuSearch: '',
  recentKots: [],
  recentBills: [],
  today: { billCount: 0, totalPaise: 0, bills: [] },
  lastBill: null,
  lastDoc: null,
  orderUnlockPass: '',
  printer: JSON.parse(localStorage.getItem('printerSetup') || '{"paper":"80","autoPrint":true,"copies":1}'),
  tab: 'tables',
  lastPrintable: '',
  message: '',
  error: '',
}

const money = (paise = 0) => `\u20b9${(Number(paise || 0) / 100).toFixed(2)}`
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

async function loadToday() {
  try {
    state.today = await api('/api/reports/today')
  } catch {
    state.today = { billCount: 0, totalPaise: 0, bills: [] }
  }
}

async function loadStartupData() {
  await Promise.all([loadMenu(), loadTables(), loadToday()])
}

function totals(items = state.cart) {
  const subtotal = items.reduce((sum, item) => sum + item.pricePaise * item.quantity, 0)
  const tax = items.reduce((sum, item) => sum + Math.round(item.pricePaise * item.quantity * (item.taxBps || 0) / 10000), 0)
  return { subtotal, tax, total: subtotal + tax, count: items.reduce((sum, item) => sum + item.quantity, 0) }
}

function floorStats() {
  const occupied = state.tables.filter(table => table.status === 'occupied')
  return {
    total: state.tables.length,
    occupied: occupied.length,
    available: state.tables.length - occupied.length,
    printed: occupied.filter(table => table.pendingPrintedBillId).length,
  }
}

function canSeeSales() {
  return ['OWNER', 'MANAGER'].includes(state.user?.role)
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

function lockedQty(item) {
  return Math.min(Number(item.kotPrintedQty || 0), Number(item.quantity || 0))
}

function requestKotUnlock() {
  const pass = window.prompt('KOT printed item locked. Enter passcode.')
  if (pass !== '8199') {
    setMsg('', 'Wrong passcode')
    return false
  }
  state.orderUnlockPass = pass
  return true
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

function setMenuSearch(value) {
  state.menuSearch = value
  const input = $('#menuSearch')
  if (input && input.value !== value) input.value = value
  const target = $('#menuResults')
  if (target) target.innerHTML = menuResultsHtml()
}

function addItemById(itemId) {
  const item = state.menu.find(entry => entry.id === itemId)
  if (item) addItem(item)
}

function changeQty(index, delta) {
  const line = state.cart[index]
  if (!line) return
  if (delta < 0 && line.quantity <= lockedQty(line) && !requestKotUnlock()) return
  line.quantity += delta
  if (line.quantity <= 0) state.cart.splice(index, 1)
  render()
}

function clearCart() {
  if (state.cart.some(line => lockedQty(line) > 0) && !requestKotUnlock()) return
  state.cart = []
  state.lastBill = null
  render()
}

function openParcel() {
  state.selectedTableId = ''
  state.orderMeta = { ...emptyMeta(), table: 'Parcel' }
  state.cart = []
  state.lastBill = null
  state.tab = 'order'
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
    state.orderMeta = { ...state.orderMeta, table: res.table.name }
    state.cart = (res.order?.items || []).map(item => ({ ...item }))
    state.lastBill = null
    state.orderUnlockPass = ''
    state.tab = 'order'
    setMsg('')
  } catch (e) { setMsg('', e.message) }
}

async function saveTableOrder(silent = false) {
  if (!state.selectedTableId) return setMsg('', 'Select a table first')
  try {
    await api(`/api/tables/${encodeURIComponent(state.selectedTableId)}/order`, {
      method: 'PUT',
      body: JSON.stringify({ items: state.cart.map(itemPayload), passcode: state.orderUnlockPass }),
    })
    state.orderUnlockPass = ''
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
    const total = item.totalPaise || item.pricePaise * qty
    lines.push(`${qty} x ${item.name}`)
    lines.push(`    ${money(total)}`)
    if (item.reason) lines.push(`    custom: ${item.reason}`)
  }
  if (doc.totals) {
    lines.push('------------------------------')
    lines.push(`Subtotal ${money(doc.totals.subtotalPaise)}`)
    if (state.status?.restaurant?.gstNumber && Number(state.status?.restaurant?.gstBps || 0) > 0) {
      lines.push(`GSTIN    ${state.status.restaurant.gstNumber}`)
      lines.push(`GST      ${money(doc.totals.taxPaise)}`)
    }
    lines.push(`Total    ${money(doc.totals.grandTotalPaise)}`)
    lines.push(`Paid     ${money(doc.paidPaise)}`)
    lines.push(`Balance  ${money(doc.balancePaise)}`)
  }
  return lines.join('\n')
}

async function sendKot(mode = 'NEW') {
  try {
    if (!state.cart.length) throw new Error('Add at least one item before KOT')
    const table = state.orderMeta.table.trim()
    const note = state.orderMeta.note.trim()
    const res = await api('/api/kot', { method: 'POST', body: JSON.stringify({ tableId: state.selectedTableId || undefined, table, note, mode, passcode: state.orderUnlockPass, items: state.cart.map(itemPayload) }) })
    state.orderUnlockPass = ''
    if (state.selectedTableId) await loadTables()
    state.lastPrintable = receiptFor('KOT', res.kot)
    state.lastDoc = { kind: 'KOT', id: res.kot.id }
    if (state.selectedTableId) {
      const fresh = await api(`/api/tables/${encodeURIComponent(state.selectedTableId)}/order`)
      state.cart = (fresh.order?.items || []).map(item => ({ ...item }))
    }
    setMsg(`${mode === 'FULL' ? 'Full KOT' : 'KOT'} ${res.kot.number} saved`)
  } catch (e) { setMsg('', e.message) }
}

async function makeBill() {
  try {
    if (!state.cart.length) throw new Error('Add at least one item before bill')
    const table = state.orderMeta.table.trim()
    const customerName = state.orderMeta.customerName.trim()
    const paymentMethod = state.orderMeta.paymentMethod
    const paidAmount = state.orderMeta.paidAmount || (totals().total / 100)
    const res = await api('/api/bill', { method: 'POST', body: JSON.stringify({ tableId: state.selectedTableId || undefined, table, customerName, paymentMethod, paidAmount, passcode: state.orderUnlockPass, items: state.cart.map(itemPayload) }) })
    state.orderUnlockPass = ''
    state.lastPrintable = receiptFor('BILL', res.bill)
    state.lastBill = res.bill
    state.lastDoc = { kind: 'BILL', id: res.bill.id }
    if (state.selectedTableId) {
      const fresh = await api(`/api/tables/${encodeURIComponent(state.selectedTableId)}/order`)
      state.cart = (fresh.order?.items || []).map(item => ({ ...item }))
    }
    await loadTables()
    await loadToday()
    setMsg(`Bill ${res.bill.number} saved${res.autoKot ? `; auto KOT ${res.autoKot.number} registered` : ''}`)
    if (state.printer.autoPrint) setTimeout(printLast, 80)
  } catch (e) { setMsg('', e.message) }
}

async function clearAfterBill() {
  try {
    if (state.selectedTableId) {
      await api(`/api/tables/${encodeURIComponent(state.selectedTableId)}/clear`, { method: 'POST' })
    }
    state.cart = []
    state.selectedTableId = ''
    state.orderMeta = emptyMeta()
    state.lastBill = null
    await loadTables()
    setMsg('Order cleared after bill print')
    state.tab = 'tables'
  } catch (e) { setMsg('', e.message) }
}

async function clearTableFromFloor(tableId, tableName) {
  if (!window.confirm(`Clear ${tableName}? Do this only after bill is printed.`)) return
  try {
    await api(`/api/tables/${encodeURIComponent(tableId)}/clear`, { method: 'POST' })
    if (state.selectedTableId === tableId) {
      state.selectedTableId = ''
      state.cart = []
      state.orderMeta = emptyMeta()
      state.lastBill = null
    }
    await loadTables()
    setMsg(`${tableName} cleared`)
  } catch (e) { setMsg('', e.message) }
}

async function logPrint(kind, id) {
  if (!kind || !id) return true
  try {
    await api('/api/prints', { method: 'POST', body: JSON.stringify({ kind, id }) })
    await loadTables()
    await loadToday()
    return true
  } catch (e) {
    state.error = e.message
    render()
    return false
  }
}

async function printLast() {
  if (!state.lastPrintable) return setMsg('', 'Nothing to print yet')
  if (!await logPrint(state.lastDoc?.kind, state.lastDoc?.id)) return
  const box = $('#printBox')
  box.textContent = state.lastPrintable
  box.classList.add('printable')
  window.print()
}

function printDoc(kind, id) {
  const doc = (kind === 'KOT' ? state.recentKots : state.recentBills).find(entry => entry.id === id)
  if (!doc) return setMsg('', 'Document not found')
  state.lastPrintable = receiptFor(kind, doc)
  state.lastDoc = { kind, id: doc.id }
  render()
  setTimeout(printLast, 50)
}

async function printBillById(id) {
  try {
    const res = await api(`/api/bills/${encodeURIComponent(id)}`)
    state.lastPrintable = receiptFor('BILL', res.bill)
    state.lastDoc = { kind: 'BILL', id: res.bill.id }
    render()
    setTimeout(printLast, 50)
  } catch (e) { setMsg('', e.message) }
}

function savePrinterSetup() {
  state.printer = {
    paper: $('#printerPaper').value,
    autoPrint: $('#printerAutoPrint').checked,
    copies: Math.max(1, Math.min(3, Math.trunc(Number($('#printerCopies').value || 1)))),
  }
  localStorage.setItem('printerSetup', JSON.stringify(state.printer))
  setMsg('Printer setup saved')
}

function testPrint() {
  state.lastDoc = null
  state.lastPrintable = [
    state.status?.restaurant?.name || 'Restaurant',
    'PRINTER TEST',
    `Paper: ${state.printer.paper}mm`,
    `Time: ${new Date().toLocaleString()}`,
    '------------------------------',
    'If this prints clearly, setup is ready.',
  ].join('\n')
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
  state.orderMeta = emptyMeta()
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

async function saveGstSetup() {
  try {
    const res = await api('/api/restaurant', {
      method: 'PUT',
      body: JSON.stringify({
        gstNumber: $('#gstNumber').value.trim(),
        gstBps: Number($('#gstPercent').value || 0) * 100,
      }),
    })
    state.status.restaurant = res.restaurant
    setMsg('GST setup saved')
  } catch (e) { setMsg('', e.message) }
}

async function renderReport() {
  try {
    const report = await api('/api/reports/today')
    state.today = report
    $('#reportBox').innerHTML = `
      <div class="statGrid">
        <div class="stat"><span>Bills</span><b>${report.billCount}</b></div>
        <div class="stat"><span>Sales</span><b>${money(report.totalPaise)}</b></div>
        <div class="stat"><span>Prints</span><b>${report.printCount || 0}</b></div>
        <div class="stat"><span>Reprints</span><b>${report.reprintCount || 0}</b></div>
      </div>
      ${state.user?.role === 'OWNER' ? '<button class="btn dark block" onclick="renderTheftReport()">Anti Theft</button>' : ''}
      <div class="panel">
        <b>Reprints</b>
        ${(report.reprintEvents || []).slice().reverse().map(p => `<div class="listrow"><b>${escapeHtml(p.docNumber)}</b><div class="meta">${escapeHtml(p.docKind)} - ${escapeHtml(p.table || 'No table')} - ${new Date(p.at).toLocaleTimeString()}</div></div>`).join('') || '<div class="sub">No reprints yet.</div>'}
      </div>
      <div class="panel">
        <b>Today Bills</b>
        ${(report.bills || []).slice().reverse().map(b => `<div class="listrow"><b>${escapeHtml(b.number)}</b><div class="meta">${escapeHtml(b.paymentMethod)} - ${money(b.totals.grandTotalPaise)} - ${new Date(b.createdAt).toLocaleTimeString()}</div></div>`).join('') || '<div class="sub">No bills yet.</div>'}
      </div>`
  } catch (e) { $('#reportBox').innerHTML = `<div class="error">${escapeHtml(e.message)}</div>` }
}

async function renderTheftReport() {
  try {
    const report = await api('/api/reports/theft')
    $('#reportBox').innerHTML = `
      <div class="command"><div><h1 class="title">Anti Theft</h1><div class="sub">Owner-only suspicious activity checks.</div></div><button class="btn secondary compact" onclick="renderReport()">Sales</button></div>
      <div class="statGrid">
        <div class="stat"><span>Reprints</span><b>${report.summary.reprints}</b></div>
        <div class="stat"><span>Bill Reprint</span><b>${report.summary.billReprints}</b></div>
        <div class="stat"><span>KOT Reprint</span><b>${report.summary.kotReprints}</b></div>
        <div class="stat"><span>Custom</span><b>${report.summary.customItems}</b></div>
      </div>
      <div class="panel"><b>Reprints</b>${(report.reprints || []).slice().reverse().map(p => `<div class="listrow"><b>${escapeHtml(p.docNumber)}</b><div class="meta">${escapeHtml(p.docKind)} - ${escapeHtml(p.table || 'No table')} - ${escapeHtml(p.staff)} - ${new Date(p.at).toLocaleTimeString()}</div></div>`).join('') || '<div class="sub">No reprints.</div>'}</div>
      <div class="panel"><b>Custom Items</b>${(report.customItems || []).map(i => `<div class="listrow"><b>${escapeHtml(i.name)}</b><div class="meta">${escapeHtml(i.bill)} - ${escapeHtml(i.table || 'No table')} - ${money(i.amountPaise)}</div></div>`).join('') || '<div class="sub">No custom items.</div>'}</div>
      <div class="panel"><b>Changes</b>${(report.orderChanges || []).slice().reverse().map(e => `<div class="listrow"><b>${escapeHtml(e.action)}</b><div class="meta">${escapeHtml(e.actorName || '')} - ${new Date(e.at).toLocaleTimeString()}</div></div>`).join('') || '<div class="sub">No changes.</div>'}</div>`
  } catch (e) { $('#reportBox').innerHTML = `<div class="error">${escapeHtml(e.message)}</div>` }
}

async function downloadExport() {
  try {
    const exportData = await api('/api/export')
    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `mobile-pos-export-${new Date().toISOString().slice(0, 10)}.json`
    a.click()
    URL.revokeObjectURL(url)
  } catch (e) { setMsg('', e.message) }
}

function setupView() {
  return `<main class="screen authScreen">
    <div class="panel">
      <h1 class="title">Set Up POS</h1>
      <div class="sub">Create owner login and restaurant profile. After this the phone becomes your counter POS.</div>
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
  return `<main class="screen authScreen">
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
  const stats = floorStats()
  const busy = stats.total ? Math.round((stats.occupied / stats.total) * 100) : 0
  return `<main class="screen">
    <div class="command">
      <div>
        <h1 class="title">Table Floor</h1>
        <div class="sub">Tap table, punch items, send KOT, then settle bill.</div>
      </div>
      <button class="btn secondary compact" onclick="openParcel()">Parcel</button>
    </div>
    <div class="statGrid">
      <div class="stat"><span>Occupied</span><b>${stats.occupied}/${stats.total}</b></div>
      <div class="stat"><span>Available</span><b>${stats.available}</b></div>
      <div class="stat"><span>Running</span><b>${stats.occupied}</b></div>
      <div class="stat"><span>Printed</span><b>${stats.printed}</b></div>
    </div>
    <div class="floorMeter"><span style="width:${busy}%"></span></div>
    ${sections.map(section => `
      <div class="sectionBar"><b>${escapeHtml(section)}</b><span>${state.tables.filter(t => (t.section || 'Dining') === section && t.status === 'occupied').length} running</span></div>
      <div class="tableGrid">
        ${state.tables.filter(t => (t.section || 'Dining') === section).map(table => `
          <div class="tableCard ${table.status}" onclick="selectTable('${escapeHtml(table.id)}')" role="button" tabindex="0">
            <span class="badge">${table.status === 'occupied' ? 'RUNNING' : 'FREE'}</span>
            <b>${escapeHtml(table.name)}</b>
            <span>${table.capacity ? `${table.capacity} pax` : 'Dining'}</span>
            ${table.status === 'occupied' ? `<strong>${table.itemCount} items${table.pendingPrintedBillNumber ? `<br>Printed ${escapeHtml(table.pendingPrintedBillNumber)}` : ''}</strong>` : '<em>Open order</em>'}
            ${table.status === 'occupied' ? `<div class="tableActions"><button class="miniBtn" onclick="event.stopPropagation();${table.pendingPrintedBillId ? `printBillById('${escapeHtml(table.pendingPrintedBillId)}')` : `selectTable('${escapeHtml(table.id)}')`}">${table.pendingPrintedBillId ? 'Reprint' : 'Print Bill'}</button>${table.pendingPrintedBillId ? `<button class="miniBtn danger" onclick="event.stopPropagation();clearTableFromFloor('${escapeHtml(table.id)}','${escapeHtml(table.name)}')">Clear</button>` : ''}</div>` : ''}
          </div>
        `).join('')}
      </div>
    `).join('')}
    ${messages()}
  </main>`
}

function visibleMenuItems() {
  const query = state.menuSearch.trim().toLowerCase()
  return state.menu.filter(item => {
    const categoryOk = state.category === 'All' || item.category === state.category
    const queryOk = !query || `${item.name} ${item.category}`.toLowerCase().includes(query)
    return (query || state.category !== 'All') && categoryOk && queryOk
  })
}

function menuResultsHtml() {
  const query = state.menuSearch.trim()
  const visible = visibleMenuItems()
  return visible.slice(0, 40).map(item => `<button class="item" onclick="addItemById('${escapeHtml(item.id)}')"><b>${escapeHtml(item.name)}</b><span>${escapeHtml(item.category)}</span><strong>${money(item.pricePaise)}</strong></button>`).join('') || `<div class="notice">${query ? 'No menu item found.' : 'Search item name or pick a category.'}</div>`
}

function orderView() {
  const t = totals()
  const selected = state.tables.find(table => table.id === state.selectedTableId)
  return `<main class="screen">
    <div class="billHead">
      <div>
        <div class="kicker">${selected ? 'DINE-IN' : 'PARCEL / DIRECT'}</div>
        <h1 class="title">${selected ? escapeHtml(selected.name) : escapeHtml(state.orderMeta.table || 'No table')}</h1>
        <div class="sub">${t.count} items - ${money(t.total)}</div>
      </div>
      <button class="btn secondary compact" onclick="state.tab='tables';render()">Tables</button>
    </div>
    <div class="ticketPanel">
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
    <div class="searchBox">
      <input class="input searchInput" id="menuSearch" placeholder="Search menu item..." value="${escapeHtml(state.menuSearch)}" oninput="setMenuSearch(this.value)" autocomplete="off">
      <button class="linkBtn" onclick="setMenuSearch('')">Clear</button>
    </div>
    <div class="posGrid">
      <aside class="categoryRail">${state.categories.map(c => `<button class="railBtn ${c === state.category ? 'active' : ''}" onclick="state.category='${escapeHtml(c)}';render()">${escapeHtml(c)}</button>`).join('')}</aside>
      <section class="menuGrid" id="menuResults">${menuResultsHtml()}</section>
    </div>
    <details class="customBox">
      <summary>Custom item / open food</summary>
      <input class="input" id="customName" placeholder="Name" style="margin-top:8px">
      <div class="grid2"><input class="input" id="customPrice" type="number" placeholder="Price"><input class="input" id="customReason" placeholder="Reason"></div>
      <button class="btn secondary block" onclick="addCustomItem()">Add Custom Item</button>
    </details>
    ${cartView()}
    ${postPrintActions()}
    ${state.lastPrintable ? `<div class="panel"><button class="btn dark block" onclick="printLast()">Reprint Last KOT/Bill</button><pre id="printBox" class="receipt receipt${escapeHtml(state.printer.paper)}">${escapeHtml(state.lastPrintable)}</pre></div>` : '<pre id="printBox" class="receipt hide"></pre>'}
    ${messages()}
    ${state.cart.length && !state.lastBill ? `<div class="cartbar"><div class="total">${t.count} items<br>${money(t.total)}</div>${state.selectedTableId ? '<button class="btn secondary" onclick="saveTableOrder()">Save</button>' : ''}<button class="btn secondary" onclick="sendKot('NEW')">KOT</button><button class="btn good" onclick="makeBill()">Bill</button></div>` : ''}
  </main>`
}

function postPrintActions() {
  if (!state.lastBill) return ''
  return `<div class="panel actionPanel">
    <b>${escapeHtml(state.lastBill.number)} printed?</b>
    <div class="sub">Reprint if needed. Table clear action is now on Floor tab.</div>
    <div class="actionRow">
      <button class="btn secondary" onclick="printLast()">Reprint</button>
      <button class="btn good" onclick="state.tab='tables';render()">Floor</button>
    </div>
  </div>`
}

function cartView() {
  if (!state.cart.length) return '<div class="notice">Cart is empty. Tap menu items to add them.</div>'
  const t = totals()
  return `<div class="cartPanel">
    <div class="cartTitle"><b>Current Ticket</b><button class="linkBtn" onclick="clearCart()">Clear</button></div>
    ${state.cart.map((line, i) => `<div class="cartline"><div><b>${escapeHtml(line.name)}</b><div class="meta">${money(line.pricePaise)} each${line.reason ? ` - ${escapeHtml(line.reason)}` : ''}${lockedQty(line) ? ` - Locked ${lockedQty(line)} KOT` : ''}</div></div><div class="qty"><button onclick="changeQty(${i},-1)">-</button><b>${line.quantity}</b><button onclick="changeQty(${i},1)">+</button></div></div>`).join('')}
    <div class="totals">
      <span>Subtotal <b>${money(t.subtotal)}</b></span>
      <span>Tax <b>${money(t.tax)}</b></span>
      <strong>Total <b>${money(t.total)}</b></strong>
    </div>
  </div>`
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
      $(`#${kind}Box`).innerHTML = docs.map(d => `<div class="docrow"><div class="docTop"><div><b>${escapeHtml(d.number)}</b><div class="meta">${escapeHtml(d.table || 'No table')} - ${escapeHtml(d.staff)} - ${new Date(d.createdAt).toLocaleString()} - Reprint ${d.reprintCount || 0}</div></div><button class="btn secondary" onclick="printDoc('${label}','${escapeHtml(d.id)}')">Print</button></div><div class="docItems">${(d.items || []).map(item => `<span>${item.quantity || 1} x ${escapeHtml(item.name)}</span>`).join('')}</div>${d.totals ? `<div class="docTotal">Total ${money(d.totals.grandTotalPaise)}</div>` : ''}</div>`).join('') || '<div class="sub">Nothing yet.</div>'
    } catch (e) { $(`#${kind}Box`).innerHTML = `<div class="error">${escapeHtml(e.message)}</div>` }
  }, 0)
  return `<main class="screen"><div class="command"><div><h1 class="title">${kind === 'kots' ? 'KOTs' : 'Bills'}</h1><div class="sub">Recent printable records.</div></div></div><div class="panel"><div id="${kind}Box" class="sub">Loading...</div></div><pre id="printBox" class="receipt hide"></pre></main>`
}

function reportView() {
  if (!canSeeSales()) return `<main class="screen"><div class="panel"><h1 class="title">Reports</h1><div class="sub">Owner or manager access required.</div></div>${messages()}</main>`
  setTimeout(renderReport, 0)
  return `<main class="screen"><div class="command"><div><h1 class="title">Reports</h1><div class="sub">Today sales and reprints.</div></div>${state.user?.role === 'OWNER' ? '<button class="btn secondary compact" onclick="downloadExport()">Backup</button>' : ''}</div><div id="reportBox"></div>${messages()}</main>`
}

function manageView() {
  const ownerOnly = state.user?.role === 'OWNER'
  const sections = [...new Set(state.tables.map(t => t.section || 'Dining'))]
  return `<main class="screen">
    <div class="command"><div><h1 class="title">Setup</h1><div class="sub">${state.menu.length} menu items - ${state.tables.length} tables - ${sections.length} sections</div></div></div>
    ${ownerOnly ? `<div class="panel">
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
      <div class="grid2"><input class="input" id="staffUsername" placeholder="Username"><select class="select" id="staffRole"><option>STAFF</option><option>MANAGER</option><option>OWNER</option></select></div>
      <input class="input" id="staffPassword" type="password" placeholder="Password, 6+ chars" style="margin-top:8px">
      <button class="btn dark block" onclick="addUser()">Add Staff</button>
      <label class="label">GST Setup</label>
      <div class="printerBox">
        <input class="input" id="gstNumber" placeholder="GST number" value="${escapeHtml(state.status?.restaurant?.gstNumber || '')}">
        <input class="input" id="gstPercent" type="number" min="0" step="0.01" placeholder="GST %" value="${escapeHtml((Number(state.status?.restaurant?.gstBps || 0) / 100).toString())}">
        <button class="btn secondary block" onclick="saveGstSetup()">Save GST</button>
        <div class="sub">If GST number is blank or GST is 0, GST will not show on bills and new bills will not charge tax.</div>
      </div>
      <label class="label">Printer Setup</label>
      <div class="printerBox">
        <select class="select" id="printerPaper">
          <option value="80" ${state.printer.paper === '80' ? 'selected' : ''}>80mm receipt</option>
          <option value="58" ${state.printer.paper === '58' ? 'selected' : ''}>58mm receipt</option>
          <option value="A4" ${state.printer.paper === 'A4' ? 'selected' : ''}>A4 / normal printer</option>
        </select>
        <div class="grid2">
          <label class="checkLine"><input type="checkbox" id="printerAutoPrint" ${state.printer.autoPrint ? 'checked' : ''}> Auto print bill</label>
          <input class="input" id="printerCopies" type="number" min="1" max="3" value="${escapeHtml(state.printer.copies || 1)}" placeholder="Copies">
        </div>
        <button class="btn secondary block" onclick="savePrinterSetup()">Save Printer</button>
        <button class="btn dark block" onclick="testPrint()">Test Print</button>
        <div class="sub">Mobile will open the phone/browser print dialog. Select your Bluetooth/Wi-Fi printer there.</div>
      </div>
      <label class="label">Current Tables</label>
      <div class="miniList">${state.tables.map(table => `<span>${escapeHtml(table.name)} - ${escapeHtml(table.section || 'Dining')}</span>`).join('')}</div>
    </div>` : '<div class="panel"><h1 class="title">Setup</h1><div class="sub">Owner login required.</div></div>'}
    <button class="btn secondary block" onclick="logout()">Logout</button>
    ${messages()}
  </main>`
}

function messages() {
  return `${state.error ? `<div class="error">${escapeHtml(state.error)}</div>` : ''}${state.message ? `<div class="success">${escapeHtml(state.message)}</div>` : ''}`
}

function shell(content) {
  const nav = [
    ['tables', 'Floor'], ['order', 'Bill'], ['kots', 'KOT'], ['bills', 'Bills'],
    ...(canSeeSales() ? [['report', 'Report']] : []),
    ['manage', 'Setup'],
  ]
  return `<div class="app"><header class="topbar"><div class="brand"><b>${escapeHtml(state.status?.restaurant?.name || 'Mobile POS')}</b><span>${escapeHtml(state.user?.name || '')} - ${new Date().toLocaleDateString()}</span></div><button class="pill" onclick="logout()">Logout</button></header>${content}<nav class="tabs">${[
  ].concat(nav).map(([key, label]) => `<button class="tab ${state.tab === key ? 'active' : ''}" onclick="state.tab='${key}';render()">${label}</button>`).join('')}</nav></div>`
}

function render() {
  if (!state.status) { app.innerHTML = '<main class="screen"><div class="panel">Loading...</div></main>'; return }
  if (!state.status.setupComplete) { app.innerHTML = setupView(); return }
  if (!state.user) { app.innerHTML = loginView(); return }
  if (state.tab === 'report' && !canSeeSales()) state.tab = 'tables'
  const views = { tables: tablesView, order: orderView, kots: () => listView('kots'), bills: () => listView('bills'), report: reportView, manage: manageView }
  app.innerHTML = shell((views[state.tab] || orderView)())
}

Object.assign(window, { state, render, setupOwner, login, logout, addItemById, changeQty, addCustomItem, sendKot, makeBill, printLast, printDoc, printBillById, receiptFor, addMenuItem, addTable, addUser, downloadExport, selectTable, saveTableOrder, setMeta, setMenuSearch, openParcel, clearCart, clearAfterBill, clearTableFromFloor, savePrinterSetup, testPrint, saveGstSetup, renderTheftReport, renderReport })
boot()

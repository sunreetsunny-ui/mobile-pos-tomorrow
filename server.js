const http = require('http')
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

const PORT = Number(process.env.PORT || 8080)
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data')
const DATA_FILE = path.join(DATA_DIR, 'pos.json')
const PUBLIC_DIR = path.join(__dirname, 'public')
const SESSION_TTL_MS = 12 * 60 * 60 * 1000
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

const sessions = new Map()
const loginFailures = new Map()

function nowIso() { return new Date().toISOString() }
function id(prefix) { return `${prefix}_${crypto.randomUUID()}` }

function defaultData() {
  return {
    setupComplete: false,
    restaurant: { name: '', outlet: '', phone: '', address: '', currency: 'INR', timezone: 'Asia/Kolkata' },
    users: [],
    tables: seedTables(),
    runningOrders: [],
    menu: seedMenu(),
    orders: [],
    kots: [],
    bills: [],
    audit: [],
    sequences: { kot: 0, invoice: 0 },
  }
}

function seedTables() {
  return [
    { id: id('table'), name: 'T-1', capacity: 2, section: 'Dining', active: true },
    { id: id('table'), name: 'T-2', capacity: 4, section: 'Dining', active: true },
    { id: id('table'), name: 'T-3', capacity: 4, section: 'Dining', active: true },
    { id: id('table'), name: 'T-4', capacity: 6, section: 'Dining', active: true },
    { id: id('table'), name: 'Parcel', capacity: 0, section: 'Takeaway', active: true },
  ]
}

function seedMenu() {
  const seedFile = path.join(__dirname, 'menu-seed.json')
  if (fs.existsSync(seedFile)) return JSON.parse(fs.readFileSync(seedFile, 'utf8'))
  return []
}

function loadData() {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  if (!fs.existsSync(DATA_FILE)) {
    const data = defaultData()
    saveData(data)
    return data
  }
  const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
  if (!Array.isArray(data.tables)) data.tables = seedTables()
  if (!Array.isArray(data.runningOrders)) data.runningOrders = []
  if (!data.sequences) data.sequences = { kot: 0, invoice: 0 }
  return data
}

function saveData(data) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const tmp = `${DATA_FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2))
  fs.renameSync(tmp, DATA_FILE)
}

function audit(data, actor, action, details = {}) {
  const previous = data.audit.at(-1)
  const event = {
    id: id('audit'),
    at: nowIso(),
    actorId: actor && actor.id,
    actorName: actor && actor.name,
    action,
    details,
    previousHash: previous ? previous.hash : null,
  }
  event.hash = crypto.createHash('sha256').update(JSON.stringify(event)).digest('hex')
  data.audit.push(event)
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex')
  const key = await new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, 64, { N: 16384, r: 8, p: 1 }, (err, derived) => err ? reject(err) : resolve(derived))
  })
  return `scrypt$${salt}$${key.toString('hex')}`
}

async function verifyPassword(stored, password) {
  const [scheme, salt, expectedHex] = String(stored || '').split('$')
  if (scheme !== 'scrypt' || !salt || !expectedHex) return false
  const actual = await new Promise((resolve, reject) => {
    crypto.scrypt(String(password), salt, 64, { N: 16384, r: 8, p: 1 }, (err, derived) => err ? reject(err) : resolve(derived))
  })
  const expected = Buffer.from(expectedHex, 'hex')
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual)
}

function paise(value) {
  const n = Number(value)
  if (!Number.isFinite(n)) return 0
  return Math.round(n * 100)
}

function rupees(paiseValue) {
  return (Number(paiseValue || 0) / 100).toFixed(2)
}

function calculateTotals(items, discountPaise = 0) {
  const lines = items.map((item) => {
    const quantity = Math.max(1, Math.trunc(Number(item.quantity || 1)))
    const pricePaise = Math.max(0, Math.trunc(Number(item.pricePaise || 0)))
    const taxBps = Math.max(0, Math.min(10000, Math.trunc(Number(item.taxBps || 0))))
    const subtotalPaise = pricePaise * quantity
    const taxPaise = Math.round(subtotalPaise * taxBps / 10000)
    return { ...item, quantity, pricePaise, taxBps, subtotalPaise, taxPaise, totalPaise: subtotalPaise + taxPaise }
  })
  const subtotalPaise = lines.reduce((sum, line) => sum + line.subtotalPaise, 0)
  const taxPaise = lines.reduce((sum, line) => sum + line.taxPaise, 0)
  const cappedDiscountPaise = Math.min(Math.max(0, Math.trunc(Number(discountPaise || 0))), subtotalPaise + taxPaise)
  return { lines, subtotalPaise, taxPaise, discountPaise: cappedDiscountPaise, grandTotalPaise: subtotalPaise + taxPaise - cappedDiscountPaise }
}

function parseCookies(req) {
  return String(req.headers.cookie || '').split(';').map(x => x.trim()).filter(Boolean).reduce((acc, item) => {
    const i = item.indexOf('=')
    if (i > 0) acc[decodeURIComponent(item.slice(0, i))] = decodeURIComponent(item.slice(i + 1))
    return acc
  }, {})
}

function send(res, status, body, headers = {}) {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers })
  res.end(payload)
}

function publicUser(user) {
  return user && { id: user.id, name: user.name, username: user.username, role: user.role }
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.on('data', chunk => {
      body += chunk
      if (body.length > 1_000_000) reject(new Error('Request too large'))
    })
    req.on('end', () => {
      if (!body) return resolve({})
      try { resolve(JSON.parse(body)) } catch { reject(new Error('Invalid JSON')) }
    })
  })
}

function currentUser(req, data) {
  const session = currentSession(req)
  if (!session) return null
  return data.users.find(u => u.id === session.userId && !u.disabled) || null
}

function currentSession(req) {
  const token = parseCookies(req).pos_session
  const session = token && sessions.get(token)
  if (!session || Date.now() > session.expiresAt) {
    if (token) sessions.delete(token)
    return null
  }
  return session
}

function setSessionCookie(req, token) {
  const secure = String(req.headers['x-forwarded-proto'] || '').includes('https') || process.env.COOKIE_SECURE === '1'
  return `pos_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure ? '; Secure' : ''}`
}

function requireUser(req, res, data) {
  const user = currentUser(req, data)
  if (!user) {
    send(res, 401, { error: 'Login required' })
    return null
  }
  return user
}

function requireOwner(req, res, data) {
  const user = requireUser(req, res, data)
  if (!user) return null
  if (user.role !== 'OWNER') {
    send(res, 403, { error: 'Owner access required' })
    return null
  }
  return user
}

function requireCsrf(req, res) {
  if (SAFE_METHODS.has(req.method)) return true
  const session = currentSession(req)
  const supplied = String(req.headers['x-csrf-token'] || '')
  if (!session || !session.csrfToken || !supplied) {
    send(res, 403, { error: 'Invalid CSRF token' })
    return false
  }
  const a = Buffer.from(supplied)
  const b = Buffer.from(session.csrfToken)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    send(res, 403, { error: 'Invalid CSRF token' })
    return false
  }
  return true
}

function loginKey(req, username) {
  return `${req.socket.remoteAddress || 'unknown'}:${String(username || '').toLowerCase().trim()}`
}

function isLocked(key) {
  const item = loginFailures.get(key)
  if (!item) return false
  if (item.lockedUntil && Date.now() < item.lockedUntil) return true
  if (item.lockedUntil) loginFailures.delete(key)
  return false
}

function recordBadLogin(key) {
  const item = loginFailures.get(key) || { count: 0, lockedUntil: 0 }
  item.count += 1
  if (item.count >= 5) {
    item.count = 0
    item.lockedUntil = Date.now() + 2 * 60 * 1000
  }
  loginFailures.set(key, item)
}

function safeItemFromMenu(data, input) {
  if (input.type === 'CUSTOM_ITEM') {
    if (!String(input.name || '').trim()) throw new Error('Custom item name required')
    if (!String(input.reason || '').trim()) throw new Error('Custom item reason required')
    return {
      id: id('custom'),
      type: 'CUSTOM_ITEM',
      name: String(input.name).trim().slice(0, 80),
      reason: String(input.reason).trim().slice(0, 160),
      pricePaise: Math.max(0, Math.trunc(Number(input.pricePaise || 0))),
      taxBps: Math.max(0, Math.min(10000, Math.trunc(Number(input.taxBps || 500)))),
      quantity: Math.max(1, Math.trunc(Number(input.quantity || 1))),
    }
  }
  const menuItem = data.menu.find(item => item.id === input.menuItemId && item.active)
  if (!menuItem) throw new Error('Menu item not found')
  return {
    id: menuItem.id,
    type: 'MENU_ITEM',
    name: menuItem.name,
    category: menuItem.category,
    pricePaise: menuItem.pricePaise,
    taxBps: menuItem.taxBps,
    quantity: Math.max(1, Math.trunc(Number(input.quantity || 1))),
  }
}

function publicTables(data) {
  return data.tables.filter(table => table.active).map(table => {
    const order = data.runningOrders.find(entry => entry.tableId === table.id)
    const orderTotals = order ? calculateTotals(order.items || []) : null
    return {
      ...table,
      status: order && order.items?.length ? 'occupied' : 'available',
      itemCount: orderTotals ? orderTotals.lines.reduce((sum, item) => sum + item.quantity, 0) : 0,
      totalPaise: orderTotals ? orderTotals.grandTotalPaise : 0,
      updatedAt: order && order.updatedAt,
    }
  })
}

function tableById(data, tableId) {
  return data.tables.find(table => table.id === tableId && table.active)
}

function upsertRunningOrder(data, tableId, items, actor) {
  const existing = data.runningOrders.find(entry => entry.tableId === tableId)
  if (!items.length) {
    data.runningOrders = data.runningOrders.filter(entry => entry.tableId !== tableId)
    audit(data, actor, 'TABLE_ORDER_CLEARED', { tableId })
    return null
  }
  const payload = { tableId, items, updatedAt: nowIso(), updatedBy: actor.name }
  if (existing) Object.assign(existing, payload)
  else data.runningOrders.push(payload)
  audit(data, actor, 'TABLE_ORDER_SAVED', { tableId, itemCount: items.length })
  return payload
}

async function handleApi(req, res, data) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const route = `${req.method} ${url.pathname}`

  if (route === 'GET /api/status') {
    return send(res, 200, { ok: true, setupComplete: data.setupComplete, restaurant: data.restaurant })
  }

  if (route === 'POST /api/setup') {
    if (data.setupComplete) return send(res, 409, { error: 'Already setup' })
    const body = await readJson(req)
    if (!body.ownerPassword || String(body.ownerPassword).length < 8) return send(res, 400, { error: 'Owner password must be at least 8 characters' })
    const owner = { id: id('user'), name: body.ownerName || 'Owner', username: body.ownerUsername || 'owner', role: 'OWNER', passwordHash: await hashPassword(body.ownerPassword), disabled: false }
    data.restaurant = { ...data.restaurant, name: body.restaurantName || 'Restaurant', outlet: body.outletName || 'Main Outlet', phone: body.phone || '', address: body.address || '' }
    data.users.push(owner)
    data.setupComplete = true
    audit(data, owner, 'OWNER_SETUP')
    saveData(data)
    return send(res, 200, { ok: true })
  }

  if (route === 'POST /api/login') {
    const body = await readJson(req)
    const key = loginKey(req, body.username)
    if (isLocked(key)) return send(res, 429, { error: 'Too many failed logins. Try after two minutes.' }, { 'Retry-After': '120' })
    const user = data.users.find(u => String(u.username).toLowerCase() === String(body.username || '').toLowerCase() && !u.disabled)
    const ok = user && await verifyPassword(user.passwordHash, body.password || '')
    audit(data, user || null, ok ? 'LOGIN_SUCCESS' : 'LOGIN_FAILED', { username: body.username })
    if (!ok) {
      recordBadLogin(key)
      saveData(data)
      return send(res, 401, { error: 'Invalid username or password' })
    }
    loginFailures.delete(key)
    const token = crypto.randomBytes(32).toString('base64url')
    const csrfToken = crypto.randomBytes(32).toString('base64url')
    sessions.set(token, { userId: user.id, csrfToken, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL_MS })
    saveData(data)
    return send(res, 200, { ok: true, user: publicUser(user), csrfToken }, { 'Set-Cookie': setSessionCookie(req, token) })
  }

  if (route === 'POST /api/logout') {
    const token = parseCookies(req).pos_session
    if (token) sessions.delete(token)
    return send(res, 200, { ok: true }, { 'Set-Cookie': 'pos_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0' })
  }

  if (route === 'GET /api/me') {
    const user = currentUser(req, data)
    return send(res, 200, { user: publicUser(user) })
  }

  const user = requireUser(req, res, data)
  if (!user) return
  if (!requireCsrf(req, res)) return

  if (route === 'GET /api/tables') {
    return send(res, 200, { tables: publicTables(data) })
  }

  if (route === 'POST /api/tables') {
    const owner = requireOwner(req, res, data)
    if (!owner) return
    const body = await readJson(req)
    const table = {
      id: id('table'),
      name: String(body.name || '').trim().slice(0, 30),
      capacity: Math.max(0, Math.trunc(Number(body.capacity || 0))),
      section: String(body.section || 'Dining').trim().slice(0, 30),
      active: true,
    }
    if (!table.name) return send(res, 400, { error: 'Table name required' })
    if (data.tables.some(existing => existing.active && existing.name.toLowerCase() === table.name.toLowerCase())) {
      return send(res, 409, { error: 'Table already exists' })
    }
    data.tables.push(table)
    audit(data, owner, 'TABLE_CREATED', { tableId: table.id, name: table.name })
    saveData(data)
    return send(res, 200, { table })
  }

  const tableOrderMatch = url.pathname.match(/^\/api\/tables\/([^/]+)\/order$/)
  if (tableOrderMatch && req.method === 'GET') {
    const tableId = decodeURIComponent(tableOrderMatch[1])
    const table = tableById(data, tableId)
    if (!table) return send(res, 404, { error: 'Table not found' })
    const order = data.runningOrders.find(entry => entry.tableId === tableId)
    return send(res, 200, { table, order: order || { tableId, items: [], updatedAt: null } })
  }

  if (tableOrderMatch && req.method === 'PUT') {
    const tableId = decodeURIComponent(tableOrderMatch[1])
    const table = tableById(data, tableId)
    if (!table) return send(res, 404, { error: 'Table not found' })
    const body = await readJson(req)
    const items = (body.items || []).map(input => safeItemFromMenu(data, input))
    const order = upsertRunningOrder(data, tableId, items, user)
    saveData(data)
    return send(res, 200, { table, order })
  }

  const tableClearMatch = url.pathname.match(/^\/api\/tables\/([^/]+)\/clear$/)
  if (tableClearMatch && req.method === 'POST') {
    const tableId = decodeURIComponent(tableClearMatch[1])
    const table = tableById(data, tableId)
    if (!table) return send(res, 404, { error: 'Table not found' })
    data.runningOrders = data.runningOrders.filter(entry => entry.tableId !== tableId)
    audit(data, user, 'TABLE_CLEARED_AFTER_PRINT', { tableId })
    saveData(data)
    return send(res, 200, { ok: true, table })
  }

  if (route === 'GET /api/menu') {
    return send(res, 200, { items: data.menu.filter(item => item.active), categories: [...new Set(data.menu.filter(i => i.active).map(i => i.category))] })
  }

  if (route === 'POST /api/menu') {
    const owner = requireOwner(req, res, data)
    if (!owner) return
    const body = await readJson(req)
    const item = { id: id('item'), category: String(body.category || 'General').trim(), name: String(body.name || '').trim(), pricePaise: paise(body.price), taxBps: Math.trunc(Number(body.taxBps || 500)), active: true }
    if (!item.name || item.pricePaise < 0) return send(res, 400, { error: 'Invalid menu item' })
    data.menu.push(item)
    audit(data, owner, 'MENU_ITEM_CREATED', { itemId: item.id, name: item.name })
    saveData(data)
    return send(res, 200, { item })
  }

  if (route === 'GET /api/users') {
    const owner = requireOwner(req, res, data)
    if (!owner) return
    return send(res, 200, { users: data.users.filter(u => !u.disabled).map(publicUser) })
  }

  if (route === 'POST /api/users') {
    const owner = requireOwner(req, res, data)
    if (!owner) return
    const body = await readJson(req)
    const username = String(body.username || '').trim().toLowerCase()
    if (!username || !body.password || String(body.password).length < 6) return send(res, 400, { error: 'Username and 6+ character password required' })
    if (data.users.some(u => u.username.toLowerCase() === username && !u.disabled)) return send(res, 409, { error: 'Username already exists' })
    const staff = {
      id: id('user'),
      name: String(body.name || username).trim(),
      username,
      role: body.role === 'OWNER' ? 'OWNER' : 'STAFF',
      passwordHash: await hashPassword(body.password),
      disabled: false,
    }
    data.users.push(staff)
    audit(data, owner, 'USER_CREATED', { userId: staff.id, username: staff.username, role: staff.role })
    saveData(data)
    return send(res, 200, { user: publicUser(staff) })
  }

  if (route === 'GET /api/kots') {
    return send(res, 200, { kots: data.kots.slice(-50).reverse() })
  }

  if (route === 'GET /api/bills') {
    return send(res, 200, { bills: data.bills.slice(-50).reverse() })
  }

  if (route === 'POST /api/kot') {
    const body = await readJson(req)
    const items = (body.items || []).map(input => safeItemFromMenu(data, input))
    if (!items.length) return send(res, 400, { error: 'No items' })
    const table = body.tableId ? tableById(data, body.tableId) : null
    if (body.tableId && !table) return send(res, 404, { error: 'Table not found' })
    if (table) upsertRunningOrder(data, table.id, items, user)
    const kot = { id: id('kot'), number: `KOT-${String(++data.sequences.kot).padStart(5, '0')}`, tableId: table && table.id, table: table ? table.name : (body.table || ''), orderType: body.orderType || 'DINE_IN', items, note: body.note || '', createdAt: nowIso(), staff: user.name }
    data.kots.push(kot)
    audit(data, user, 'KOT_CREATED', { kotId: kot.id, number: kot.number, customItems: items.filter(i => i.type === 'CUSTOM_ITEM').length })
    saveData(data)
    return send(res, 200, { kot })
  }

  if (route === 'POST /api/bill') {
    const body = await readJson(req)
    const items = (body.items || []).map(input => safeItemFromMenu(data, input))
    if (!items.length) return send(res, 400, { error: 'No items' })
    const table = body.tableId ? tableById(data, body.tableId) : null
    if (body.tableId && !table) return send(res, 404, { error: 'Table not found' })
    const totals = calculateTotals(items, paise(body.discount || 0))
    const paidPaise = paise(body.paidAmount == null ? rupees(totals.grandTotalPaise) : body.paidAmount)
    if (paidPaise < totals.grandTotalPaise) return send(res, 400, { error: 'Paid amount is less than bill total' })
    const bill = {
      id: id('bill'),
      number: `INV-${String(++data.sequences.invoice).padStart(5, '0')}`,
      tableId: table && table.id,
      table: table ? table.name : (body.table || ''),
      orderType: body.orderType || 'DINE_IN',
      customerName: body.customerName || '',
      paymentMethod: body.paymentMethod || 'Cash',
      items: totals.lines,
      totals,
      paidPaise,
      balancePaise: paidPaise - totals.grandTotalPaise,
      createdAt: nowIso(),
      staff: user.name,
    }
    data.bills.push(bill)
    audit(data, user, 'BILL_FINALIZED', { billId: bill.id, number: bill.number, totalPaise: totals.grandTotalPaise, customItems: items.filter(i => i.type === 'CUSTOM_ITEM').length })
    saveData(data)
    return send(res, 200, { bill })
  }

  if (route === 'GET /api/reports/today') {
    const today = new Date().toISOString().slice(0, 10)
    const bills = data.bills.filter(b => b.createdAt.slice(0, 10) === today)
    const totalPaise = bills.reduce((sum, b) => sum + b.totals.grandTotalPaise, 0)
    const customPaise = bills.flatMap(b => b.items).filter(i => i.type === 'CUSTOM_ITEM').reduce((sum, i) => sum + i.totalPaise, 0)
    return send(res, 200, { date: today, bills, totalPaise, customPaise, billCount: bills.length })
  }

  if (route === 'GET /api/export') {
    const owner = requireOwner(req, res, data)
    if (!owner) return
    return send(res, 200, { exportedAt: nowIso(), data })
  }

  send(res, 404, { error: 'Not found' })
}

function contentType(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8'
  if (file.endsWith('.css')) return 'text/css; charset=utf-8'
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8'
  if (file.endsWith('.json')) return 'application/json; charset=utf-8'
  return 'application/octet-stream'
}

function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const requested = url.pathname === '/' ? '/index.html' : url.pathname
  const filePath = path.normalize(path.join(PUBLIC_DIR, requested))
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); res.end('Forbidden'); return
  }
  if (!fs.existsSync(filePath)) {
    res.writeHead(404); res.end('Not found'); return
  }
  res.writeHead(200, { 'Content-Type': contentType(filePath), 'Cache-Control': 'no-store' })
  fs.createReadStream(filePath).pipe(res)
}

function localIp() {
  const nets = os.networkInterfaces()
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address
    }
  }
  return '127.0.0.1'
}

function createServer() {
  const data = loadData()
  return http.createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/api/')) return await handleApi(req, res, data)
      serveStatic(req, res)
    } catch (error) {
      send(res, error.message === 'Request too large' ? 413 : 400, { error: error.message || 'Server error' })
    }
  })
}

if (require.main === module) {
  createServer().listen(PORT, '0.0.0.0', () => {
    console.log(`Mobile POS running:`)
    console.log(`  This computer: http://localhost:${PORT}`)
    console.log(`  Phone on same Wi-Fi: http://${localIp()}:${PORT}`)
  })
}

module.exports = { createServer, calculateTotals, hashPassword, verifyPassword, defaultData }

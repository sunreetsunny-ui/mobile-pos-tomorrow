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
const KOT_UNLOCK_PASS = '8199'

const sessions = new Map()
const loginFailures = new Map()

function nowIso() { return new Date().toISOString() }
function id(prefix) { return `${prefix}_${crypto.randomUUID()}` }

function displayNumber(kind, sequence) {
  return `${kind}-${Number(sequence) + 344}`
}

function nextDocNumber(data, kind) {
  if (kind === 'KOT') return displayNumber('KOT', ++data.sequences.kot)
  return displayNumber('INV', ++data.sequences.invoice)
}

function defaultData() {
  return {
    setupComplete: false,
    restaurant: { name: '', outlet: '', phone: '', address: '', currency: 'INR', timezone: 'Asia/Kolkata', gstNumber: '', gstBps: 0 },
    users: [],
    tables: seedTables(),
    runningOrders: [],
    menu: seedMenu(),
    orders: [],
    kots: [],
    bills: [],
    printEvents: [],
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
  if (!Array.isArray(data.printEvents)) data.printEvents = []
  data.restaurant = { gstNumber: '', gstBps: 0, ...(data.restaurant || {}) }
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

function requireSalesAccess(req, res, data) {
  const user = requireUser(req, res, data)
  if (!user) return null
  if (!['OWNER', 'MANAGER'].includes(user.role)) {
    send(res, 403, { error: 'Owner or manager access required' })
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
  const gstBps = data.restaurant && data.restaurant.gstNumber && Number(data.restaurant.gstBps || 0) > 0 ? Math.trunc(Number(data.restaurant.gstBps)) : 0
  if (input.type === 'CUSTOM_ITEM') {
    if (!String(input.name || '').trim()) throw new Error('Custom item name required')
    if (!String(input.reason || '').trim()) throw new Error('Custom item reason required')
    return {
      id: id('custom'),
      type: 'CUSTOM_ITEM',
      name: String(input.name).trim().slice(0, 80),
      reason: String(input.reason).trim().slice(0, 160),
      pricePaise: Math.max(0, Math.trunc(Number(input.pricePaise || 0))),
      taxBps: gstBps,
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
    taxBps: gstBps,
    quantity: Math.max(1, Math.trunc(Number(input.quantity || 1))),
  }
}

function lineKey(item) {
  if (item.type === 'CUSTOM_ITEM') return `custom|${item.name}|${item.pricePaise}|${item.reason || ''}`
  return `menu|${item.id}`
}

function mergeKotState(previousItems = [], nextItems = []) {
  const sentByKey = new Map(previousItems.map(item => [lineKey(item), Math.min(Number(item.kotPrintedQty || 0), Number(item.quantity || 0))]))
  return nextItems.map(item => ({ ...item, kotPrintedQty: Math.min(sentByKey.get(lineKey(item)) || 0, item.quantity) }))
}

function assertKotLockedLinesAllowed(previousItems = [], nextItems = [], passcode = '') {
  if (String(passcode) === KOT_UNLOCK_PASS) return
  const nextByKey = new Map(nextItems.map(item => [lineKey(item), item]))
  for (const prev of previousItems) {
    const printedQty = Math.min(Number(prev.kotPrintedQty || 0), Number(prev.quantity || 0))
    if (printedQty <= 0) continue
    const next = nextByKey.get(lineKey(prev))
    if (!next || Number(next.quantity || 0) < printedQty) {
      throw new Error('KOT printed items are locked. Passcode required.')
    }
  }
}

function orderChangeSummary(previousItems = [], nextItems = []) {
  const previousByKey = new Map(previousItems.map(item => [lineKey(item), item]))
  const nextByKey = new Map(nextItems.map(item => [lineKey(item), item]))
  const added = []
  const reduced = []
  const cancelled = []
  const custom = []
  for (const item of nextItems) {
    const before = previousByKey.get(lineKey(item))
    if (item.type === 'CUSTOM_ITEM') custom.push(item)
    else if (!before) added.push(item)
    else if (Number(item.quantity || 0) > Number(before.quantity || 0)) added.push({ ...item, quantity: Number(item.quantity || 0) - Number(before.quantity || 0) })
  }
  for (const item of previousItems) {
    const after = nextByKey.get(lineKey(item))
    if (!after) cancelled.push(item)
    else if (Number(after.quantity || 0) < Number(item.quantity || 0)) reduced.push({ ...item, quantity: Number(item.quantity || 0) - Number(after.quantity || 0) })
  }
  return { added, reduced, cancelled, custom }
}

function assertSensitiveOrderChangeAllowed(previousItems = [], nextItems = [], passcode = '') {
  const summary = orderChangeSummary(previousItems, nextItems)
  const needsPass = summary.reduced.length || summary.cancelled.length || summary.custom.length
  if (needsPass && String(passcode) !== KOT_UNLOCK_PASS) {
    throw new Error('Passcode required for custom item, minus, or cancel.')
  }
  return summary
}

function auditSensitiveOrderChange(data, actor, tableId, previousItems = [], nextItems = [], passcode = '') {
  if (String(passcode) !== KOT_UNLOCK_PASS) return
  const summary = orderChangeSummary(previousItems, nextItems)
  const entries = [
    ['ORDER_ITEM_ADDED', summary.added],
    ['ORDER_ITEM_REDUCED', summary.reduced],
    ['ORDER_ITEM_CANCELLED', summary.cancelled],
    ['CUSTOM_ITEM_ADDED', summary.custom],
  ]
  for (const [action, items] of entries) {
    if (!items.length) continue
    audit(data, actor, action, {
      tableId,
      items: items.map(item => ({ name: item.name, quantity: item.quantity, type: item.type, amountPaise: item.pricePaise })),
    })
  }
}

function printedBillForTable(data, tableId, sinceAt = '') {
  const bills = data.bills
    .filter(bill => bill.tableId === tableId && (!sinceAt || String(bill.createdAt) >= String(sinceAt)) && !tableClearedAfter(data, tableId, bill.createdAt))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
  const bill = bills.find(entry => data.printEvents.some(event => event.docKind === 'BILL' && event.docId === entry.id))
  return bill || null
}

function tableClearedAfter(data, tableId, at) {
  return data.audit.some(event => event.action === 'TABLE_CLEARED_AFTER_PRINT' && event.details?.tableId === tableId && String(event.at) >= String(at))
}

function withPrintCounts(docs, kind, data) {
  return docs.map(doc => ({
    ...doc,
    printCount: data.printEvents.filter(event => event.docKind === kind && event.docId === doc.id).length,
    reprintCount: data.printEvents.filter(event => event.docKind === kind && event.docId === doc.id && event.action === 'REPRINT').length,
  }))
}

function publicTables(data) {
  return data.tables.filter(table => table.active).map(table => {
    const order = data.runningOrders.find(entry => entry.tableId === table.id)
    const orderTotals = order ? calculateTotals(order.items || []) : null
    const printedBill = order && printedBillForTable(data, table.id, order.updatedAt)
    return {
      ...table,
      status: order && order.items?.length ? 'occupied' : 'available',
      itemCount: orderTotals ? orderTotals.lines.reduce((sum, item) => sum + item.quantity, 0) : 0,
      totalPaise: orderTotals ? orderTotals.grandTotalPaise : 0,
      pendingPrintedBillId: printedBill ? printedBill.id : null,
      pendingPrintedBillNumber: printedBill ? printedBill.number : null,
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
  const payload = { tableId, items: mergeKotState(existing && existing.items, items), updatedAt: nowIso(), updatedBy: actor.name }
  const stored = existing || payload
  if (existing) Object.assign(existing, payload)
  else data.runningOrders.push(stored)
  audit(data, actor, 'TABLE_ORDER_SAVED', { tableId, itemCount: items.length })
  return stored
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
    data.restaurant = { ...data.restaurant, name: body.restaurantName || 'Restaurant', outlet: body.outletName || 'Main Outlet', phone: body.phone || '', address: body.address || '', gstNumber: body.gstNumber || '', gstBps: Math.max(0, Math.trunc(Number(body.gstBps || 0))) }
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
    const printedBill = order && printedBillForTable(data, tableId, order.updatedAt)
    return send(res, 200, { table, order: order || { tableId, items: [], updatedAt: null }, pendingPrintedBill: printedBill ? { id: printedBill.id, number: printedBill.number } : null })
  }

  if (tableOrderMatch && req.method === 'PUT') {
    const tableId = decodeURIComponent(tableOrderMatch[1])
    const table = tableById(data, tableId)
    if (!table) return send(res, 404, { error: 'Table not found' })
    const body = await readJson(req)
    const items = (body.items || []).map(input => safeItemFromMenu(data, input))
    const existing = data.runningOrders.find(entry => entry.tableId === tableId)
    const previousItems = (existing?.items || []).map(item => ({ ...item }))
    try {
      assertSensitiveOrderChangeAllowed(previousItems, items, body.passcode)
      assertKotLockedLinesAllowed(previousItems, items, body.passcode)
    } catch (e) {
      return send(res, 423, { error: e.message })
    }
    const order = upsertRunningOrder(data, tableId, items, user)
    auditSensitiveOrderChange(data, user, tableId, previousItems, items, body.passcode)
    saveData(data)
    return send(res, 200, { table, order })
  }

  const tableClearMatch = url.pathname.match(/^\/api\/tables\/([^/]+)\/clear$/)
  if (tableClearMatch && req.method === 'POST') {
    const tableId = decodeURIComponent(tableClearMatch[1])
    const table = tableById(data, tableId)
    if (!table) return send(res, 404, { error: 'Table not found' })
    const order = data.runningOrders.find(entry => entry.tableId === tableId)
    if (!printedBillForTable(data, tableId, order && order.updatedAt)) return send(res, 409, { error: 'Print bill before clearing table' })
    data.runningOrders = data.runningOrders.filter(entry => entry.tableId !== tableId)
    audit(data, user, 'TABLE_CLEARED_AFTER_PRINT', { tableId })
    saveData(data)
    return send(res, 200, { ok: true, table })
  }

  if (route === 'GET /api/menu') {
    const gstBps = data.restaurant && data.restaurant.gstNumber && Number(data.restaurant.gstBps || 0) > 0 ? Math.trunc(Number(data.restaurant.gstBps)) : 0
    return send(res, 200, { items: data.menu.filter(item => item.active).map(item => ({ ...item, taxBps: gstBps })), categories: [...new Set(data.menu.filter(i => i.active).map(i => i.category))] })
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

  if (route === 'PUT /api/restaurant') {
    const owner = requireOwner(req, res, data)
    if (!owner) return
    const body = await readJson(req)
    data.restaurant = {
      ...data.restaurant,
      gstNumber: String(body.gstNumber || '').trim().slice(0, 30),
      gstBps: Math.max(0, Math.min(2800, Math.trunc(Number(body.gstBps || 0)))),
    }
    audit(data, owner, 'GST_SETUP_UPDATED', { gstNumber: data.restaurant.gstNumber ? 'SET' : 'BLANK', gstBps: data.restaurant.gstBps })
    saveData(data)
    return send(res, 200, { restaurant: data.restaurant })
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
      role: body.role === 'OWNER' ? 'OWNER' : body.role === 'MANAGER' ? 'MANAGER' : 'STAFF',
      passwordHash: await hashPassword(body.password),
      disabled: false,
    }
    data.users.push(staff)
    audit(data, owner, 'USER_CREATED', { userId: staff.id, username: staff.username, role: staff.role })
    saveData(data)
    return send(res, 200, { user: publicUser(staff) })
  }

  if (route === 'GET /api/kots') {
    const visible = data.kots.filter(kot => !kot.tableId || !tableClearedAfter(data, kot.tableId, kot.createdAt))
    return send(res, 200, { kots: withPrintCounts(visible.slice(-50).reverse(), 'KOT', data) })
  }

  if (route === 'GET /api/bills') {
    return send(res, 200, { bills: withPrintCounts(data.bills.slice(-50).reverse(), 'BILL', data) })
  }

  const billMatch = url.pathname.match(/^\/api\/bills\/([^/]+)$/)
  if (billMatch && req.method === 'GET') {
    const billId = decodeURIComponent(billMatch[1])
    const bill = data.bills.find(entry => entry.id === billId)
    if (!bill) return send(res, 404, { error: 'Bill not found' })
    return send(res, 200, { bill: withPrintCounts([bill], 'BILL', data)[0] })
  }

  if (route === 'POST /api/kot') {
    const body = await readJson(req)
    const items = (body.items || []).map(input => safeItemFromMenu(data, input))
    if (!items.length) return send(res, 400, { error: 'No items' })
    const table = body.tableId ? tableById(data, body.tableId) : null
    if (body.tableId && !table) return send(res, 404, { error: 'Table not found' })
    let kotItems = items
    let mode = body.mode === 'FULL' ? 'FULL' : 'NEW'
    if (table) {
      const existing = data.runningOrders.find(entry => entry.tableId === table.id)
      const previousItems = (existing?.items || []).map(item => ({ ...item }))
      try {
        assertSensitiveOrderChangeAllowed(previousItems, items, body.passcode)
        assertKotLockedLinesAllowed(previousItems, items, body.passcode)
      } catch (e) {
        return send(res, 423, { error: e.message })
      }
      const order = upsertRunningOrder(data, table.id, items, user)
      auditSensitiveOrderChange(data, user, table.id, previousItems, items, body.passcode)
      if (mode === 'NEW') {
        kotItems = (order.items || [])
          .map(item => ({ ...item, quantity: Math.max(0, Number(item.quantity || 0) - Number(item.kotPrintedQty || 0)) }))
          .filter(item => item.quantity > 0)
      } else {
        kotItems = order.items || []
      }
      if (!kotItems.length) return send(res, 409, { error: 'No new items for KOT. Use Full KOT if needed.' })
      const sent = new Map(kotItems.map(item => [lineKey(item), Number(item.quantity || 0)]))
      order.items = order.items.map(item => {
        const nextPrinted = mode === 'FULL' ? item.quantity : Math.min(item.quantity, Number(item.kotPrintedQty || 0) + (sent.get(lineKey(item)) || 0))
        return { ...item, kotPrintedQty: nextPrinted }
      })
    }
    const kot = { id: id('kot'), number: nextDocNumber(data, 'KOT'), tableId: table && table.id, table: table ? table.name : (body.table || ''), orderType: body.orderType || 'DINE_IN', mode, items: kotItems, note: body.note || '', createdAt: nowIso(), staff: user.name }
    data.kots.push(kot)
    audit(data, user, 'KOT_CREATED', { kotId: kot.id, number: kot.number, customItems: items.filter(i => i.type === 'CUSTOM_ITEM').length })
    saveData(data)
    return send(res, 200, { kot })
  }

  if (route === 'POST /api/prints') {
    const body = await readJson(req)
    const docKind = body.kind === 'KOT' ? 'KOT' : body.kind === 'BILL' ? 'BILL' : ''
    const collection = docKind === 'KOT' ? data.kots : docKind === 'BILL' ? data.bills : []
    const doc = collection.find(entry => entry.id === body.id)
    if (!docKind || !doc) return send(res, 404, { error: 'Printable document not found' })
    if (docKind === 'KOT' && doc.tableId && tableClearedAfter(data, doc.tableId, doc.createdAt)) {
      return send(res, 409, { error: 'Table is cleared. KOT reprint blocked.' })
    }
    const previousCount = data.printEvents.filter(event => event.docKind === docKind && event.docId === doc.id).length
    const forceReprint = body.forceReprint === true
    if ((previousCount || forceReprint) && String(body.passcode || '') !== KOT_UNLOCK_PASS) {
      return send(res, 423, { error: 'Reprint passcode required.' })
    }
    const event = {
      id: id('print'),
      docKind,
      docId: doc.id,
      docNumber: doc.number,
      tableId: doc.tableId || '',
      table: doc.table || '',
      action: previousCount || forceReprint ? 'REPRINT' : 'PRINT',
      at: nowIso(),
      staff: user.name,
    }
    data.printEvents.push(event)
    audit(data, user, 'DOCUMENT_PRINTED', { docKind, docId: doc.id, docNumber: doc.number, action: event.action })
    saveData(data)
    return send(res, 200, { event, printCount: previousCount + 1 })
  }

  if (route === 'POST /api/bill') {
    const body = await readJson(req)
    const items = (body.items || []).map(input => safeItemFromMenu(data, input))
    if (!items.length) return send(res, 400, { error: 'No items' })
    const table = body.tableId ? tableById(data, body.tableId) : null
    if (body.tableId && !table) return send(res, 404, { error: 'Table not found' })
    if (table) {
      const existing = data.runningOrders.find(entry => entry.tableId === table.id)
      const previousItems = (existing?.items || []).map(item => ({ ...item }))
      if (printedBillForTable(data, table.id, existing && existing.updatedAt)) {
        return send(res, 409, { error: 'Bill already printed. Clear table before making a new bill.' })
      }
      try {
        assertSensitiveOrderChangeAllowed(previousItems, items, body.passcode)
        assertKotLockedLinesAllowed(previousItems, items, body.passcode)
      } catch (e) {
        return send(res, 423, { error: e.message })
      }
    }
    const totals = calculateTotals(items, paise(body.discount || 0))
    const paidPaise = paise(body.paidAmount == null ? rupees(totals.grandTotalPaise) : body.paidAmount)
    if (paidPaise < totals.grandTotalPaise) return send(res, 400, { error: 'Paid amount is less than bill total' })
    let autoKot = null
    if (table) {
      const previousItems = (data.runningOrders.find(entry => entry.tableId === table.id)?.items || []).map(item => ({ ...item }))
      const order = upsertRunningOrder(data, table.id, items, user)
      auditSensitiveOrderChange(data, user, table.id, previousItems, items, body.passcode)
      const autoKotItems = (order.items || [])
        .map(item => ({ ...item, quantity: Math.max(0, Number(item.quantity || 0) - Number(item.kotPrintedQty || 0)) }))
        .filter(item => item.quantity > 0)
      if (autoKotItems.length) {
        autoKot = { id: id('kot'), number: nextDocNumber(data, 'KOT'), tableId: table.id, table: table.name, orderType: body.orderType || 'DINE_IN', mode: 'AUTO_BILL', items: autoKotItems, note: 'Auto KOT from bill', createdAt: nowIso(), staff: user.name }
        data.kots.push(autoKot)
        const sent = new Map(autoKotItems.map(item => [lineKey(item), Number(item.quantity || 0)]))
        order.items = order.items.map(item => ({ ...item, kotPrintedQty: Math.min(item.quantity, Number(item.kotPrintedQty || 0) + (sent.get(lineKey(item)) || 0)) }))
        audit(data, user, 'AUTO_KOT_CREATED', { kotId: autoKot.id, number: autoKot.number, billSource: true })
      }
    } else {
      autoKot = { id: id('kot'), number: nextDocNumber(data, 'KOT'), tableId: null, table: body.table || '', orderType: body.orderType || 'TAKEAWAY', mode: 'AUTO_BILL', items, note: 'Auto KOT from direct bill', createdAt: nowIso(), staff: user.name }
      data.kots.push(autoKot)
      audit(data, user, 'AUTO_KOT_CREATED', { kotId: autoKot.id, number: autoKot.number, billSource: true })
    }
    const bill = {
      id: id('bill'),
      number: nextDocNumber(data, 'INV'),
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
    return send(res, 200, { bill, autoKot })
  }

  if (route === 'GET /api/reports/today') {
    const allowed = requireSalesAccess(req, res, data)
    if (!allowed) return
    const today = new Date().toISOString().slice(0, 10)
    const bills = data.bills.filter(b => b.createdAt.slice(0, 10) === today)
    const printEvents = data.printEvents.filter(event => event.at.slice(0, 10) === today)
    const reprintEvents = printEvents.filter(event => event.action === 'REPRINT')
    const totalPaise = bills.reduce((sum, b) => sum + b.totals.grandTotalPaise, 0)
    const customPaise = bills.flatMap(b => b.items).filter(i => i.type === 'CUSTOM_ITEM').reduce((sum, i) => sum + i.totalPaise, 0)
    return send(res, 200, { date: today, bills, totalPaise, customPaise, billCount: bills.length, printEvents, reprintEvents, printCount: printEvents.length, reprintCount: reprintEvents.length })
  }

  if (route === 'GET /api/reports/theft') {
    const owner = requireOwner(req, res, data)
    if (!owner) return
    const today = new Date().toISOString().slice(0, 10)
    const todayAudit = data.audit.filter(event => event.at.slice(0, 10) === today)
    const reprints = data.printEvents.filter(event => event.at.slice(0, 10) === today && event.action === 'REPRINT')
    const customItems = data.bills
      .filter(bill => bill.createdAt.slice(0, 10) === today)
      .flatMap(bill => bill.items.filter(item => item.type === 'CUSTOM_ITEM').map(item => ({ bill: bill.number, table: bill.table, name: item.name, amountPaise: item.totalPaise, staff: bill.staff })))
    const addedMenuItems = todayAudit.filter(event => event.action === 'MENU_ITEM_CREATED')
    const protectedOrderEvents = todayAudit.filter(event => ['ORDER_ITEM_ADDED', 'ORDER_ITEM_REDUCED', 'ORDER_ITEM_CANCELLED', 'CUSTOM_ITEM_ADDED'].includes(event.action))
    const orderChanges = todayAudit.filter(event => ['TABLE_ORDER_SAVED', 'TABLE_ORDER_CLEARED', 'TABLE_CLEARED_AFTER_PRINT', 'GST_SETUP_UPDATED'].includes(event.action))
    return send(res, 200, {
      date: today,
      reprints,
      customItems,
      addedMenuItems,
      protectedOrderEvents,
      orderChanges,
      summary: {
        reprints: reprints.length,
        billReprints: reprints.filter(event => event.docKind === 'BILL').length,
        kotReprints: reprints.filter(event => event.docKind === 'KOT').length,
        customItems: customItems.length,
        addedMenuItems: addedMenuItems.length,
        protectedAdds: protectedOrderEvents.filter(event => event.action === 'ORDER_ITEM_ADDED').length,
        protectedCustomItems: protectedOrderEvents.filter(event => event.action === 'CUSTOM_ITEM_ADDED').length,
        protectedReductions: protectedOrderEvents.filter(event => event.action === 'ORDER_ITEM_REDUCED').length,
        protectedCancels: protectedOrderEvents.filter(event => event.action === 'ORDER_ITEM_CANCELLED').length,
        orderChanges: orderChanges.length,
      },
    })
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

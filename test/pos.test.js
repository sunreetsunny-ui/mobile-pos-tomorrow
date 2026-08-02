const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { createServer, calculateTotals } = require('../server')

const dataFile = path.join(__dirname, '..', 'data', 'pos.json')
const backupFile = `${dataFile}.test-backup`

async function withCleanServer(fn) {
  fs.mkdirSync(path.dirname(dataFile), { recursive: true })
  if (fs.existsSync(backupFile)) fs.rmSync(backupFile, { force: true })
  if (fs.existsSync(dataFile)) fs.renameSync(dataFile, backupFile)
  const server = createServer()
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`
  try {
    await fn(baseUrl)
  } finally {
    await new Promise(resolve => server.close(resolve))
    if (fs.existsSync(dataFile)) fs.rmSync(dataFile, { force: true })
    if (fs.existsSync(backupFile)) fs.renameSync(backupFile, dataFile)
  }
}

async function jsonFetch(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  })
  const body = await res.json().catch(() => ({}))
  return { res, body }
}

test('calculates totals in integer paise', () => {
  const result = calculateTotals([
    { name: 'Tea', pricePaise: 1000, quantity: 2, taxBps: 500 },
    { name: 'Snack', pricePaise: 3333, quantity: 1, taxBps: 500 },
  ])
  assert.equal(result.subtotalPaise, 5333)
  assert.equal(result.taxPaise, 267)
  assert.equal(result.grandTotalPaise, 5600)
})

test('phone-only POS setup, login, CSRF, KOT, bill, and report flow', async () => {
  await withCleanServer(async (baseUrl) => {
    const status = await jsonFetch(`${baseUrl}/api/status`)
    assert.equal(status.body.setupComplete, false)

    const setup = await jsonFetch(`${baseUrl}/api/setup`, {
      method: 'POST',
      body: JSON.stringify({
        restaurantName: 'Tomorrow Cafe',
        ownerUsername: 'owner',
        ownerPassword: 'strong-password',
      }),
    })
    assert.equal(setup.res.status, 200)

    const login = await jsonFetch(`${baseUrl}/api/login`, {
      method: 'POST',
      body: JSON.stringify({ username: 'owner', password: 'strong-password' }),
    })
    assert.equal(login.res.status, 200)
    assert.equal(login.body.user.role, 'OWNER')
    assert.ok(login.body.csrfToken.length > 20)
    const cookie = login.res.headers.get('set-cookie').split(';')[0]

    const menu = await jsonFetch(`${baseUrl}/api/menu`, { headers: { Cookie: cookie } })
    assert.equal(menu.res.status, 200)
    const menuItemId = menu.body.items[0].id

    const missingCsrf = await jsonFetch(`${baseUrl}/api/kot`, {
      method: 'POST',
      headers: { Cookie: cookie },
      body: JSON.stringify({ items: [{ menuItemId, quantity: 1 }] }),
    })
    assert.equal(missingCsrf.res.status, 403)

    const authHeaders = { Cookie: cookie, 'X-CSRF-Token': login.body.csrfToken }
    const createdTable = await jsonFetch(`${baseUrl}/api/tables`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: 'Garden 1', capacity: 4, section: 'Garden' }),
    })
    assert.equal(createdTable.res.status, 200)
    const tableId = createdTable.body.table.id

    const savedOrder = await jsonFetch(`${baseUrl}/api/tables/${encodeURIComponent(tableId)}/order`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ items: [{ menuItemId, quantity: 2 }] }),
    })
    assert.equal(savedOrder.res.status, 200)

    const tablesAfterSave = await jsonFetch(`${baseUrl}/api/tables`, { headers: { Cookie: cookie } })
    const occupied = tablesAfterSave.body.tables.find(table => table.id === tableId)
    assert.equal(occupied.status, 'occupied')
    assert.equal(occupied.itemCount, 2)

    const kot = await jsonFetch(`${baseUrl}/api/kot`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ tableId, items: [{ menuItemId, quantity: 2 }] }),
    })
    assert.equal(kot.res.status, 200)
    assert.match(kot.body.kot.number, /^KOT-/)
    assert.equal(kot.body.kot.table, 'Garden 1')

    const bill = await jsonFetch(`${baseUrl}/api/bill`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ tableId, paymentMethod: 'UPI', items: [{ menuItemId, quantity: 2 }] }),
    })
    assert.equal(bill.res.status, 200)
    assert.match(bill.body.bill.number, /^INV-/)

    const tablesAfterBill = await jsonFetch(`${baseUrl}/api/tables`, { headers: { Cookie: cookie } })
    const freed = tablesAfterBill.body.tables.find(table => table.id === tableId)
    assert.equal(freed.status, 'available')

    const report = await jsonFetch(`${baseUrl}/api/reports/today`, { headers: { Cookie: cookie } })
    assert.equal(report.res.status, 200)
    assert.equal(report.body.billCount, 1)
    assert.equal(report.body.totalPaise, bill.body.bill.totals.grandTotalPaise)
  })
})

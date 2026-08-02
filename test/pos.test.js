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
    const secondMenuItemId = menu.body.items[1].id

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

    const managerUser = await jsonFetch(`${baseUrl}/api/users`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: 'Manager', username: 'manager', password: 'manager-pass', role: 'MANAGER' }),
    })
    assert.equal(managerUser.res.status, 200)
    assert.equal(managerUser.body.user.role, 'MANAGER')

    const staffUser = await jsonFetch(`${baseUrl}/api/users`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ name: 'Staff', username: 'staff', password: 'staff-pass', role: 'STAFF' }),
    })
    assert.equal(staffUser.res.status, 200)

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
    assert.doesNotMatch(kot.body.kot.number, /^KOT-\d{5}$/)
    assert.equal(kot.body.kot.table, 'Garden 1')
    assert.equal(kot.body.kot.items.length, 1)
    assert.equal(kot.body.kot.items[0].quantity, 2)

    const lockedReduce = await jsonFetch(`${baseUrl}/api/tables/${encodeURIComponent(tableId)}/order`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ items: [{ menuItemId, quantity: 1 }] }),
    })
    assert.equal(lockedReduce.res.status, 423)

    const updatedOrder = await jsonFetch(`${baseUrl}/api/tables/${encodeURIComponent(tableId)}/order`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ items: [{ menuItemId, quantity: 2 }, { menuItemId: secondMenuItemId, quantity: 1 }] }),
    })
    assert.equal(updatedOrder.res.status, 200)

    const newItemKot = await jsonFetch(`${baseUrl}/api/kot`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ tableId, items: [{ menuItemId, quantity: 2 }, { menuItemId: secondMenuItemId, quantity: 1 }] }),
    })
    assert.equal(newItemKot.res.status, 200)
    assert.equal(newItemKot.body.kot.items.length, 1)
    assert.equal(newItemKot.body.kot.items[0].id, secondMenuItemId)

    const noNewKot = await jsonFetch(`${baseUrl}/api/kot`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ tableId, items: [{ menuItemId, quantity: 2 }, { menuItemId: secondMenuItemId, quantity: 1 }] }),
    })
    assert.equal(noNewKot.res.status, 409)

    const bill = await jsonFetch(`${baseUrl}/api/bill`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ tableId, paymentMethod: 'UPI', items: [{ menuItemId, quantity: 2 }, { menuItemId: secondMenuItemId, quantity: 1 }] }),
    })
    assert.equal(bill.res.status, 200)
    assert.match(bill.body.bill.number, /^INV-/)
    assert.doesNotMatch(bill.body.bill.number, /^INV-\d{5}$/)

    const tablesAfterBill = await jsonFetch(`${baseUrl}/api/tables`, { headers: { Cookie: cookie } })
    const stillOccupied = tablesAfterBill.body.tables.find(table => table.id === tableId)
    assert.equal(stillOccupied.status, 'occupied')
    assert.equal(stillOccupied.pendingPrintedBillId, null)

    const clearBeforePrint = await jsonFetch(`${baseUrl}/api/tables/${encodeURIComponent(tableId)}/clear`, {
      method: 'POST',
      headers: authHeaders,
    })
    assert.equal(clearBeforePrint.res.status, 409)

    const firstBillPrint = await jsonFetch(`${baseUrl}/api/prints`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ kind: 'BILL', id: bill.body.bill.id }),
    })
    assert.equal(firstBillPrint.res.status, 200)
    assert.equal(firstBillPrint.body.event.action, 'PRINT')

    const billReprint = await jsonFetch(`${baseUrl}/api/prints`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ kind: 'BILL', id: bill.body.bill.id }),
    })
    assert.equal(billReprint.res.status, 200)
    assert.equal(billReprint.body.event.action, 'REPRINT')

    const billsAfterReprint = await jsonFetch(`${baseUrl}/api/bills`, { headers: { Cookie: cookie } })
    assert.equal(billsAfterReprint.res.status, 200)
    assert.equal(billsAfterReprint.body.bills.filter(entry => entry.id === bill.body.bill.id).length, 1)
    assert.equal(billsAfterReprint.body.bills.find(entry => entry.id === bill.body.bill.id).number, bill.body.bill.number)

    const kotPrint = await jsonFetch(`${baseUrl}/api/prints`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ kind: 'KOT', id: kot.body.kot.id }),
    })
    assert.equal(kotPrint.res.status, 200)

    const kotReprint = await jsonFetch(`${baseUrl}/api/prints`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ kind: 'KOT', id: kot.body.kot.id }),
    })
    assert.equal(kotReprint.res.status, 200)
    assert.equal(kotReprint.body.event.action, 'REPRINT')

    const kotsAfterReprint = await jsonFetch(`${baseUrl}/api/kots`, { headers: { Cookie: cookie } })
    assert.equal(kotsAfterReprint.res.status, 200)
    assert.equal(kotsAfterReprint.body.kots.filter(entry => entry.id === kot.body.kot.id).length, 1)
    assert.equal(kotsAfterReprint.body.kots.find(entry => entry.id === kot.body.kot.id).number, kot.body.kot.number)

    const tablesAfterPrint = await jsonFetch(`${baseUrl}/api/tables`, { headers: { Cookie: cookie } })
    const clearable = tablesAfterPrint.body.tables.find(table => table.id === tableId)
    assert.equal(clearable.pendingPrintedBillId, bill.body.bill.id)

    const clearedTable = await jsonFetch(`${baseUrl}/api/tables/${encodeURIComponent(tableId)}/clear`, {
      method: 'POST',
      headers: authHeaders,
    })
    assert.equal(clearedTable.res.status, 200)

    const tablesAfterClear = await jsonFetch(`${baseUrl}/api/tables`, { headers: { Cookie: cookie } })
    const freed = tablesAfterClear.body.tables.find(table => table.id === tableId)
    assert.equal(freed.status, 'available')

    const blockedClearedKotReprint = await jsonFetch(`${baseUrl}/api/prints`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ kind: 'KOT', id: kot.body.kot.id }),
    })
    assert.equal(blockedClearedKotReprint.res.status, 409)

    const kotsAfterClear = await jsonFetch(`${baseUrl}/api/kots`, { headers: { Cookie: cookie } })
    assert.equal(kotsAfterClear.res.status, 200)
    assert.equal(kotsAfterClear.body.kots.some(entry => entry.id === kot.body.kot.id), false)

    const gstSetup = await jsonFetch(`${baseUrl}/api/restaurant`, {
      method: 'PUT',
      headers: authHeaders,
      body: JSON.stringify({ gstNumber: '27ABCDE1234F1Z5', gstBps: 500 }),
    })
    assert.equal(gstSetup.res.status, 200)
    assert.equal(gstSetup.body.restaurant.gstBps, 500)

    const taxableMenu = await jsonFetch(`${baseUrl}/api/menu`, { headers: { Cookie: cookie } })
    assert.equal(taxableMenu.body.items[0].taxBps, 500)

    const directBill = await jsonFetch(`${baseUrl}/api/bill`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ table: 'Parcel', paymentMethod: 'Cash', items: [{ menuItemId, quantity: 1 }] }),
    })
    assert.equal(directBill.res.status, 200)
    assert.ok(directBill.body.autoKot)
    assert.match(directBill.body.autoKot.number, /^KOT-/)

    const report = await jsonFetch(`${baseUrl}/api/reports/today`, { headers: { Cookie: cookie } })
    assert.equal(report.res.status, 200)
    assert.equal(report.body.billCount, 2)
    assert.equal(report.body.totalPaise, bill.body.bill.totals.grandTotalPaise + directBill.body.bill.totals.grandTotalPaise)
    assert.equal(report.body.reprintCount, 2)
    assert.equal(report.body.reprintEvents.length, 2)

    const theftReport = await jsonFetch(`${baseUrl}/api/reports/theft`, { headers: { Cookie: cookie } })
    assert.equal(theftReport.res.status, 200)
    assert.equal(theftReport.body.summary.reprints, 2)

    const managerLogin = await jsonFetch(`${baseUrl}/api/login`, {
      method: 'POST',
      body: JSON.stringify({ username: 'manager', password: 'manager-pass' }),
    })
    assert.equal(managerLogin.res.status, 200)
    const managerCookie = managerLogin.res.headers.get('set-cookie').split(';')[0]
    const managerReport = await jsonFetch(`${baseUrl}/api/reports/today`, { headers: { Cookie: managerCookie } })
    assert.equal(managerReport.res.status, 200)
    assert.equal(managerReport.body.billCount, 2)
    const managerTheftReport = await jsonFetch(`${baseUrl}/api/reports/theft`, { headers: { Cookie: managerCookie } })
    assert.equal(managerTheftReport.res.status, 403)

    const staffLogin = await jsonFetch(`${baseUrl}/api/login`, {
      method: 'POST',
      body: JSON.stringify({ username: 'staff', password: 'staff-pass' }),
    })
    assert.equal(staffLogin.res.status, 200)
    const staffCookie = staffLogin.res.headers.get('set-cookie').split(';')[0]
    const staffReport = await jsonFetch(`${baseUrl}/api/reports/today`, { headers: { Cookie: staffCookie } })
    assert.equal(staffReport.res.status, 403)
  })
})

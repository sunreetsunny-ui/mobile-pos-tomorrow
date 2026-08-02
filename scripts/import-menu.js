const crypto = require('crypto')
const fs = require('fs')
const path = require('path')

const csvPath = process.argv[2]
if (!csvPath) {
  console.error('Usage: node scripts/import-menu.js <menu.csv>')
  process.exit(1)
}

function parseCsv(text) {
  const rows = []
  let row = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const next = text[i + 1]
    if (quoted) {
      if (ch === '"' && next === '"') {
        cell += '"'
        i += 1
      } else if (ch === '"') {
        quoted = false
      } else {
        cell += ch
      }
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n') {
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else if (ch !== '\r') {
      cell += ch
    }
  }
  if (cell || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}

function stableId(name, category, pricePaise) {
  const hash = crypto.createHash('sha1').update(`${category}|${name}|${pricePaise}`).digest('hex').slice(0, 16)
  return `item_${hash}`
}

function normalizeCategory(value) {
  return String(value || 'Menu').replace(/^Hakka Boom'?S\s+/i, '').replace(/\s+/g, ' ').trim() || 'Menu'
}

function toPaise(value) {
  return Math.round((Number(String(value || '').replace(/[^\d.]/g, '')) || 0) * 100)
}

const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'))
const items = []
const seen = new Set()

for (const row of rows.slice(1)) {
  const name = String(row[0] || row[1] || '').trim()
  const category = normalizeCategory(row[8])
  const pricePaise = toPaise(row[10])
  if (!name || pricePaise <= 0) continue
  const key = `${category.toLowerCase()}|${name.toLowerCase()}|${pricePaise}`
  if (seen.has(key)) continue
  seen.add(key)
  items.push({
    id: stableId(name, category, pricePaise),
    category,
    name,
    pricePaise,
    taxBps: 500,
    active: true,
  })
}

if (!items.length) {
  console.error('No menu items found in CSV')
  process.exit(1)
}

const root = path.resolve(__dirname, '..')
fs.writeFileSync(path.join(root, 'menu-seed.json'), `${JSON.stringify(items, null, 2)}\n`)

const dataFile = path.join(root, 'data', 'pos.json')
if (fs.existsSync(dataFile)) {
  const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'))
  data.menu = items
  data.runningOrders = []
  data.kots = []
  data.bills = []
  data.sequences = { kot: 0, invoice: 0 }
  fs.writeFileSync(dataFile, `${JSON.stringify(data, null, 2)}\n`)
}

const categories = [...new Set(items.map(item => item.category))]
console.log(`Imported ${items.length} items across ${categories.length} categories`)

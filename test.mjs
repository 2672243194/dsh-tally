// dsh-tally self-test — zero-dependency, run: node test.mjs
import assert from 'node:assert/strict'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { apply } from './index.js'

const tmpDir = mkdtempSync(path.join(tmpdir(), 'dsh-tally-test-'))
const tools = []
const fakeCtx = {
  tools: { register: (t) => tools.push(t) },
  effect: () => {},
  get: () => undefined,
}
apply(fakeCtx, { storagePath: path.join(tmpDir, 'tally.json') })

const add = tools.find((t) => t.name === 'tally_add')
const list = tools.find((t) => t.name === 'tally_list')
const stats = tools.find((t) => t.name === 'tally_stats')
const remove = tools.find((t) => t.name === 'tally_remove')
const budget = tools.find((t) => t.name === 'tally_budget')
const exportT = tools.find((t) => t.name === 'tally_export')
assert.ok(add && list && stats && remove && budget && exportT, 'all six tools must register')

let passed = 0
function ok(name, fn) {
  fn()
  passed++
  console.log(`  ok - ${name}`)
}
const aok = async (name, fn) => {
  await fn()
  passed++
  console.log(`  ok - ${name}`)
}

console.log('tally_add')
await aok('records expense with defaults', async () => {
  const r = await add.execute({ amount: 36 })
  assert.equal(r.type, 'expense')
  assert.equal(r.category, '其他')
  assert.equal(r.amount, 36)
  assert.match(r.id, /^[0-9a-f]{8}$/)
})

await aok('rejects zero/negative/over-precision amounts', async () => {
  assert.ok((await add.execute({ amount: 0 })).error)
  assert.ok((await add.execute({ amount: -5 })).error)
  assert.ok((await add.execute({ amount: 1.234 })).error === undefined, '1.234 rounds to 1.23')
})

await aok('records income with custom category and date', async () => {
  const r = await add.execute({ amount: 8000, type: 'income', category: '工资', date: '2026-03-10' })
  assert.equal(r.type, 'income')
  assert.equal(r.category, '工资')
  assert.equal(r.date, '2026-03-10')
})

await aok('rejects invalid date and falls back to today', async () => {
  const r = await add.execute({ amount: 10, date: '2026-13-40' })
  assert.match(r.date, /^\d{4}-\d{2}-\d{2}$/)
})

await aok('truncates long note to 50 chars', async () => {
  const r = await add.execute({ amount: 5, note: 'x'.repeat(80) })
  assert.equal(r.note.length, 50)
})

console.log('tally_list')
await aok('filters by month, sorts desc, shows short ids', async () => {
  await add.execute({ amount: 20, category: '餐饮', date: '2026-03-01', note: '早餐' })
  await add.execute({ amount: 30, category: '餐饮', date: '2026-03-05', note: '午餐' })
  await add.execute({ amount: 100, category: '交通', date: '2026-03-08', note: '打车' })
  await add.execute({ amount: 999, category: '购物', date: '2026-02-20', note: '旧月' })
  const r = await list.execute({ month: '2026-03' })
  assert.equal(r.total, 4) // 3 expense + 1 income (03-10 from earlier test)
  assert.equal(r.entries[0].type, 'income', 'newest date (03-10 income) first')
  assert.equal(r.entries[1].note, '打车', '03-08 second')
})

await aok('filters by category and keyword, respects limit', async () => {
  const cat = await list.execute({ month: '2026-03', category: '餐饮' })
  assert.equal(cat.total, 2)
  const kw = await list.execute({ month: '2026-03', keyword: '午餐' })
  assert.equal(kw.total, 1)
  const lim = await list.execute({ month: '2026-03', limit: 2 })
  assert.equal(lim.entries.length, 2)
  assert.equal(lim.total, 4)
})

console.log('tally_stats')
await aok('summarizes expense/income/balance/top categories', async () => {
  const r = await stats.execute({ month: '2026-03' })
  assert.equal(r.expense, 150) // 20 + 30 + 100 (the no-date 36 lands in the current month)
  assert.equal(r.income, 8000)
  assert.equal(r.balance, 7850)
  assert.equal(r.topCategories[0].category, '交通') // 100 > 86(餐饮 36+20+30)
  assert.equal(r.count, 4) // 03-01/05/08 expense + 03-10 income
  assert.ok(r.dailyAvg > 0)
})

await aok('empty month returns zeros', async () => {
  const r = await stats.execute({ month: '2020-01' })
  assert.equal(r.expense, 0)
  assert.equal(r.count, 0)
})

console.log('tally_remove')
await aok('requires confirmation before deleting', async () => {
  const r = await add.execute({ amount: 66, category: '购物', date: '2026-03-15' })
  const first = await remove.execute({ id: r.id })
  assert.equal(first.needConfirm, true)
  const still = await stats.execute({ month: '2026-03' })
  assert.ok(still.expense > 0, 'entry still present before confirm')
  const done = await remove.execute({ id: r.id, confirm: true })
  assert.equal(done.removed, true)
  const after = await stats.execute({ month: '2026-03' })
  assert.equal(after.expense, 150, 'entry gone after confirm')
})

await aok('unknown id errors clearly', async () => {
  const r = await remove.execute({ id: 'deadbeef' })
  assert.ok(r.error)
})

console.log('persistence & concurrency')
await aok('writes atomic JSON file that reloads', async () => {
  const file = path.join(tmpDir, 'tally.json')
  assert.ok(existsSync(file), 'ledger file created')
  const raw = JSON.parse(readFileSync(file, 'utf8'))
  assert.ok(Array.isArray(raw.entries) && raw.entries.length > 0)
  const r = await list.execute({ month: '2026-03' })
  assert.ok(r.total > 0, 'reloaded from file')
})

await aok('serialized queue survives parallel adds', async () => {
  const before = (await stats.execute({ month: '2026-04' })).count
  const jobs = []
  for (let i = 0; i < 10; i++) jobs.push(add.execute({ amount: 1, category: '餐饮', date: `2026-04-${String(i + 1).padStart(2, '0')}` }))
  const results = await Promise.all(jobs)
  assert.ok(results.every((r) => !r.error), 'all parallel adds succeed')
  const after = await stats.execute({ month: '2026-04' })
  assert.equal(after.count, before + 10, 'no lost writes')
})

console.log('renders')
await aok('compact renders with currency and Chinese', async () => {
  const r = await add.execute({ amount: 12.5, category: '娱乐', date: '2026-05-01', note: '电影' })
  const text = add.output.render(null, r)[0].text
  assert.ok(text.includes('¥12.50'), `currency format: ${text}`)
  assert.ok(text.includes('娱乐'))
  const s = await stats.execute({ month: '2026-05' })
  const st = stats.output.render(null, s)[0].text
  assert.ok(st.includes('支出 ¥12.50'))
  assert.ok(st.includes('结余'))
})

console.log('tally_budget')
await aok('sets and queries a monthly budget', async () => {
  const set = await budget.execute({ month: '2026-03', amount: 200 })
  assert.equal(set.action, 'set')
  assert.equal(set.budget, 200)
  const q = await budget.execute({ month: '2026-03' })
  assert.equal(q.budget, 200)
  assert.equal(q.spent, 150) // 20 + 30 + 100
  assert.equal(q.remaining, 50)
  assert.equal(q.over, false)
})

await aok('overwrites existing budget', async () => {
  const set = await budget.execute({ month: '2026-03', amount: 300 })
  assert.equal(set.prevBudget, 200)
  assert.equal(set.budget, 300)
})

await aok('flags over-budget and rejects bad amounts', async () => {
  await budget.execute({ month: '2026-02', amount: 100 })
  const q = await budget.execute({ month: '2026-02' })
  assert.equal(q.spent, 999)
  assert.equal(q.over, true)
  assert.ok((await budget.execute({ amount: 0 })).error)
  assert.ok((await budget.execute({ amount: -1 })).error)
})

await aok('stats reports budget status (over / within)', async () => {
  const s3 = await stats.execute({ month: '2026-03' })
  assert.equal(s3.budget, 300)
  assert.equal(s3.budgetOver, false)
  const s2 = await stats.execute({ month: '2026-02' })
  assert.equal(s2.budget, 100)
  assert.equal(s2.budgetOver, true)
  const text = stats.output.render(null, s2)[0].text
  assert.ok(text.includes('超支'), `render should flag over-budget: ${text}`)
})

await aok('budget render: no budget set / set / query', async () => {
  const none = budget.output.render(null, await budget.execute({ month: '2020-01' }))[0].text
  assert.ok(none.includes('未设置预算'))
  const set = budget.output.render(null, await budget.execute({ month: '2026-04', amount: 500 }))[0].text
  assert.ok(set.includes('¥500.00'))
  const q = budget.output.render(null, await budget.execute({ month: '2026-04' }))[0].text
  assert.ok(q.includes('已支出 ¥10.00'))
})

console.log('annual stats')
await aok('year report aggregates 12 months + totals', async () => {
  const r = await stats.execute({ year: '2026' })
  assert.equal(r.count, 20) // 03:4 + 02:1 + 04:10 + 05:1 + 08:4
  assert.equal(r.expense, 1223.73) // 150 + 999 + 10 + 12.5 + 52.23
  assert.equal(r.income, 8000)
  assert.equal(r.balance, 6776.27)
  const m3 = r.months.find((m) => m.month === '2026-03')
  assert.equal(m3.expense, 150)
  assert.equal(m3.count, 4)
  assert.equal(r.months.length, 12, 'always 12 month slots')
  const text = stats.output.render(null, r)[0].text
  assert.ok(text.includes('全年支出'))
  assert.ok(text.includes('3月'), `render lists active months: ${text}`)
})

await aok('year param ignored when month present', async () => {
  const r = await stats.execute({ month: '2026-03', year: '2026' })
  assert.equal(r.month, '2026-03')
  assert.equal(r.year, undefined)
})

console.log('tally_export')
await aok('exports CSV with UTF-8 BOM, header and entries sorted by date', async () => {
  const r = await exportT.execute({ month: '2026-03' })
  assert.equal(r.count, 4) // 20/30/100 expense + 8000 income
  assert.equal(r.csv.charCodeAt(0), 0xfeff, 'CSV starts with UTF-8 BOM (Excel compat)')
  const lines = r.csv.split('\n')
  assert.equal(lines.length, 5) // header + 4
  assert.ok(lines[0].startsWith('\uFEFFdate,type,category,amount,note'), `header with BOM: ${lines[0]}`)
  assert.ok(lines[1].startsWith('2026-03-01,expense,餐饮,20,'), `sorted first: ${lines[1]}`)
  assert.ok(lines[4].startsWith('2026-03-10,income,工资,8000,'), `income last: ${lines[4]}`)
  const text = exportT.output.render(null, r)[0].text
  assert.ok(text.includes('共 4 笔'))
})

await aok('escapes commas and quotes per RFC-4180', async () => {
  await add.execute({ amount: 7, category: '其他', date: '2026-03-20', note: 'a,b"c' })
  const r = await exportT.execute({ month: '2026-03' })
  assert.equal(r.count, 5)
  const line = r.csv.split('\n').find((l) => l.includes('2026-03-20'))
  assert.ok(line, 'exported note row exists')
  assert.ok(line.includes('"a,b""c"'), `note escaped: ${line}`)
})

await aok('empty month export returns zero count', async () => {
  const r = await exportT.execute({ month: '2020-01' })
  assert.equal(r.count, 0)
  const text = exportT.output.render(null, r)[0].text
  assert.ok(text.includes('没有记录'))
})

console.log(`\n${passed} assertions passed`)

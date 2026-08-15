// dsh-tally — Personal bookkeeping plugin for DeepSeek Harness
// Zero external dependencies (Node 20+ built-ins only).
// Design (aligned with dsh-read-url standards):
//   - local JSON storage (atomic tmp+rename writes, serialized write queue)
//   - token-efficient compact text render, static schemas (KV-cache friendly)
//   - cooperative tool-call timeout via ToolDefinition.timeoutMs + exec.signal
//   - Chinese-friendly: built-in categories, ¥ formatting, YYYY-MM-DD dates
import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { buildHtmlReport } from './report.js'

export const name = 'dsh-tally'
export const inject = ['tools']

const DEFAULTS = {
  storagePath: '',
  currency: '¥',
}

const CATEGORIES = ['餐饮', '交通', '购物', '居住', '娱乐', '医疗', '教育', '人情', '工资', '其他']

let writeQueue = Promise.resolve()
function enqueueWrite(fn) {
  const p = writeQueue.then(fn, fn)
  writeQueue = p.catch(() => {})
  return p
}

function resolveStoragePath(cfg) {
  if (cfg.storagePath) return cfg.storagePath
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  return path.join(home, 'plugins', 'tally.json')
}

function loadLedger(file) {
  try {
    if (!existsSync(file)) return { entries: [], budgets: {} }
    const data = JSON.parse(readFileSync(file, 'utf8'))
    if (!Array.isArray(data.entries)) return { entries: [], budgets: {} }
    if (!data.budgets || typeof data.budgets !== 'object') data.budgets = {}
    return data
  } catch {
    return { entries: [], budgets: {} }
  }
}

function saveLedger(file, data) {
  mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, JSON.stringify(data), 'utf8')
  renameSync(tmp, file)
}

function shortId(id) {
  return id.slice(0, 8)
}

function fmtMoney(n, currency) {
  return currency + n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function fmtDate(iso) {
  const [, m, d] = iso.split('-')
  return `${Number(m)}-${Number(d)}`
}

function todayISO() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const [y, m, d] = s.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  return dt.getFullYear() === y && dt.getMonth() === m - 1 && dt.getDate() === d
}

function normalizeAmount(v) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.round(n * 100) / 100
}

function buildEntry(raw) {
  const amount = normalizeAmount(raw.amount)
  if (amount === null) return { error: 'amount must be a positive number (max 2 decimals)' }
  const type = raw.type === 'income' ? 'income' : 'expense'
  const category = String(raw.category || '其他').slice(0, 20)
  const note = String(raw.note || '').slice(0, 50)
  const date = isValidDate(raw.date) ? raw.date : todayISO()
  return { entry: { id: randomUUID(), date, type, category, note, amount, createdAt: Date.now() } }
}

const activeOnly = (e) => !e.deleted

function entryLine(e, currency) {
  const type = e.type === 'income' ? '收' : '支'
  const note = e.note ? ` ${e.note}` : ''
  return `${fmtDate(e.date)} ${type} ${e.category} ${fmtMoney(e.amount, currency)}${note} (id: ${shortId(e.id)})`
}

function signMoney(n, currency) {
  return n >= 0 ? `+${fmtMoney(n, currency)}` : `-${fmtMoney(-n, currency)}`
}

// ---- tally_add ----
function toolAdd(cfg) {
  return {
    name: 'tally_add',
    description:
      'Record a personal expense or income entry. ' +
      `Built-in categories: ${CATEGORIES.join('/')} (custom strings accepted). ` +
      'Returns the recorded entry with a short id for later removal.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        amount: { type: 'number', description: 'Amount in yuan (positive, up to 2 decimals)' },
        type: { type: 'string', enum: ['expense', 'income'], description: 'expense = spending out (default), income = money in' },
        category: { type: 'string', description: `Category (default 其他; built-ins: ${CATEGORIES.join('/')})` },
        note: { type: 'string', description: 'Optional note (max 50 chars, searchable)' },
        date: { type: 'string', description: 'Date YYYY-MM-DD (default today)' },
      },
      required: ['amount'],
    },
    timeoutMs: 5000,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: renderAdd(v, cfg) }] },
    async execute(args) {
      const built = buildEntry(args || {})
      if (built.error) return { error: built.error }
      const entry = built.entry
      const file = resolveStoragePath(cfg)
      await enqueueWrite(() => {
        const data = loadLedger(file)
        data.entries.push(entry)
        saveLedger(file, data)
      })
      return { id: shortId(entry.id), date: entry.date, type: entry.type, category: entry.category, note: entry.note, amount: entry.amount }
    },
  }
}

function renderAdd(v, cfg) {
  if (typeof v === 'string') return v
  if (v.error) return `Error: ${v.error}`
  const type = v.type === 'income' ? '收入' : '支出'
  const note = v.note ? ` · ${v.note}` : ''
  return `已记 ${type} ${fmtDate(v.date)} ${v.category} ${fmtMoney(v.amount, cfg.currency)}${note} (id: ${v.id})`
}

// ---- tally_batch ----
function toolBatch(cfg) {
  return {
    name: 'tally_batch',
    description:
      'Record multiple entries in one call (handy for back-filling several expenses at once). ' +
      'entries is an array of objects with the same fields as tally_add (amount required). ' +
      'Valid entries are written together; invalid ones are skipped and reported by index.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        entries: {
          type: 'array',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              amount: { type: 'number', description: 'Amount in yuan (positive, up to 2 decimals)' },
              type: { type: 'string', enum: ['expense', 'income'], description: 'expense (default) or income' },
              category: { type: 'string', description: 'Category (default 其他)' },
              note: { type: 'string', description: 'Optional note (max 50 chars)' },
              date: { type: 'string', description: 'Date YYYY-MM-DD (default today)' },
            },
            required: ['amount'],
          },
        },
      },
      required: ['entries'],
    },
    timeoutMs: 10000,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: renderBatch(v, cfg) }] },
    async execute(args) {
      const rawList = Array.isArray(args.entries) ? args.entries : []
      if (!rawList.length) return { error: 'entries must be a non-empty array' }
      const built = []
      const errors = []
      rawList.forEach((raw, i) => {
        const r = buildEntry(raw || {})
        if (r.error) errors.push({ index: i, error: r.error })
        else built.push(r.entry)
      })
      if (built.length) {
        const file = resolveStoragePath(cfg)
        await enqueueWrite(() => {
          const data = loadLedger(file)
          for (const e of built) data.entries.push(e)
          saveLedger(file, data)
        })
      }
      return {
        total: rawList.length,
        written: built.length,
        errors,
        entries: built.map((e) => ({ id: shortId(e.id), date: e.date, type: e.type, category: e.category, amount: e.amount, note: e.note })),
      }
    },
  }
}

function renderBatch(v, cfg) {
  if (typeof v === 'string') return v
  if (v.error) return `Error: ${v.error}`
  const lines = v.entries.map((e) => entryLine(e, cfg.currency))
  let out = `已记 ${v.written}/${v.total} 笔：\n${lines.join('\n')}`
  if (v.errors.length) {
    out += `\n跳过 ${v.errors.length} 笔（第 ${v.errors.map((x) => x.index + 1).join('、')} 项：${v.errors[0].error}${v.errors.length > 1 ? ' 等' : ''}）`
  }
  return out
}

// ---- tally_list ----
function toolList(cfg) {
  return {
    name: 'tally_list',
    description:
      'List recorded entries, defaulting to the current month. ' +
      'One line per entry with a short id. Use keyword to search notes/categories. ' +
      'Bounded output to keep token usage low.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        month: { type: 'string', description: 'Month YYYY-MM (default current month)' },
        category: { type: 'string', description: 'Filter by exact category' },
        keyword: { type: 'string', description: 'Search term in note or category' },
        limit: { type: 'number', description: 'Max entries to return (range 1-50, default 20)' },
        includeDeleted: { type: 'boolean', description: 'Also list soft-deleted entries (marked [已删]), for finding ids to restore' },
      },
    },
    timeoutMs: 10000,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: renderList(v, cfg) }] },
    async execute(args) {
      const file = resolveStoragePath(cfg)
      const data = loadLedger(file)
      const month = /^\d{4}-\d{2}$/.test(args.month || '') ? args.month : todayISO().slice(0, 7)
      const category = args.category ? String(args.category) : null
      const keyword = args.keyword ? String(args.keyword).toLowerCase() : null
      const limit = Math.max(1, Math.min(50, Number(args.limit) || 20))
      const showDeleted = args.includeDeleted === true
      const entries = data.entries
        .filter((e) => e.date.startsWith(month))
        .filter((e) => showDeleted || activeOnly(e))
        .filter((e) => !category || e.category === category)
        .filter((e) => !keyword || e.note.toLowerCase().includes(keyword) || e.category.toLowerCase().includes(keyword))
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt))
      const shown = entries.slice(0, limit)
      return { month, total: entries.length, shown: shown.length, limit, entries: shown.map((e) => ({ id: shortId(e.id), date: e.date, type: e.type, category: e.category, amount: e.amount, note: e.note, deleted: !!e.deleted })) }
    },
  }
}

function renderList(v, cfg) {
  if (typeof v === 'string') return v
  if (v.error) return `Error: ${v.error}`
  if (!v.entries.length) return `[${v.month}] 没有记录`
  const lines = v.entries.map((e) => entryLine(e, cfg.currency) + (e.deleted ? ' [已删]' : ''))
  const more = v.total > v.shown ? `\n(共 ${v.total} 笔，显示前 ${v.shown} 笔 — 可缩小范围或增大 limit)` : ''
  return `[${v.month}] ${v.total} 笔:\n${lines.join('\n')}${more}`
}

// ---- tally_stats ----
function toolStats(cfg) {
  return {
    name: 'tally_stats',
    description:
      'Summary statistics. Pass month for a monthly summary (expense/income/balance, top categories, daily average, budget status); ' +
      'pass year (without month) for a full-year report (12 months + totals). ' +
      'Compact single-block output to save tokens.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        month: { type: 'string', description: 'Month YYYY-MM (default current month)' },
        year: { type: 'string', description: 'Year YYYY for annual report (use alone, without month)' },
      },
    },
    timeoutMs: 10000,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: renderStats(v, cfg) }] },
    async execute(args) {
      const file = resolveStoragePath(cfg)
      const data = loadLedger(file)
      const yearArg = /^\d{4}$/.test(args.year || '') ? args.year : ''
      const monthArg = /^\d{4}-\d{2}$/.test(args.month || '') ? args.month : ''
      if (yearArg && !monthArg) {
        const months = []
        for (let m = 1; m <= 12; m++) {
          const prefix = `${yearArg}-${String(m).padStart(2, '0')}`
          const es = data.entries.filter((e) => activeOnly(e) && e.date.startsWith(prefix))
          let exp = 0
          let inc = 0
          for (const e of es) if (e.type === 'income') inc += e.amount; else exp += e.amount
          months.push({
            month: prefix,
            expense: Math.round(exp * 100) / 100,
            income: Math.round(inc * 100) / 100,
            balance: Math.round((inc - exp) * 100) / 100,
            count: es.length,
          })
        }
        const totalExp = months.reduce((s, m) => s + m.expense, 0)
        const totalInc = months.reduce((s, m) => s + m.income, 0)
        return {
          year: yearArg,
          months,
          expense: Math.round(totalExp * 100) / 100,
          income: Math.round(totalInc * 100) / 100,
          balance: Math.round((totalInc - totalExp) * 100) / 100,
          count: months.reduce((s, m) => s + m.count, 0),
        }
      }
      const month = monthArg || todayISO().slice(0, 7)
      const entries = data.entries.filter((e) => e.date.startsWith(month) && activeOnly(e))
      let expense = 0
      let income = 0
      const byCat = new Map()
      for (const e of entries) {
        if (e.type === 'income') income += e.amount
        else {
          expense += e.amount
          byCat.set(e.category, (byCat.get(e.category) || 0) + e.amount)
        }
      }
      const top = [...byCat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
      const days = new Set(entries.map((e) => e.date)).size || 1
      const budget = data.budgets[month] || 0
      const [py, pm] = month.split('-').map(Number)
      const prevMonth = pm === 1 ? `${py - 1}-12` : `${py}-${String(pm - 1).padStart(2, '0')}`
      const prevExpense = data.entries
        .filter((e) => activeOnly(e) && e.date.startsWith(prevMonth) && e.type === 'expense')
        .reduce((s, e) => s + e.amount, 0)
      const changePct = prevExpense > 0 ? Math.round(((expense - prevExpense) / prevExpense) * 1000) / 10 : null
      return {
        month,
        expense: Math.round(expense * 100) / 100,
        income: Math.round(income * 100) / 100,
        balance: Math.round((income - expense) * 100) / 100,
        count: entries.length,
        dailyAvg: Math.round((expense / days) * 100) / 100,
        topCategories: top.map(([c, a]) => ({ category: c, amount: Math.round(a * 100) / 100 })),
        budget: Math.round(budget * 100) / 100,
        budgetOver: budget > 0 && expense > budget,
        budgetNear: budget > 0 && expense >= budget * 0.8 && expense <= budget,
        prevMonth,
        prevExpense: Math.round(prevExpense * 100) / 100,
        changePct,
      }
    },
  }
}

function renderStats(v, cfg) {
  if (typeof v === 'string') return v
  if (v.error) return `Error: ${v.error}`
  if (v.year) {
    const rows = v.months
      .filter((m) => m.count > 0)
      .map((m) => `  ${Number(m.month.slice(5))}月 支出 ${fmtMoney(m.expense, cfg.currency)} · 收入 ${fmtMoney(m.income, cfg.currency)} · 结余 ${signMoney(m.balance, cfg.currency)} · ${m.count} 笔`)
    return `[${v.year}] 全年支出 ${fmtMoney(v.expense, cfg.currency)} · 收入 ${fmtMoney(v.income, cfg.currency)} · 结余 ${signMoney(v.balance, cfg.currency)} · ${v.count} 笔\n${rows.join('\n') || '  (无记录)'}`
  }
  const bal = signMoney(v.balance, cfg.currency)
  const top = v.topCategories.length
    ? `\n类别 Top：${v.topCategories.map((t) => `${t.category} ${fmtMoney(t.amount, cfg.currency)}`).join(' · ')}`
    : ''
  let trendNote = ''
  if (v.changePct !== null) trendNote = `\n较上月 ${v.changePct >= 0 ? '+' : ''}${v.changePct}%（上月 ${fmtMoney(v.prevExpense, cfg.currency)}）`
  else if (v.expense > 0) trendNote = '\n（上月无支出）'
  let budgetNote = ''
  if (v.budget) {
    budgetNote = v.budgetOver
      ? `\n⚠️ 预算 ${fmtMoney(v.budget, cfg.currency)}，已超支 ${fmtMoney(v.expense - v.budget, cfg.currency)}`
      : v.budgetNear
        ? `\n⚠️ 预算 ${fmtMoney(v.budget, cfg.currency)} 已使用 80%，剩余 ${fmtMoney(v.budget - v.expense, cfg.currency)}`
        : `\n预算 ${fmtMoney(v.budget, cfg.currency)} · 剩余 ${fmtMoney(v.budget - v.expense, cfg.currency)}`
  }
  return `[${v.month}] 支出 ${fmtMoney(v.expense, cfg.currency)} · 收入 ${fmtMoney(v.income, cfg.currency)} · 结余 ${bal} · ${v.count} 笔 · 日均支出 ${fmtMoney(v.dailyAvg, cfg.currency)}${top}${trendNote}${budgetNote}`
}

// ---- tally_remove ----
function toolRemove(cfg) {
  return {
    name: 'tally_remove',
    description:
      'Remove an entry by its short id (from tally_list). ' +
      'First call returns the entry for confirmation; pass confirm=true to actually delete.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Short id (8 chars) of the entry to remove' },
        confirm: { type: 'boolean', description: 'Set true on the second call to confirm deletion' },
      },
      required: ['id'],
    },
    timeoutMs: 5000,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: renderRemove(v, cfg) }] },
    async execute(args) {
      const id = String(args.id || '').trim().toLowerCase()
      if (!id) return { error: 'id is required' }
      const file = resolveStoragePath(cfg)
      const data = loadLedger(file)
      const match = data.entries.find((e) => activeOnly(e) && (shortId(e.id).toLowerCase() === id || e.id === id))
      if (!match) return { error: `未找到 id: ${id}` }
      if (args.confirm !== true) {
        return { needConfirm: true, entry: { id: shortId(match.id), date: match.date, type: match.type, category: match.category, amount: match.amount, note: match.note } }
      }
      await enqueueWrite(() => {
        const d = loadLedger(file)
        const m = d.entries.find((e) => e.id === match.id)
        if (m && !m.deleted) {
          m.deleted = true
          m.deletedAt = Date.now()
        }
        saveLedger(file, d)
      })
      return { removed: true, id: shortId(match.id) }
    },
  }
}

function renderRemove(v, cfg) {
  if (typeof v === 'string') return v
  if (v.error) return `Error: ${v.error}`
  if (v.removed) return `已删除 (id: ${v.id}，可随时用 tally_restore 恢复)`
  if (v.needConfirm) {
    return `确认删除这笔？再次调用 tally_remove 并传 confirm=true 才会删除（删除后可恢复）：\n${entryLine(v.entry, cfg.currency)}`
  }
  return '操作未完成'
}

// ---- tally_restore ----
function toolRestore(cfg) {
  return {
    name: 'tally_restore',
    description:
      'Restore a soft-deleted entry (tally_remove marks entries deleted, not erased). ' +
      'Find the deleted entry id with tally_list(includeDeleted=true), then restore it here.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Short id (8 chars) of the deleted entry to restore' },
      },
      required: ['id'],
    },
    timeoutMs: 5000,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: renderRestore(v, cfg) }] },
    async execute(args) {
      const id = String(args.id || '').trim().toLowerCase()
      if (!id) return { error: 'id is required' }
      const file = resolveStoragePath(cfg)
      const data = loadLedger(file)
      const match = data.entries.find((e) => e.deleted && (shortId(e.id).toLowerCase() === id || e.id === id))
      if (!match) return { error: `未找到已删除的 id: ${id}` }
      await enqueueWrite(() => {
        const d = loadLedger(file)
        const m = d.entries.find((e) => e.id === match.id)
        if (m && m.deleted) {
          delete m.deleted
          delete m.deletedAt
        }
        saveLedger(file, d)
      })
      return { restored: true, id: shortId(match.id), date: match.date, type: match.type, category: match.category, amount: match.amount, note: match.note }
    },
  }
}

function renderRestore(v, cfg) {
  if (typeof v === 'string') return v
  if (v.error) return `Error: ${v.error}`
  if (v.restored) return `已恢复：${entryLine(v, cfg.currency)}`
  return '操作未完成'
}

// ---- tally_budget ----
function toolBudget(cfg) {
  return {
    name: 'tally_budget',
    description:
      'Get or set a monthly expense budget. ' +
      'Pass amount to set (or overwrite) the budget for a month; omit amount to query current status. ' +
      'tally_stats also reports budget status when one is set.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        month: { type: 'string', description: 'Month YYYY-MM (default current month)' },
        amount: { type: 'number', description: 'Budget amount in yuan (positive, up to 2 decimals). Omit to query.' },
      },
    },
    timeoutMs: 5000,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: renderBudget(v, cfg) }] },
    async execute(args) {
      const file = resolveStoragePath(cfg)
      const month = /^\d{4}-\d{2}$/.test(args.month || '') ? args.month : todayISO().slice(0, 7)
      const data = loadLedger(file)
      if (args.amount !== undefined && args.amount !== null) {
        const amount = normalizeAmount(args.amount)
        if (amount === null) return { error: 'amount must be a positive number (max 2 decimals)' }
        const prev = data.budgets[month] || 0
        await enqueueWrite(() => {
          const d = loadLedger(file)
          d.budgets[month] = amount
          saveLedger(file, d)
        })
        return { month, budget: amount, prevBudget: prev, action: 'set' }
      }
      const budget = data.budgets[month] || 0
      const spent = data.entries
        .filter((e) => activeOnly(e) && e.date.startsWith(month) && e.type === 'expense')
        .reduce((s, e) => s + e.amount, 0)
      return {
        month,
        budget: Math.round(budget * 100) / 100,
        spent: Math.round(spent * 100) / 100,
        remaining: Math.round((budget - spent) * 100) / 100,
        over: budget > 0 && spent > budget,
      }
    },
  }
}

function renderBudget(v, cfg) {
  if (typeof v === 'string') return v
  if (v.error) return `Error: ${v.error}`
  if (v.action === 'set') {
    return v.prevBudget
      ? `预算已更新：${v.month} ${fmtMoney(v.prevBudget, cfg.currency)} → ${fmtMoney(v.budget, cfg.currency)}`
      : `预算已设置：${v.month} ${fmtMoney(v.budget, cfg.currency)}`
  }
  if (!v.budget) return `[${v.month}] 未设置预算`
  const rem = v.remaining >= 0 ? `剩余 ${fmtMoney(v.remaining, cfg.currency)}` : `已超支 ${fmtMoney(-v.remaining, cfg.currency)}`
  return `[${v.month}] 预算 ${fmtMoney(v.budget, cfg.currency)} · 已支出 ${fmtMoney(v.spent, cfg.currency)} · ${rem}${v.over ? ' ⚠️' : ''}`
}

// ---- tally_export ----
function csvField(s) {
  const v = String(s)
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v
}

function toolExport(cfg) {
  return {
    name: 'tally_export',
    description:
      'Export the ledger. format=csv writes a CSV file (UTF-8 BOM, opens cleanly in Excel/WPS); ' +
      'format=html writes a self-contained HTML report (open in any browser: stats, category chart, filterable table). ' +
      'Defaults to the current month. Pass path to choose the output location (relative paths resolve against the DSH home). ' +
      'Returns { file, count, bytes, format }.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        month: { type: 'string', description: 'Month YYYY-MM (default current month)' },
        format: { type: 'string', enum: ['csv', 'html'], description: 'csv = spreadsheet file (default); html = browser report' },
        path: { type: 'string', description: 'Optional output file path (default <ledger-dir>/exports/...)' },
      },
    },
    timeoutMs: 10000,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: renderExport(v) }] },
    async execute(args) {
      const file = resolveStoragePath(cfg)
      const data = loadLedger(file)
      const month = /^\d{4}-\d{2}$/.test(args.month || '') ? args.month : todayISO().slice(0, 7)
      const format = args.format === 'html' ? 'html' : 'csv'
      const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
      const activeCount = data.entries.filter((e) => activeOnly(e) && e.date.startsWith(month)).length
      if (format === 'html') {
        if (!data.entries.length) return { month, count: 0, format }
        const html = buildHtmlReport({ entries: data.entries, budgets: data.budgets, currency: cfg.currency, month })
        const outPath = args.path
          ? path.resolve(home, String(args.path))
          : path.join(path.dirname(file), 'exports', `tally-report-${month}.html`)
        mkdirSync(path.dirname(outPath), { recursive: true })
        writeFileSync(outPath, html, 'utf8')
        return { month, count: activeCount, format, file: outPath, bytes: Buffer.byteLength(html, 'utf8') }
      }
      const entries = data.entries
        .filter((e) => activeOnly(e) && e.date.startsWith(month))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.createdAt - b.createdAt))
      if (!entries.length) return { month, count: 0 }
      const rows = [['date', 'type', 'category', 'amount', 'note']]
      for (const e of entries) rows.push([e.date, e.type, e.category, String(e.amount), e.note || ''])
      // UTF-8 BOM prefix: Excel/WPS on zh-CN Windows would read the file as GBK
      // (garbling Chinese) without it.
      const csv = '\uFEFF' + rows.map((r) => r.map(csvField).join(',')).join('\n')
      const outPath = args.path
        ? path.resolve(home, String(args.path))
        : path.join(path.dirname(file), 'exports', `tally-${month}.csv`)
      mkdirSync(path.dirname(outPath), { recursive: true })
      writeFileSync(outPath, csv, 'utf8')
      return { month, count: entries.length, format, file: outPath, bytes: Buffer.byteLength(csv, 'utf8'), csv }
    },
  }
}

function renderExport(v) {
  if (typeof v === 'string') return v
  if (v.error) return `Error: ${v.error}`
  if (!v.count && !v.file) return `[${v.month}] 没有记录可导出`
  if (v.format === 'html') {
    return `已导出 HTML 账目报告（当月 ${v.count} 笔 · ${v.bytes} 字节，含全部月份数据）：\n${v.file}\n浏览器打开即可查看（月份/类别筛选、统计卡片、类别占比图）。修改账目请回到对话。`
  }
  const preview = v.csv.split('\n').slice(0, 4).join('\n')
  return `已导出 CSV（${v.count} 笔 · ${v.bytes} 字节 · UTF-8 BOM，Excel/WPS 可直接打开）：\n${v.file}\n预览：\n${preview}${v.count > 3 ? '\n...' : ''}`
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) }
  console.log('[dsh-tally] plugin loaded; tools tally_add, tally_batch, tally_list, tally_stats, tally_remove, tally_restore, tally_budget, tally_export')
  ctx.tools.register(toolAdd(cfg))
  ctx.tools.register(toolBatch(cfg))
  ctx.tools.register(toolList(cfg))
  ctx.tools.register(toolStats(cfg))
  ctx.tools.register(toolRemove(cfg))
  ctx.tools.register(toolRestore(cfg))
  ctx.tools.register(toolBudget(cfg))
  ctx.tools.register(toolExport(cfg))
}

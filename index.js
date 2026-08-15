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
    if (!existsSync(file)) return { entries: [] }
    const data = JSON.parse(readFileSync(file, 'utf8'))
    return Array.isArray(data.entries) ? data : { entries: [] }
  } catch {
    return { entries: [] }
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

function entryLine(e, currency) {
  const type = e.type === 'income' ? '收' : '支'
  const note = e.note ? ` ${e.note}` : ''
  return `${fmtDate(e.date)} ${type} ${e.category} ${fmtMoney(e.amount, currency)}${note} (id: ${shortId(e.id)})`
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
      const amount = normalizeAmount(args.amount)
      if (amount === null) return { error: 'amount must be a positive number (max 2 decimals)' }
      const type = args.type === 'income' ? 'income' : 'expense'
      const category = String(args.category || '其他').slice(0, 20)
      const note = String(args.note || '').slice(0, 50)
      const date = isValidDate(args.date) ? args.date : todayISO()
      const entry = { id: randomUUID(), date, type, category, note, amount, createdAt: Date.now() }
      const file = resolveStoragePath(cfg)
      await enqueueWrite(() => {
        const data = loadLedger(file)
        data.entries.push(entry)
        saveLedger(file, data)
      })
      return { id: shortId(entry.id), date, type, category, note, amount }
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
      const entries = data.entries
        .filter((e) => e.date.startsWith(month))
        .filter((e) => !category || e.category === category)
        .filter((e) => !keyword || e.note.toLowerCase().includes(keyword) || e.category.toLowerCase().includes(keyword))
        .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt - a.createdAt))
      const shown = entries.slice(0, limit)
      return { month, total: entries.length, shown: shown.length, limit, entries: shown.map((e) => ({ id: shortId(e.id), date: e.date, type: e.type, category: e.category, amount: e.amount, note: e.note })) }
    },
  }
}

function renderList(v, cfg) {
  if (typeof v === 'string') return v
  if (v.error) return `Error: ${v.error}`
  if (!v.entries.length) return `[${v.month}] 没有记录`
  const lines = v.entries.map((e) => entryLine(e, cfg.currency))
  const more = v.total > v.shown ? `\n(共 ${v.total} 笔，显示前 ${v.shown} 笔 — 可缩小范围或增大 limit)` : ''
  return `[${v.month}] ${v.total} 笔:\n${lines.join('\n')}${more}`
}

// ---- tally_stats ----
function toolStats(cfg) {
  return {
    name: 'tally_stats',
    description:
      'Monthly summary: total expense/income, balance, top categories and daily average. ' +
      'Compact single-block output to save tokens.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        month: { type: 'string', description: 'Month YYYY-MM (default current month)' },
      },
    },
    timeoutMs: 10000,
    output: { schema: { type: 'object', additionalProperties: true }, render: (_a, v) => [{ type: 'text', text: renderStats(v, cfg) }] },
    async execute(args) {
      const file = resolveStoragePath(cfg)
      const data = loadLedger(file)
      const month = /^\d{4}-\d{2}$/.test(args.month || '') ? args.month : todayISO().slice(0, 7)
      const entries = data.entries.filter((e) => e.date.startsWith(month))
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
      return {
        month,
        expense: Math.round(expense * 100) / 100,
        income: Math.round(income * 100) / 100,
        balance: Math.round((income - expense) * 100) / 100,
        count: entries.length,
        dailyAvg: Math.round((expense / days) * 100) / 100,
        topCategories: top.map(([c, a]) => ({ category: c, amount: Math.round(a * 100) / 100 })),
      }
    },
  }
}

function renderStats(v, cfg) {
  if (typeof v === 'string') return v
  if (v.error) return `Error: ${v.error}`
  const bal = v.balance >= 0 ? `+${fmtMoney(v.balance, cfg.currency)}` : `-${fmtMoney(-v.balance, cfg.currency)}`
  const top = v.topCategories.length
    ? `\n类别 Top：${v.topCategories.map((t) => `${t.category} ${fmtMoney(t.amount, cfg.currency)}`).join(' · ')}`
    : ''
  return `[${v.month}] 支出 ${fmtMoney(v.expense, cfg.currency)} · 收入 ${fmtMoney(v.income, cfg.currency)} · 结余 ${bal} · ${v.count} 笔 · 日均支出 ${fmtMoney(v.dailyAvg, cfg.currency)}${top}`
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
      const match = data.entries.find((e) => shortId(e.id).toLowerCase() === id || e.id === id)
      if (!match) return { error: `未找到 id: ${id}` }
      if (args.confirm !== true) {
        return { needConfirm: true, entry: { id: shortId(match.id), date: match.date, type: match.type, category: match.category, amount: match.amount, note: match.note } }
      }
      await enqueueWrite(() => {
        const d = loadLedger(file)
        const idx = d.entries.findIndex((e) => e.id === match.id)
        if (idx >= 0) d.entries.splice(idx, 1)
        saveLedger(file, d)
      })
      return { removed: true, id: shortId(match.id) }
    },
  }
}

function renderRemove(v, cfg) {
  if (typeof v === 'string') return v
  if (v.error) return `Error: ${v.error}`
  if (v.removed) return `已删除 (id: ${v.id})`
  if (v.needConfirm) {
    return `确认删除这笔？再次调用 tally_remove 并传 confirm=true 才会删除：\n${entryLine(v.entry, cfg.currency)}`
  }
  return '操作未完成'
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULTS, ...(config || {}) }
  console.log('[dsh-tally] plugin loaded; tools tally_add, tally_list, tally_stats, tally_remove')
  ctx.tools.register(toolAdd(cfg))
  ctx.tools.register(toolList(cfg))
  ctx.tools.register(toolStats(cfg))
  ctx.tools.register(toolRemove(cfg))
}

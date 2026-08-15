// report.js — self-contained HTML report for dsh-tally (zero dependencies)
// Builds a single .html file with embedded data: stats cards, category bar
// chart, filterable table. Open in any browser, no server needed.

export function buildHtmlReport({ entries, budgets, currency, month }) {
  const data = {
    currency: currency || '¥',
    month,
    budgets: budgets || {},
    entries: entries.map((e) => ({
      id: e.id,
      date: e.date,
      type: e.type,
      category: e.category,
      amount: e.amount,
      note: e.note || '',
      deleted: !!e.deleted,
    })),
  }
  // Safe embedding: escape `</` so a note containing "</script>" cannot break out.
  const json = JSON.stringify(data).replace(/</g, '\\u003c')
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>tally 账目报告</title>
<style>
  *{box-sizing:border-box}
  body{font-family:system-ui,-apple-system,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;margin:0;background:#f5f6f8;color:#1f2328}
  .wrap{max-width:920px;margin:0 auto;padding:24px 16px 80px}
  h1{font-size:20px;margin:6px 0 2px}
  .sub{color:#656d76;font-size:13px;margin-bottom:16px}
  .stats{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}
  .card{background:#fff;border:1px solid #e1e4e8;border-radius:10px;padding:12px 16px;flex:1;min-width:130px}
  .card .label{font-size:12px;color:#656d76}
  .card .value{font-size:22px;font-weight:600;margin-top:4px}
  .card .value.neg{color:#d8433a}
  .card .value.pos{color:#1a7f37}
  .filters{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;align-items:center}
  select,input[type=text]{padding:7px 10px;border:1px solid #d0d7de;border-radius:8px;font-size:14px;background:#fff}
  input[type=text]{flex:1;min-width:160px}
  label.switch{font-size:13px;color:#57606a;display:flex;align-items:center;gap:4px;cursor:pointer}
  h2{font-size:15px;color:#57606a;margin:20px 0 8px;font-weight:600}
  .chart{background:#fff;border:1px solid #e1e4e8;border-radius:10px;padding:14px 16px}
  .bar-row{display:flex;align-items:center;gap:8px;margin-bottom:7px;font-size:13px}
  .bar-row .name{width:72px;flex-shrink:0;text-align:right}
  .bar-row .amt{width:96px;flex-shrink:0;text-align:right;color:#656d76}
  .bar-track{flex:1;background:#eef1f4;border-radius:5px;height:16px;overflow:hidden}
  .bar-fill{height:100%;background:#4f8cff;border-radius:5px}
  table{width:100%;border-collapse:collapse;background:#fff;border:1px solid #e1e4e8;border-radius:10px;overflow:hidden;font-size:14px}
  th,td{padding:9px 12px;text-align:left;border-bottom:1px solid #f0f1f3}
  th{background:#fafbfc;font-weight:600;color:#57606a}
  tr.deleted td{opacity:.45}
  .tag{display:inline-block;padding:1px 8px;border-radius:999px;font-size:12px}
  .tag.expense{background:#fff1f0;color:#d8433a}
  .tag.income{background:#effaf0;color:#1a7f37}
  .tag.del{background:#f1f2f4;color:#8b949e}
  .id{font-family:ui-monospace,Consolas,monospace;font-size:11px;color:#8b949e}
  .empty{text-align:center;color:#8b949e;padding:26px 0;font-size:14px}
  .hint{font-size:12px;color:#8b949e;margin-top:14px;line-height:1.7}
</style>
</head>
<body>
<div class="wrap">
  <h1>📒 tally 账目报告</h1>
  <div class="sub" id="sub"></div>
  <div class="stats" id="stats"></div>
  <div class="filters">
    <select id="monthSel" title="月份"></select>
    <select id="catSel" title="类别"><option value="">全部类别</option></select>
    <input type="text" id="q" placeholder="搜索备注 / 类别">
    <label class="switch"><input type="checkbox" id="showDel"> 显示已删</label>
  </div>
  <h2>类别占比</h2>
  <div class="chart" id="chart"></div>
  <h2>明细</h2>
  <div id="tableWrap"></div>
  <div class="hint">💡 修改 / 删除账目请回到 DSH 对话（说"删掉那笔 id 是 xxx 的"）。本报告为静态导出，不修改账本数据。</div>
</div>
<script>
const DATA = ${json};
const CUR = DATA.currency || '¥';
const fmt = (n) => CUR + Number(n).toLocaleString('zh-CN', {minimumFractionDigits: 2, maximumFractionDigits: 2});
const sign = (n) => (n >= 0 ? '+' : '-') + fmt(Math.abs(n));
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const monthLabel = (m) => m ? m.slice(0, 4) + '年' + Number(m.slice(5)) + '月' : '';

// months present in data (entries + budgets)
const months = [...new Set([...DATA.entries.map(e => e.date.slice(0,7)), ...Object.keys(DATA.budgets)])].sort();
const monthSel = document.getElementById('monthSel');
months.forEach(m => { const o = document.createElement('option'); o.value = m; o.textContent = monthLabel(m); monthSel.appendChild(o); });
if (!months.includes(DATA.month)) DATA.month = months[0] || new Date().toISOString().slice(0,7);
monthSel.value = DATA.month;

const catSel = document.getElementById('catSel');
[...new Set(DATA.entries.map(e => e.category))].sort().forEach(c => { const o = document.createElement('option'); o.value = c; o.textContent = c; catSel.appendChild(o); });

const curEntries = () => DATA.entries.filter(e => e.date.slice(0,7) === monthSel.value && (!catSel.value || e.category === catSel.value) && (!showDel.checked ? !e.deleted : true) && (!q.value || (e.note + e.category).toLowerCase().includes(q.value.toLowerCase())));
const curAll = () => DATA.entries.filter(e => e.date.slice(0,7) === monthSel.value && (!showDel.checked ? !e.deleted : true));

function renderStats() {
  const es = curAll();
  let expense = 0, income = 0, byCat = {};
  const days = new Set();
  for (const e of es) { days.add(e.date); if (e.type === 'income') income += e.amount; else { expense += e.amount; byCat[e.category] = (byCat[e.category] || 0) + e.amount; } }
  const budget = DATA.budgets[monthSel.value] || 0;
  const [py, pm] = monthSel.value.split('-').map(Number);
  const prev = pm === 1 ? py - 1 + '-12' : py + '-' + String(pm - 1).padStart(2, '0');
  const prevExpense = DATA.entries.filter(e => !e.deleted && e.date.slice(0,7) === prev && e.type === 'expense').reduce((s, e) => s + e.amount, 0);
  const changePct = prevExpense > 0 ? Math.round(((expense - prevExpense) / prevExpense) * 1000) / 10 : null;
  const dailyAvg = days.size ? Math.round((expense / days.size) * 100) / 100 : 0;
  const balance = income - expense;
  let html = '';
  html += card('本月支出', fmt(expense), expense > 0 ? 'neg' : '');
  html += card('本月收入', fmt(income), income > 0 ? 'pos' : '');
  html += card('结余', sign(balance), balance < 0 ? 'neg' : '');
  html += card('笔数', es.length + ' 笔', '');
  html += card('日均支出', fmt(dailyAvg), '');
  if (budget) {
    const pct = Math.round((expense / budget) * 100);
    const status = expense > budget ? 'neg' : (expense >= budget * 0.8 ? '' : '');
    const label = expense > budget ? '超支 ' + fmt(expense - budget) : (expense >= budget * 0.8 ? '已用 ' + pct + '%' : '剩余 ' + fmt(budget - expense));
    html += card('预算 ' + fmt(budget), label, status);
  }
  let trend = '';
  if (changePct !== null) trend = '较上月 ' + (changePct >= 0 ? '+' : '') + changePct + '%（上月 ' + fmt(prevExpense) + '）';
  else if (expense > 0) trend = '上月无支出';
  document.getElementById('stats').innerHTML = html;
  document.getElementById('sub').textContent = monthLabel(monthSel.value) + (trend ? ' · ' + trend : '');
}
function card(label, value, cls) { return '<div class="card"><div class="label">' + esc(label) + '</div><div class="value ' + cls + '">' + value + '</div></div>'; }

function renderChart() {
  const es = curAll().filter(e => e.type === 'expense');
  const byCat = {};
  for (const e of es) byCat[e.category] = (byCat[e.category] || 0) + e.amount;
  const rows = Object.entries(byCat).sort((a, b) => b[1] - a[1]);
  const max = rows.length ? rows[0][1] : 1;
  const el = document.getElementById('chart');
  if (!rows.length) { el.innerHTML = '<div class="empty">本月暂无支出</div>'; return; }
  el.innerHTML = rows.map(([c, a]) =>
    '<div class="bar-row"><span class="name">' + esc(c) + '</span>' +
    '<div class="bar-track"><div class="bar-fill" style="width:' + Math.round((a / max) * 100) + '%"></div></div>' +
    '<span class="amt">' + fmt(a) + '</span></div>').join('');
}

function renderTable() {
  const es = curEntries().slice().sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  const wrap = document.getElementById('tableWrap');
  if (!es.length) { wrap.innerHTML = '<div class="empty">没有匹配的记录</div>'; return; }
  wrap.innerHTML = '<table><thead><tr><th>日期</th><th>类型</th><th>类别</th><th>金额</th><th>备注</th><th>id</th></tr></thead><tbody>' +
    es.map(e => '<tr class="' + (e.deleted ? 'deleted' : '') + '"><td>' + esc(e.date) + '</td>' +
      '<td><span class="tag ' + e.type + '">' + (e.type === 'income' ? '收入' : '支出') + '</span></td>' +
      '<td>' + esc(e.category) + '</td>' +
      '<td>' + (e.type === 'income' ? fmt(e.amount) : fmt(e.amount)) + '</td>' +
      '<td>' + esc(e.note) + (e.deleted ? ' <span class="tag del">已删</span>' : '') + '</td>' +
      '<td class="id">' + e.id.slice(0, 8) + '</td></tr>').join('') + '</tbody></table>';
}

const showDel = document.getElementById('showDel');
const q = document.getElementById('q');
monthSel.onchange = renderAll;
catSel.onchange = renderAll;
showDel.onchange = renderAll;
q.oninput = renderAll;
function renderAll() { renderStats(); renderChart(); renderTable(); }
renderAll();
</script>
</body>
</html>`
}

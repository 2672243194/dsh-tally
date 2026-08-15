# dsh-tally

DeepSeek Harness 个人记账插件：**记一笔、查账、月度汇总**，纯本地零依赖。

- 记支出/收入，内置中文分类（餐饮/交通/购物/居住/娱乐/医疗/教育/人情/工资/其他，可自定义）
- 按月/类别/关键词查账，紧凑一行一笔
- 月度汇总：支出/收入/结余、类别 Top5、日均支出
- 月度预算 + 超支提醒、年度统计、CSV 导出
- 删除二次确认，防误删
- 数据存本机 `$DSH_HOME/plugins/tally.json`，不上传、无 API key

## 为什么做它

DSH 生态的"财务类"插件有 60+ 个，但**全部是 token 用量/成本监控**（记录"DSH 烧了多少 token 钱"）或企业会计工作流（`dsh-finance` 的分录/对账/审计）。**个人收支记账是真空**——dsh-tally 是第一个。

## 竞品调研

2026-08-15 GitHub API 交叉验证，检索范围：英文 `bookkeeping / expense / ledger / accounting / money / budget / spending / finance / reimburse` + 中文 `记账 / 账单 / 收支 / 账本 / 预算 / 消费`，逐条核对 60+ 个"财务类"插件，分三类：

| 类别 | 数量 | 代表 |
|---|---|---|
| token 用量/成本监控 | 50+ | TokenLedger、dsh-cost、usage-ledger、balance-monitor |
| 企业会计工作流 | 1 | `dsh-finance`（分录/对账/报表/SOX 审计） |
| 量化金融 | 2 | 行情/投资 |

个人收支记账：**无**——dsh-tally 填补该空位。

## 安装

```bash
# 从 GitHub（推荐）
npx @deepseek-ai/dsh plugin --profile web add github:2672243194/dsh-tally

# 本地开发
npx @deepseek-ai/dsh plugin --profile web add ./dsh-tally
```

重启 DSH 后，设置 → 插件列表应看到 `dsh-tally` 已启用。

## 使用

直接对话：

```
记一笔：今天午饭 28 元，餐饮
这个月花了多少钱？统计一下
查一下上个月"交通"类目
记错了，删掉那笔 id 是 a1b2c3 的
这个月预算 3000 元
看看这个月预算还剩多少
统计一下今年
把这个月的账导出成 CSV
```

### 工具

**`tally_add(amount, type?, category?, note?, date?)`** — 记一笔

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `amount` | number | 必填 | 金额（元，>0，最多两位小数） |
| `type` | string | `expense` | `expense` 支出 / `income` 收入 |
| `category` | string | `其他` | 内置分类或自定义 |
| `note` | string | 空 | 备注（≤50 字，可搜索） |
| `date` | string | 今天 | `YYYY-MM-DD` |

**`tally_list(month?, category?, keyword?, limit?)`** — 查账（默认当月、日期倒序、每笔一行含短 id）

**`tally_stats(month?, year?)`** — 汇总
- 传 `month`：月度汇总（紧凑单块）：
```
[2026-08] 支出 ¥186.00 · 收入 ¥8,000.00 · 结余 +¥7,814.00 · 12 笔 · 日均支出 ¥75.50
类别 Top：餐饮 ¥860 · 交通 ¥420 · 购物 ¥380
预算 ¥3,000.00 · 剩余 ¥2,814.00        （设了预算才有；超支时显示 ⚠️）
```
- 传 `year`（不带 month）：全年报告，逐月列出 + 全年总计：
```
[2026] 全年支出 ¥15,432.00 · 收入 ¥96,000.00 · 结余 +¥80,568.00 · 215 笔
  1月 支出 ¥1,200.00 · 收入 ¥8,000.00 · 结余 +¥6,800.00 · 18 笔
  ...
```

**`tally_remove(id, confirm?)`** — 删错账：首次调用返回待删详情，**传 `confirm: true` 才会删除**

**`tally_budget(month?, amount?)`** — 预算：传 `amount` 设置/覆盖当月预算，省略则查询（预算/已支出/剩余/是否超支）；`tally_stats` 同步显示预算状态

**`tally_export(month?)`** — CSV 导出：返回当月账目 CSV 文本（`date,type,category,amount,note`，RFC-4180 转义），**带 UTF-8 BOM**（存为 `.csv` 后 Excel/WPS 双击打开中文正常），默认当月

## 存储与安全

- 数据：`$DSH_HOME/plugins/tally.json`（`storagePath` 配置可迁移）；
- **原子写入**（tmp + rename）+ **串行写入队列**（并行调用不丢账）；
- 零依赖、无网络请求、无数据上传；
- 删除需二次确认，写操作受 DSH 权限/审批策略保护。

## 省 token 设计

- 紧凑文本 render（模型直接读，无需解析 JSON）；
- `tally_list` 默认 20 条并提示"共 N 笔，显示前 20"；
- `tally_stats` 单块汇总，不 dump 全量；
- 静态 schema（配置变更不影响 KV 缓存前缀）。

## 开发

```bash
node test.mjs          # 24 个零依赖断言（增删查改/汇总/预算/年度/导出/并发/持久化）

# 端到端验证（临时环境，不污染真实账本）
export DSH_HOME=./.dsh-tally-verify
dsh plugin --profile headless add ./dsh-tally
dsh --profile headless "用 tally_add 记一笔早餐 12 元，然后 tally_stats 统计本月"
```

## Roadmap

已完成：
- [x] 月度预算 + 超支提醒（`tally_budget` + `tally_stats` 联动）
- [x] 年度统计（`tally_stats(year=...)` 全年逐月报告）
- [x] CSV 导出（`tally_export`）

后续想法：
- [ ] 多账本（工作/生活分开记账）
- [ ] 周期账（每月自动重复的固定支出）
- [ ] 预算到期自动提醒（月度检查）

## License

MIT

# dsh-tally

DeepSeek Harness 个人记账插件：**记一笔、查账、月度汇总**，纯本地零依赖。

- 记支出/收入，内置中文分类（餐饮/交通/购物/居住/娱乐/医疗/教育/人情/工资/其他，可自定义）
- 按月/类别/关键词查账，紧凑一行一笔
- 月度汇总：支出/收入/结余、类别 Top5、日均支出
- 删除二次确认，防误删
- 数据存本机 `$DSH_HOME/plugins/tally.json`，不上传、无 API key

## 为什么做它

DSH 生态的"财务类"插件有 60+ 个，但**全部是 token 用量/成本监控**（记录"DSH 烧了多少 token 钱"）或企业会计工作流（`dsh-finance` 的分录/对账/审计）。**个人收支记账是真空**（2026-08-15 GitHub API 交叉验证：英文 bookkeeping/expense/budget/spending/finance + 中文 记账/账单/收支/账本/预算，逐条核对无一撞车）。

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

**`tally_stats(month?)`** — 月度汇总（紧凑单块）：
```
[2026-08] 支出 ¥186.00 · 收入 ¥8,000.00 · 结余 +¥7,814.00 · 12 笔 · 日均支出 ¥75.50
类别 Top：餐饮 ¥860 · 交通 ¥420 · 购物 ¥380
```

**`tally_remove(id, confirm?)`** — 删错账：首次调用返回待删详情，**传 `confirm: true` 才会删除**

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
node test.mjs          # 14 个零依赖断言（增删查改/汇总/并发/持久化）

# 端到端验证（临时环境，不污染真实账本）
export DSH_HOME=./.dsh-tally-verify
dsh plugin --profile headless add ./dsh-tally
dsh --profile headless "用 tally_add 记一笔早餐 12 元，然后 tally_stats 统计本月"
```

## Roadmap

- [ ] 月度预算 + 超支提醒
- [ ] 年度统计
- [ ] CSV 导出

## License

MIT

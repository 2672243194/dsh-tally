# Third-Party Notices

dsh-tally **零运行时依赖**——仅使用 Node.js 20+ 内置能力（`crypto` / `fs` / `path` / `os`），无第三方库。

无外部服务、无 API key、无数据上传。所有数据存储在本机 `$DSH_HOME/plugins/tally.json`（可通过 `storagePath` 配置迁移）。

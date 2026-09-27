# DepotDrive V1.0 实现差距

## 距离最终验收目标

| 验收场景 | 当前距离 | 判断依据 |
|---|---|---|
| 浏览器上传 100 MB | **接近，但未实测** | 分片、四 worker、最终校验路径存在；只有 mock/小 buffer 测试，无真实浏览器 + PostgreSQL + filesystem 100 MB 流程。 |
| 断网恢复且仅传缺失分片 | **API 基础存在，产品流程不完整** | pause/resume 会 GET completed chunks；页面刷新或浏览器重启后的会话发现/选择/恢复 UI 不存在，网络重试耗尽后也不会自动 reconcile。 |
| 两个独立节点保存一致文件 | **未达到** | 两个目录在一个 API 容器和一个 volume；复制后没有目标 checksum 验证。 |
| 停止 Primary 后从 Replica 下载 | **逻辑回退存在，真实场景不可执行** | mock 和“移动本地文件”测试代码存在；没有可停止的 Primary service，本次集成套件也未运行。 |
| 节点恢复/替换后自动补副本 | **未实现** | 无 repair controller/reconciler、无副本状态机或 replacement 操作。 |
| 损坏副本后检测并恢复 | **未实现** | 下载和后台均不核验 replica content；无 scrub/repair。 |
| 自动化测试与可复现演示 | **部分实现** | unit/typecheck/build 通过；集成测试默认跳过，无 CI、故障注入和 demo record。 |

## 功能差距矩阵

### P0 级差距

1. **故障域名不副实**：A/B/C 共进程、共 volume。系统不能承受 API/volume 故障，且无法进行可信故障演示。
2. **silent corruption**：读取不验 checksum，损坏 Primary 会把坏数据成功返回，不会 fallback。
3. **跨 DB/文件系统操作不可恢复**：仅内联补偿，崩溃或补偿失败后无 durable record/reconciliation。
4. **资源耗尽**：认证用户可创建无限 session 和并发 chunk 请求，逻辑 capacity 不强制，缺少 quota/rate/concurrency controls。
5. **关键集成测试非默认门禁**：默认绿色结果包含 16 个 skipped tests。

### P1 级差距

1. heartbeat 仅检测，不修复；缺少 under-replicated/corrupt replica 扫描。
2. 缺少 replica lifecycle、generation、verification timestamp 和 repair lease。
3. 恢复上传只在当前页面 task 生命周期内可用；没有 reload/restart 恢复入口。
4. 重复/并发同 chunk、complete/cancel、双 complete、cleanup 与上传并发缺少系统性测试。
5. 两节点都不可用使用 404；需要稳定、可重试的 503 语义。
6. read stream 中途失败、slow/hung node、timeout 没有处理策略。
7. 容量 placement 不以 object size 做 admission，usedBytes 扫描成本随对象数线性增长。

### P2 级差距

1. UI 不展示 active uploads，不支持刷新后选择文件并验证 fingerprint 后恢复。
2. 无 Playwright/Cypress 类浏览器 E2E、可访问性检查、100 MB 演示脚本。
3. 无 CI workflow、测试数据库 service、测试报告 artifact。
4. readiness/observability 不足：没有 DB/quorum readiness、结构化 repair metrics、操作 runbook。
5. 文档需清楚区分 replica fallback、failure detection、repair 和故障域。

## 代码级具体缺口

### UploadSession / UploadChunk

- `saveChunk()` 的“查 DB→写同一路径→插 DB”不是原子的；并发首次上传相同 index 会出现 last-rename 与 DB winner 分离。
- existing chunk 仅验证 DB metadata 和文件存在，不重新 hash 物理 chunk。
- `cancel()` 删除磁盘后再删 DB；后半失败会留下损坏 session。
- cleanup 仅从 DB 枚举过期 session，无法找到 DB 不可见的孤儿目录。
- 未限制 active sessions、总暂存 bytes 或 chunk concurrency。

### Replica / StorageNode

- `replicateFrom()` 忽略 `node.upload()` 返回的 size/checksum。
- 没有每份 replica 的 state/checksum/generation/lastVerifiedAt。
- health 不是独立节点 probe；无请求 timeout。
- 删除部分成功时没有 DELETING tombstone/background retry。
- 没有把文件大小传入 placement，也没有 node-side capacity enforcement。

### Read path

- exists/open 成功即返回；不验证 byte count 或 checksum。
- open 后 stream error 只能中断客户端，不能透明 fallback。
- 全部副本暂时不可用返回 404，错误分类错误。

### Auth / authorization

- 缺少 rate limit、JWT revocation、管理员角色和 CSRF/origin policy。
- storage dashboard 是 authenticated-only 而不是 admin-only。
- register 的 read-then-create 有并发 race，P2002 返回 500。

### Test / delivery

- `TEST_DATABASE_URL` 未设置时 `describe.skip`，导致默认 test 命令无法证明 DB 集成。
- 没有 CI 或 Compose-based test profile。
- 没有跨进程节点、网络断开、磁盘损坏、process crash 的故障注入。

## 不建议引入的复杂度

V1 不需要 Kubernetes、Redis、消息队列或更多业务微服务。可用 PostgreSQL 中的 replica/job 状态、`FOR UPDATE SKIP LOCKED`/advisory lock、两个简单 storage-node HTTP 进程和定时 reconciler 达成清晰且可测试的实现。

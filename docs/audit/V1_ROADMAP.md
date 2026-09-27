# DepotDrive V1.0 开发路线图

原则：先让数据安全和故障语义真实，再补自愈与断点续传体验，最后做 UI、CI 与演示。不引入 Kubernetes、Redis 或消息队列；PostgreSQL 可承担 V1 的持久化工作队列/协调。

## 依赖图

```text
P0-1 独立节点边界 ─┬─> P0-2 副本状态机/持久补偿 ─┬─> P1-1 自动修复
                   │                            └─> P1-2 checksum scrub
                   └─> P0-3 完整性读取

P0-4 资源与认证防护
P0-5 默认真实集成测试 ─> P1-3 故障/并发测试 ─> P2-2 CI 与演示
P1-4 持久断点续传 UI ─────────────────────────> P2-1 前端完善
```

## P0：数据丢失、安全漏洞、核心功能错误

### P0-1：把存储节点变成独立故障域

- **当前问题及代码证据**：`apps/api/src/app.ts:24-25` 在 API 进程内创建三个 `StorageNodeLocal`；`docker-compose.yml:40-41` 仅有一个 `uploads_data` volume。停止 API 或 volume 故障会同时失去全部“节点”。
- **建议实现方案**：提取一个最小 storage-node HTTP 服务，暴露 authenticated health/capacity/PUT/GET/HEAD/DELETE；Compose 运行两个（可选第三个）实例，每个独立 named volume。API 实现带 connect/read timeout 的 `StorageNodeHttp`，节点配置来自环境变量。保留 interface，不重写上层业务。
- **涉及文件**：`apps/api/src/storage/storage-node.ts`、新增 `storage-node-http.ts`；新增 `apps/storage-node/`；`apps/api/src/app.ts`、配置 schema、`.env.example`、`docker-compose.yml`、Dockerfiles。
- **可自动验证的验收标准**：Compose 中至少两个 storage services 和两个不同 volumes；上传后直接查询两个 node 均有相同 size/checksum；停止 Primary container 后 API 仍能下载；停止两者返回 503；测试证明 API process 不持有 node filesystem path。
- **依赖关系**：无；是副本修复与真实故障测试的基础。
- **预计复杂度**：高。

### P0-2：引入副本生命周期与持久化补偿

- **当前问题及代码证据**：`ReplicaService.deletePlacements()` 的失败只日志记录；`UploadService.complete()` 在文件系统与 DB 间依赖 best-effort 删除。进程 crash 可产生孤儿副本/staging；部分删除后 metadata 仍声称两份完整副本。
- **建议实现方案**：为 `FileReplica` 增加 `state`（WRITING/HEALTHY/CORRUPT/DELETING/FAILED）、expected checksum/size、generation 和 retry metadata；在 PostgreSQL 建 `StorageOperation`/outbox 表。先持久化意图，再执行幂等 node operation，最后 transaction 发布状态。单个后台 reconciler 用 DB row lock/lease 重试，另有 orphan/staging 清理策略。
- **涉及文件**：Prisma schema/migration；`replica-service.ts`、`uploads/service.ts`、`files/routes.ts`、`server.ts`；新增 reconciler service 与测试。
- **可自动验证的验收标准**：在“第一副本后 crash”“两副本后 DB 前 crash”“DB commit 后 cleanup 前 crash”“删除一个成功一个失败”四个故障点重启，最终收敛到 2 个 HEALTHY 或完整删除；操作至少一次执行但结果幂等；无未追踪对象。
- **依赖关系**：建议基于 P0-1 的远程节点 API。
- **预计复杂度**：高。

### P0-3：完整性校验读取与正确错误语义

- **当前问题及代码证据**：`ReplicaService.openDownload():55-57` 只做 health/exists/open；复制时忽略 node upload 返回 checksum。损坏 Primary 会被成功返回；全副本不可用返回 404。
- **建议实现方案**：节点 PUT 返回并由 API 校验 size/checksum；下载可由 node 在 HEAD 返回可信 checksum（写入时保存）并由周期 scrub 复验，或 API 对 stream 做 hash 验证后再对客户端发布。V1 为保证 fallback 正确，可先将验证后的内容流入临时文件再发送，100 MB 目标可接受；后续再优化 streaming。损坏标 CORRUPT，尝试下一份；暂时无可用副本返回 503，真正 metadata 不存在才 404。
- **涉及文件**：storage node contract/implementations、`replica-service.ts`、`files/routes.ts`、Prisma replica fields、错误 DTO、tests。
- **可自动验证的验收标准**：人为翻转 Primary 字节后下载返回原文件且 Primary 被标 CORRUPT；两份都坏返回 503/明确 error code；复制目标 checksum 不符时文件不发布；无坏内容以 200 返回。
- **依赖关系**：P0-1；状态持久化与 P0-2 协同。
- **预计复杂度**：高。

### P0-4：资源限制与认证安全基线

- **当前问题及代码证据**：服务端没有 rate limit、active session/并发 chunk/temporary bytes quota；`auth/routes.ts` 无 brute-force protection 且并发注册 P2002 成 500；普通用户可访问全局 storage dashboard。
- **建议实现方案**：增加简单的 Fastify rate limits；PostgreSQL 查询/约束实现每用户 active sessions 与 logical reserved bytes；API 内 per-user/session semaphore 作为进程级保护，节点强制 capacity admission；注册捕获 unique conflict；增加 role/admin guard；明确 Origin/CSRF policy、安全 headers；将上传 reservation 在完成/取消/过期时释放。
- **涉及文件**：auth/upload/storage routes、env、Prisma migration、Fastify plugins、shared errors、tests。
- **可自动验证的验收标准**：超 quota/session/concurrency 返回 429/413；并发注册一个 201 一个 409；登录爆破触发 429；普通用户访问 dashboard 为 403；跨站 mutation 被拒；所有 reservation 在失败路径释放。
- **依赖关系**：可与 P0-1/P0-2 并行；capacity reservation 与 P0-2 状态机协调。
- **预计复杂度**：中。

### P0-5：让 PostgreSQL 集成测试成为默认门禁

- **当前问题及代码证据**：`integration.test.ts` 在无 `TEST_DATABASE_URL` 时 `describe.skip`；本次 16 个用例全部跳过，仓库无 CI。
- **建议实现方案**：提供 `compose.test.yml` 或 testcontainers/明确脚本启动隔离 PostgreSQL、执行 `prisma migrate deploy`、运行 integration tests、清理资源。默认 `test:integration` 缺 DB 时失败，不静默跳过；unit 和 integration 分开报告。
- **涉及文件**：root/API package scripts、Vitest config、integration setup、Compose test config、后续 CI workflow。
- **可自动验证的验收标准**：全新环境单命令运行 migration + 16+ integration tests；没有 skipped；DB 名称/volume 与开发数据隔离；失败退出非 0。
- **依赖关系**：无；应最早完成，以保护其余 P0。
- **预计复杂度**：中。

## P1：断点续传、复制一致性、故障恢复及必要测试

### P1-1：自动副本修复与角色收敛

- **当前问题及代码证据**：heartbeat 仅更新 ALIVE/DEAD，没有扫描 under-replicated file、恢复节点或替换节点；不存在并发 repair 协调。
- **建议实现方案**：reconciler 查询少于 2 个 HEALTHY replicas 的文件；从 verified healthy source 复制到不同 ALIVE node。用 PostgreSQL lease/row lock 保证每个 file generation 只有一个 repair owner；完成后 transaction 更新状态/角色。Primary 坏时可明确 promote 一个 verified Replica，再补新 Replica。
- **涉及文件**：Prisma schema、heartbeat/reconciler/replica services、server lifecycle、dashboard API、tests。
- **可自动验证的验收标准**：停止 Primary→读取 fallback→启动/替换 node→最终恢复 2 HEALTHY；两个 repair worker 同时运行不产生第三份重复 metadata；中途失败可重试；角色最终恰好一个 PRIMARY。
- **依赖关系**：P0-1、P0-2、P0-3。
- **预计复杂度**：高。

### P1-2：周期 scrub 与损坏自动恢复

- **当前问题及代码证据**：没有 replica verification timestamp 或后台 checksum scan，损坏无法主动发现。
- **建议实现方案**：低并发 scrub job 分批选择过期未验证副本，调用节点 checksum/stream 校验；标 CORRUPT 并触发 P1-1 repair。限制并发和 I/O，记录 lastVerifiedAt、failure reason 和 metrics。
- **涉及文件**：Prisma migration、node API、reconciler/scrubber、config、dashboard、tests。
- **可自动验证的验收标准**：不发起下载也能在 bounded interval 检测人为损坏；自动从健康副本恢复；修复后两份 checksum 相同；两份都坏时不覆盖唯一剩余证据并产生 actionable state。
- **依赖关系**：P0-3、P1-1。
- **预计复杂度**：中。

### P1-3：并发、崩溃和故障注入测试矩阵

- **当前问题及代码证据**：现有测试多为 mock；未覆盖重复首次 chunk race、双 complete、cancel/cleanup race、stream 中断、两节点 down、repair race。
- **建议实现方案**：为 service boundary 加 deterministic failpoints；在真实 PostgreSQL 和独立 storage containers 上构建集成测试。用固定 seed/temporary volumes，避免 flaky sleeps，轮询明确状态。
- **涉及文件**：API/storage-node tests、test helpers、Compose test profile、scripts。
- **可自动验证的验收标准**：覆盖重复/乱序 chunk、四并发及恶意超限、重试/取消、complete crash points、partial replica write、single/both nodes down、corruption、repair concurrency；连续多次运行稳定通过。
- **依赖关系**：P0-5；各场景跟随 P0-1/P0-2/P1-1 落地。
- **预计复杂度**：高。

### P1-4：跨页面生命周期的断点续传

- **当前问题及代码证据**：API 能列出 sessions，但 `DrivePage` 未使用 `/api/uploads` 列表；页面刷新后 task 丢失。
- **建议实现方案**：在文件页展示 ACTIVE sessions；用户重新选择本地文件后校验 name/size/file checksum（或先用 size+lastModified 提示，再最终 hash 确认），连接到已有 session，GET completed chunks 并仅传缺失片。网络失败后提供 Resume，不删除 session。
- **涉及文件**：`DrivePage.tsx`、`chunked-upload.ts`、API DTO/routes、前端 tests。
- **可自动验证的验收标准**：100 MB 上传 40% 时刷新页面，重新选择同文件，仅 PUT 缺失 index；选择不同内容被拒；过期 session 清晰提示；cancel 后 DB 和磁盘最终清理。
- **依赖关系**：P0-5；最好在 P1-3 的测试 harness 上验证。
- **预计复杂度**：中。

## P2：前端体验、文档、演示与部署

### P2-1：前端可靠性与可观察体验

- **当前问题及代码证据**：UI 有主要 CRUD，但无 active session 列表、repair/degraded 状态、可靠失败重试；组件测试很少。
- **建议实现方案**：展示上传队列、可恢复状态、明确的 retry/cancel；下载 503 与 corruption 提示；dashboard 展示 HEALTHY/DEGRADED/REPAIRING 和最后验证时间。补键盘操作、ARIA、焦点管理与组件测试。
- **涉及文件**：Web pages/components/styles、shared DTO、API dashboard endpoints、front-end tests。
- **可自动验证的验收标准**：关键流程浏览器 E2E 通过；错误状态可理解且可恢复；基本 accessibility scan 无严重问题；移动/桌面布局可用。
- **依赖关系**：P1-1、P1-2、P1-4。
- **预计复杂度**：中。

### P2-2：CI、100 MB 演示与可复现记录

- **当前问题及代码证据**：无项目 CI；Docker daemon 本次不可用；没有最终七场景 demo script/artifacts。
- **建议实现方案**：CI 启动 PostgreSQL + 两个 storage nodes，依次 lint/typecheck/unit/integration/build/E2E；添加一个不提交大二进制的 deterministic 100 MB generator 和 demo runner，保存 checksum、HTTP transcript、node object metadata、repair events 和测试报告 artifact。
- **涉及文件**：`.github/workflows/*`、scripts、Compose profiles、Playwright config、docs/runbook。
- **可自动验证的验收标准**：干净 runner 一键通过；七个最终验收场景都有自动断言和时间戳 artifact；CI 不允许 skipped integration；演示命令不依赖手工改 DB。
- **依赖关系**：P0-5、P1 全部。
- **预计复杂度**：中。

### P2-3：部署/运维文档与健康语义

- **当前问题及代码证据**：`/health` 只证明 API 进程存活；文档容易把本地目录称作节点、把 fallback 称作 recovery。
- **建议实现方案**：拆分 liveness/readiness；readiness 检查 DB 和最小写入/读取 quorum（不做重负载全盘检查）；记录本地 Compose 拓扑、failure domains、RPO/RTO 非承诺、repair runbook、环境变量与安全默认值。
- **涉及文件**：health route、config、README、`docs/`、Compose healthchecks。
- **可自动验证的验收标准**：DB down/read quorum loss 时 readiness 非 200 而 liveness 仍可用；文档命令在 clean environment 通过；术语明确区分 detection/fallback/repair。
- **依赖关系**：P0-1、P1-1、P2-2。
- **预计复杂度**：低。

## 建议的首个开发阶段

第一阶段建议只做 **P0-5 → P0-1 → P0-2/P0-3**：先让真实集成测试成为门禁，再建立两个可独立停止的 storage node，随后实现可恢复的副本状态和完整性读取。这个阶段结束时，应能可信演示“两份独立副本、Primary 停止后 fallback、坏副本不返回、崩溃后状态可收敛”。之后再进入自动修复和 UI 体验。

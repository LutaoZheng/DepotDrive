# DepotDrive V1.0 代码审计报告

审计日期：2026-09-26  
审计范围：当前工作区源码、Prisma schema/migrations、Docker Compose、环境变量、前后端 API、测试与 CI 配置。  
约束：本次只读审计、执行现有命令并新增 `docs/audit/` 文档；未修改业务代码，未部署，未提交或推送 Git。

## 执行摘要

DepotDrive 已经是一个可辨识的云盘原型，而不是空壳：它包含 JWT Cookie 认证、按 `ownerId` 隔离的文件/文件夹 API、8 MiB 分片、浏览器端最多四个 chunk worker、上传会话、SHA-256 上传校验、PostgreSQL 元数据、两份副本写入、Primary 优先读取与 Replica 回退、心跳元数据和 React 文件管理界面。

但它还不是具有独立故障域、自愈和端到端可证明性的“分布式云存储”。最关键的事实是：A/B/C 三个节点只是同一 API 进程下、同一个 Docker volume 中的三个目录；下载不校验内容 checksum；不存在损坏扫描、自动副本修复、节点替换或持久化补偿队列。默认测试还跳过了全部 16 个 PostgreSQL 集成用例。

综合判断：按 V1.0 十项目标，当前约 **50% 的功能骨架已实现，约 30–35% 达到可重复验证程度**。这一比例是工程判断，不是性能测量；不能用于简历中的可用性或可靠性承诺。

## 证据等级

- **A：实际命令通过**：本次运行成功。
- **B：自动化测试通过**：测试可能是 mock/单元级，不代表真实多节点环境。
- **C：代码存在但未做有效运行验证**。
- **D：未实现或实现与目标语义不符**。

## 十项目标逐项审计

| # | V1.0 能力 | 判定 | 证据 | 实际缺口 |
|---|---|---|---|---|
| 1 | 用户认证和文件访问权限 | **部分实现** | `apps/api/src/modules/auth/routes.ts` 的 `register/login/me/logout`；`apps/api/src/middleware/auth.ts`；文件、文件夹、上传会话均以 `req.user.sub` 查询。`apps/api/tests/integration.test.ts` 有未认证及跨用户 404 用例，但本次被跳过。Cookie/JWT 单测通过（B）。 | 无登录/注册限流、账户锁定、密码重置、JWT 撤销；并发注册的 unique race 会落入通用 500；无显式 CSRF token；存储 dashboard 对所有普通用户暴露全局节点统计。数据库级租户隔离未建立。 |
| 2 | 8 MiB 分片、最多四个并行任务 | **部分实现** | `packages/shared/src/index.ts` 定义 8 MiB 和 `MAX_PARALLEL_CHUNKS=4`；`apps/web/src/chunked-upload.ts:141-155` 创建最多四个 worker；API 根据配置校验 chunk 大小。前端相关单测通过（B）。 | “四并行”只由可信客户端自律，服务端没有每用户/每会话并发上限；没有真实 100 MB 上传测试；无磁盘配额预留或背压，多个客户端可无限并发。前后端 chunk size 来源可独立配置，若服务端改值，初次整文件 hash 的步长仍固定为共享常量（虽不影响最终 hash，但语义分裂）。 |
| 3 | 缺失分片查询与断点续传 | **部分实现** | `UploadSessionDto.completedChunks`、`GET /api/uploads/:uploadId`、`UploadService.create()` 的会话复用；恢复时前端重新 GET 并只发送缺失索引。pause/resume mock 测试通过（B）。 | UI 刷新/浏览器重启后没有“选择或恢复已有会话”的产品流程；网络重试耗尽后直接失败，不自动重新同步缺失列表；没有显式 client idempotency key，当前复用条件还忽略 `mimeType`；并发重复 chunk 的磁盘 rename 与 DB unique 竞争不是原子的。 |
| 4 | 两个物理独立存储节点保存完整副本 | **存在缺陷** | `ReplicaService.replicateFrom()` 顺序写两个不同 node id；`FileReplica` 对 `(fileId,nodeId)` 唯一；单元测试验证两个 node id（B）。 | `apps/api/src/app.ts:24-25` 把 A/B/C 建成同一进程内的 `StorageNodeLocal`；`docker-compose.yml:40-41` 只挂载一个 `uploads_data` volume。它们是两个目录，不是两个物理独立节点/故障域；API 进程或 volume 故障会同时失去全部副本。 |
| 5 | Primary 不可用时回退健康 Replica | **部分实现** | `ReplicaService.openDownload()` 按 Primary→Replica 顺序，跳过 DEAD/陈旧/缺失对象并处理打开 stream 失败；3 个相关单元测试通过（B）。 | 没有可独立停止的节点服务，因此未验证“停止 Primary”；健康检查只是对本地目录 `mkdir`；读取过程开始后的中途 stream 错误无法切换；checksum 损坏不会触发回退；两节点均不可用返回 404，而不是明确的 503/降级状态。 |
| 6 | Heartbeat、故障检测、自动副本修复 | **部分实现** | `HeartbeatService.tick()`、`StorageMetadataService.recordHeartbeat/markStaleDead`；失败期限逻辑和 tick mock 测试通过（B）。 | 只有状态采集，没有 repair controller、缺副本扫描、重新复制、角色提升或节点替换；本地 health 总是尝试创建目录，无法表达真实远程节点宕机；定时 `tick()` 未防止重叠执行，也无 leader election。 |
| 7 | SHA-256 完整性及损坏恢复 | **部分实现** | `LocalFileStorage.saveChunk()` 校验每片；`assembleChunks()` 校验最终大小和 SHA-256；chunk storage 三个测试通过（B）。 | `ReplicaService.replicateFrom()` 忽略目标节点返回的 checksum；下载只检查 exists，不计算/比较 `File.checksum`；无 scrub、损坏标记、隔离或从健康副本重建。人为损坏副本会被原样返回。 |
| 8 | PostgreSQL 元数据一致性及失败补偿 | **部分实现** | 文件与 replica metadata 在 Prisma transaction 中发布；副本写失败和 DB 发布失败有 best-effort 删除；上传会话用 `ACTIVE→COMPLETING` claim。补偿单元测试通过（B）。 | DB 与文件系统不存在原子事务；补偿失败只记录日志且不持久化，产生孤儿对象；DB commit 后 staging/session 删除失败被吞掉；无 replica lifecycle 状态（WRITING/HEALTHY/CORRUPT/DELETING）、outbox/reconciler、幂等操作 id。容量选择未预留文件大小，节点也不强制容量。 |
| 9 | 可用 React 文件管理界面 | **已实现但未经测试** | 登录/注册、列表、面包屑、新建文件夹、重命名、删除、下载、上传进度/暂停/恢复/取消、存储 dashboard 均存在；前端 build/typecheck 通过（A），但没有页面级有效性测试。 | 没有浏览器 E2E、可访问性与大文件真实验证；已有 upload sessions 不在 UI 中展示；失败后缺少显式重试/恢复入口；dashboard 测试仅覆盖百分比 helper。 |
| 10 | Docker Compose 一键运行及自动化测试 | **部分实现** | `docker compose config --quiet` 通过；API/Web Dockerfile 存在；单元测试、typecheck、build 通过（A）。 | Docker daemon 未运行，未能 build/up；Compose 没有独立 storage-node services/volumes；没有仓库 CI workflow；集成测试依赖手工 `TEST_DATABASE_URL`，默认 `npm test` 静默跳过 16 个用例；没有 100 MB、故障注入、修复或损坏 E2E。 |

## 可靠性审计

### 分片、乱序与并发

- 乱序上传可工作：完成阶段按 index 顺序组装，并核对最终 checksum。
- 相同 metadata 的已存在 chunk 被视为幂等；不同 checksum 返回 409。
- 但两个首次请求同时写同一 index 时，都可能先看到“无 DB 记录”，随后各自 rename 到同一路径，再竞争 DB unique。DB winner 与磁盘最后 writer 没有事务关系。最终整文件 checksum 通常会阻止发布错误内容，但会造成难以恢复的 chunk/metadata 冲突和重复 I/O。
- 服务端没有并发、session 数、磁盘占用或用户配额限制；客户端四 worker 不是安全边界。

### 中断、超时、取消与重试

- 客户端 chunk 对网络错误/5xx 做 500/1000/2000 ms 重试，pause 会 abort 当前请求，resume 会重新查询服务端 completed chunks。
- 服务器没有 request deadline、慢上传速率下限或主动清理正在卡住的 stream。
- cancel 先删 session 目录再删 DB；若 DB 删除失败，留下一个仍显示 completed metadata、但磁盘 chunk 已消失的 session。
- 过期清理每小时运行且逐个 best-effort；只处理 DB 可见 session，不扫描孤儿目录、staging objects 或副本。

### DB 与物理文件不一致

- 正向发布采用“staging→两份物理副本→DB transaction→删除 staging”，基本顺序合理。
- 任何补偿删除失败都没有 durable retry；进程在物理写成功、DB commit 前崩溃会留下不可发现副本。
- 进程在 DB commit 后、删除 staging/chunks 前崩溃会留下临时数据。
- 删除文件时两个副本并行删除；若一个成功、一个失败，metadata 全部保留但系统已处于降级状态，无状态字段表达事实，也没有后台重试。

### 故障、回退与修复

- 当前实现是**读取回退**，不是自动故障恢复：不会提升 Replica、补齐缺失副本或处理恢复节点。
- 两节点都不可用时返回 `404 FILE_CONTENT_MISSING`，这会把暂时不可用误报为永久不存在，影响客户端重试和运维判断。
- 本地 node health 只验证目录可创建；无法模拟进程、网络、磁盘只读、超时或部分失败。
- 没有 repair lease/数据库锁；未来直接加并发 repair worker 会有重复副本和角色冲突风险。

### 完整性

- 上传路径 checksum 设计正确：chunk 和 assembled file 都校验。
- 副本落盘结果没有与源 checksum 比较；读取也没有校验，故 silent corruption 不可检测。
- `FileReplica` 不保存独立 checksum、verifiedAt、state 或 generation，无法记录哪份副本健康。

## 安全审计

### 已有防护

- 密码使用 bcrypt cost 12；Cookie 为 HttpOnly、SameSite=Lax，可按环境开启 Secure。
- 受保护 API 统一 JWT 验证；对象查询包含 owner id，跨用户通常返回 404。
- 文件名禁止 `/`、`\`、NUL；物理路径只接受 UUID-like storage key/chunk index，路径穿越面较小。
- 上传总大小、chunk body size、文件名和 MIME 长度有基本校验；API 不直接回传内部异常文本。

### 主要风险

1. **资源耗尽**：无 rate limit、用户配额、最大活跃 session/chunk 并发、总临时空间限制；攻击者注册后可创建大量 5 GB session 或并发流占满磁盘/CPU/DB。
2. **认证生命周期**：7 天 bearer JWT 无撤销；logout 只清 Cookie；无登录失败限流。并发相同邮箱注册的 P2002 未转换成 409。
3. **CSRF/浏览器安全**：SameSite=Lax 和精确 CORS 提供一定保护，但没有 CSRF token/origin guard，也没有 Helmet 类安全响应头。部署到同-site 子域时风险模型需重新评估。
4. **运维信息授权**：任意已登录用户可读取全局节点容量、heartbeat 与副本数量；应限制为管理员或只用于本地演示。
5. **健康接口**：`/health` 只返回进程 alive，不检查 DB 或达到读取/写入 quorum 的 readiness。

## API 与数据模型观察

- Prisma 使用 BIGINT 存储文件/session 大小，避免 5 GB 溢出；DTO 转为 JS number，在当前 5 GB 限制内安全。
- migrations 包含 root/nested folder 的部分唯一索引，但 Prisma schema 没有表达这些索引；`prisma validate` 仍通过，后续 schema diff 需要谨慎。
- `StorageNode.usedBytes` 来自每次递归扫描目录，文件规模增大后 heartbeat/placement 会变慢；且 placement 只判断 `used < capacity`，不判断剩余空间是否容纳当前对象。
- legacy multipart upload 与 chunked upload 两条路径同时存在，增加一致性与测试表面积；V1 应明确保留策略。

## 结论

当前项目适合展示“分片上传 + 元数据 + 副本读取回退”的设计演进，但还不能声称完成分布式容错存储。进入功能开发前，首先应建立真实可独立停止的存储节点、可持久化的 replica 状态/补偿模型以及完整性校验读取路径；否则后续 UI 或演示工作会建立在错误的可靠性假设上。

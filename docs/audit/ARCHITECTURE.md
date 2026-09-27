# DepotDrive 当前真实架构

本文描述仓库当前代码，而非 README 或目标架构。

## 运行时组件

```text
Browser / React 19 + React Query
  |  Cookie JWT, CORS credentials
  |  REST/HTTP
  v
Fastify API（单进程）
  |-- Auth / Folder / File / Upload / Storage routes
  |-- Upload staging: UPLOAD_ROOT/sessions + UPLOAD_ROOT/objects
  |-- StorageNodeLocal A: UPLOAD_ROOT/storage-nodes/A
  |-- StorageNodeLocal B: UPLOAD_ROOT/storage-nodes/B
  |-- StorageNodeLocal C: UPLOAD_ROOT/storage-nodes/C
  |
  +--> Prisma --> PostgreSQL 16

Docker Compose:
  web container -> API container -> PostgreSQL container
                         |
                         +--> one uploads_data volume containing staging and A/B/C
```

关键边界：A/B/C 是一个 API 进程内的对象，底层都使用 `LocalFileStorage`。它们没有独立进程、网络 endpoint、生命周期或 volume，所以不能独立停止，不能形成独立故障域。

## 主要源码边界

| 层 | 文件 | 职责 |
|---|---|---|
| Composition | `apps/api/src/app.ts` | Fastify 插件、路由、local storage nodes 组装 |
| Process lifecycle | `apps/api/src/server.ts` | DB connect、heartbeat timer、过期 session 清理、监听与 shutdown |
| Auth | `apps/api/src/modules/auth/*`, `middleware/auth.ts` | bcrypt、JWT Cookie、认证 hook |
| Chunk upload | `apps/api/src/modules/uploads/*` | session、chunk metadata、完成 claim、组装与发布 |
| File/folder | `apps/api/src/modules/files/routes.ts`, `folders/routes.ts` | owner-scoped CRUD 与下载 |
| Replica | `apps/api/src/modules/storage/replica-service.ts` | 两份写入、best-effort 补偿、读取回退 |
| Node metadata | `metadata-service.ts`, `heartbeat-service.ts`, `placement.ts` | heartbeat DB 状态、超时标死、least-utilized placement |
| Physical storage | `storage/local-file-storage.ts`, `storage-node-local.ts` | 原子临时文件 rename、SHA-256、目录容量扫描 |
| Database | `apps/api/prisma/schema.prisma` | User/Folder/File/UploadSession/Chunk/StorageNode/FileReplica |
| Frontend | `apps/web/src/pages/*`, `chunked-upload.ts` | 文件管理、上传 worker、dashboard |

## 分片上传数据流

1. 浏览器按 8 MiB 步长读取整个文件并计算 file SHA-256。
2. `POST /api/uploads` 创建或按 owner/folder/name/size/checksum 复用 ACTIVE session。
3. 浏览器从返回的 `completedChunks` 推导缺失 index，以最多四个 worker PUT chunk。
4. API 将 chunk 写临时文件，边写边校验大小和 header checksum，再 rename 到 session chunk path，最后插入 `UploadChunk`。
5. `POST .../complete` 检查 chunk metadata/存在性，CAS 风格把 session 改为 COMPLETING。
6. API 按 index 组装 staging object，同时校验最终 size/checksum。
7. `ReplicaService` 选择两个 ALIVE 节点，顺序复制完整对象；第二份失败会删除已写第一份。
8. Prisma transaction 创建 `File` 和两个 `FileReplica`，并删除 upload session metadata。
9. transaction 成功后 best-effort 删除 staging object 和 chunk 目录。

## 下载数据流

1. API 以 `(fileId, ownerId)` 查询，阻止跨用户读取。
2. 查询 FileReplica 及 StorageNode 状态。
3. 优先 PRIMARY，要求 metadata 为 ALIVE、heartbeat 新鲜、即时 health 为 alive、对象 exists。
4. 打开失败或前置条件不满足时尝试 REPLICA。
5. stream 打开后直接发送，不计算或比较 SHA-256。

因此目前支持的是“打开前失败回退”；不支持 stream 中途失败恢复，也不支持损坏内容回退。

## Heartbeat 与节点状态

- API 启动后立即 tick，并按 `HEARTBEAT_INTERVAL_MS` 定时 tick。
- 每个 `StorageNodeLocal.health()` 尝试 `mkdir(root)`；成功即 alive。
- capacity 递归遍历 node objects 目录计算 used bytes。
- heartbeat upsert `StorageNode`；超过 timeout 的 ALIVE 记录会变 DEAD。
- heartbeat 不触发副本修复、角色切换或节点 replacement。

## PostgreSQL 关系与一致性边界

```text
User 1--N Folder
User 1--N File 1--N FileReplica N--1 StorageNode
User 1--N UploadSession 1--N UploadChunk
Folder 1--N Folder (parent)
Folder 1--N File / UploadSession
```

强一致部分：

- File 与 FileReplica 的发布在同一个 PostgreSQL transaction 中。
- UploadSession 与 UploadChunk 有 FK/unique constraint。
- FileReplica 对 `(fileId,nodeId)` 唯一。

跨系统非原子部分：

- chunk file rename 与 UploadChunk insert。
- physical replica write/delete 与 File/FileReplica transaction。
- DB commit 后 staging/session cleanup。

这些边界依赖即时 best-effort compensation，没有持久化状态机或 reconciler。

## Docker 拓扑

Compose 只有 `postgres`、`api`、`web` 三个 service。`uploads_data` 是 API 的单个 volume。目标架构所需的两个独立 storage node service/volume、节点 API、网络 timeout/fault injection 均不存在。

## 配置

`.env.example` 覆盖 DB、JWT、CORS、Cookie、chunk/session/file limits、upload root、逻辑 node capacity 和 heartbeat timeout。缺少独立节点 endpoint/credential、repair interval/concurrency、scrub interval、用户 quota、request timeout 等配置。

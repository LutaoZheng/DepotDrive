# DepotDrive V0.3.1

[English](./README.md) | 简体中文

## 项目简介

DepotDrive 是一个可自行部署的私人云盘。V0.3.1 首次将元数据与二进制存储解耦，引入三个独立 Storage Node、双副本、心跳故障检测以及下载自动回退。

## 功能

- 注册、登录、退出及 Cookie 会话恢复
- 浏览根目录和无限层级文件夹，支持面包屑导航
- 创建、重命名文件夹，删除空文件夹
- 默认 8 MiB 分块、最多 4 个并发 worker、缺失 chunk 恢复和上传取消
- 每个 chunk 及最终组装文件均执行 SHA-256 校验
- 流式下载、文件展示名重命名及文件删除
- 当前用户存储用量、加载/错误/空状态和响应式 Drive 界面
- 所有资源查询均按用户隔离，访问其他用户资源统一返回 404
- 全局 401 会话失效处理和跨用户前端缓存隔离
- 新文件在 Storage A/B/C 中保存两份，Primary 不可用时自动回退 Replica
- Storage Node 心跳、30 秒故障检测、容量统计和实时 Dashboard

## 技术栈

- 前端：React、TypeScript、Vite、Tailwind CSS、React Router、TanStack Query、Axios
- 后端：Node.js、TypeScript、Fastify、Prisma、PostgreSQL、JWT、bcrypt、Zod、multipart
- 基础设施：npm workspaces、Docker、Docker Compose、本地文件系统
- 测试：Vitest、Fastify 集成测试

## 系统架构

```mermaid
flowchart TD
  Web[React Web] --> API[Fastify Metadata Service]
  API --> DB[(PostgreSQL 文件、节点和副本元数据)]
  API --> Registry[Storage Node Registry]
  Registry --> A[Storage Node A]
  Registry --> B[Storage Node B]
  Registry --> C[Storage Node C]
  A --> AFS[(storage-nodes/A)]
  B --> BFS[(storage-nodes/B)]
  C --> CFS[(storage-nodes/C)]
  Heartbeat[Heartbeat 与故障检测] --> Registry
  Heartbeat --> DB
```

Fastify 模块化单体当前承载 Metadata Service，但二进制存储已通过与传输无关的 `StorageNode` 接口隔离。`StorageNodeLocal` 为 A/B/C 提供互相独立的根目录；以后可以逐个替换为远程节点而无需修改上传和下载路由。`LocalFileStorage` 继续承担 staging 与 V0.2 旧文件兼容。

## 数据库 ER 图

```mermaid
erDiagram
  User ||--o{ Folder : owns
  User ||--o{ File : owns
  User ||--o{ UploadSession : owns
  Folder o|--o{ Folder : contains
  Folder o|--o{ File : contains
  Folder o|--o{ UploadSession : targets
  UploadSession ||--o{ UploadChunk : contains
  File ||--o{ FileReplica : has
  StorageNode ||--o{ FileReplica : stores

  User {
    uuid id PK
    string email UK
    string passwordHash
    datetime createdAt
    datetime updatedAt
  }

  Folder {
    uuid id PK
    uuid ownerId FK
    uuid parentId FK
    string name
    datetime createdAt
    datetime updatedAt
  }

  File {
    uuid id PK
    uuid ownerId FK
    uuid folderId FK
    string name
    string originalName
    string mimeType
    bigint sizeBytes
    string storageKey UK
    string checksum
    datetime createdAt
    datetime updatedAt
  }

  UploadSession {
    uuid id PK
    uuid ownerId FK
    uuid folderId FK
    bigint sizeBytes
    string fileChecksum
    int chunkSizeBytes
    int totalChunks
    string status
    datetime expiresAt
  }

  UploadChunk {
    uuid id PK
    uuid uploadSessionId FK
    int chunkIndex
    int sizeBytes
    string checksum
  }
```

`Folder.parentId` 和 `File.folderId` 可为空，表示位于云盘根目录。文件夹名称按 owner 和 parent 保持唯一；migration 使用 partial unique index 正确处理 PostgreSQL 根目录的 `NULL` 语义。

## 项目结构

```text
apps/web             React 前端
apps/api/src         Fastify 模块化单体 API
apps/api/prisma      Prisma schema 与 SQL migration
apps/api/uploads     本地开发文件存储目录
apps/api/tests       数据库集成测试与会话测试
packages/shared      前后端共享 DTO 和校验常量
```

## 本地开发

需要 Node.js 20+、npm 和 PostgreSQL 15+。

```bash
cp .env.example .env
npm install
npm run prisma:generate
npm run prisma:migrate
npm run dev
```

访问地址：

- 前端：`http://localhost:5173`
- API：`http://localhost:3000`
- PostgreSQL：`localhost:5432`

## Docker 运行

```bash
JWT_SECRET="请替换为至少32位随机字符串" docker compose up --build
```

Compose 会启动带健康检查的 PostgreSQL，等待数据库就绪后启动 API、应用已提交 migration，并通过 nginx 提供前端。`postgres_data` 和 `uploads_data` 使用命名 volume，容器重建后数据仍然保留。

## 环境变量

| 变量 | 说明 |
|---|---|
| `NODE_ENV` | `development`、`test` 或 `production` |
| `DATABASE_URL` | PostgreSQL 连接字符串 |
| `JWT_SECRET` | JWT 签名密钥；非测试环境至少 32 个字符 |
| `JWT_SESSION_SECONDS` | JWT 与 Cookie 的统一有效期，默认 604800 秒（7 天） |
| `CHUNK_SIZE_BYTES` | 服务端指定的 chunk 大小，默认 8388608（8 MiB） |
| `UPLOAD_SESSION_TTL_SECONDS` | 可恢复上传会话有效期，默认 86400 秒（24 小时） |
| `API_PORT` | API 端口，默认 `3000` |
| `WEB_ORIGIN` | 允许携带凭据的前端 CORS origin |
| `COOKIE_SECURE` | 生产 HTTPS 环境设为 `true` |
| `MAX_FILE_SIZE_BYTES` | 单文件上传上限，默认 5368709120 字节（5 GiB） |
| `UPLOAD_ROOT` | 临时文件与对象文件的存储根目录 |
| `VITE_API_BASE_URL` | 前端构建时写入的 API 地址 |

真实部署中不要使用示例或 Compose 的默认 JWT 密钥。

## 数据库与迁移

Prisma 的 `User`、`Folder` 和 `File` 模型分别存储账户、目录层级和文件元数据，二进制内容不写入 PostgreSQL。初始 migration 使用 partial unique index，确保 `parentId = NULL` 的根目录同样满足每用户同名唯一约束。

```bash
npm run prisma:migrate
npm run prisma:deploy -w @depot-drive/api
```

## 测试与构建

数据库集成测试需要独立的 `TEST_DATABASE_URL`。测试会清空应用表，请勿指向包含重要数据的数据库。

```bash
npm run typecheck
npm run test
npm run build

TEST_DATABASE_URL=postgresql://depot:depot@localhost:5432/depot_drive_test npm run test
```

未设置 `TEST_DATABASE_URL` 时，数据库集成测试会被明确标记为 skipped，不会静默使用开发数据库。

## API 概览

| 方法 | 路径 | 用途 |
|---|---|---|
| POST | `/api/auth/register` | 注册并创建会话 |
| POST | `/api/auth/login` | 登录 |
| GET | `/api/auth/me` | 获取当前用户 |
| POST | `/api/auth/logout` | 清除会话 |
| GET/POST | `/api/folders` | 浏览目录／创建文件夹 |
| PATCH/DELETE | `/api/folders/:folderId` | 重命名／删除空文件夹 |
| GET | `/api/folders/:folderId/breadcrumbs` | 获取目录祖先链 |
| POST | `/api/files/upload` | multipart 流式上传 |
| GET | `/api/files/:fileId/download` | 流式下载 |
| PATCH/DELETE | `/api/files/:fileId` | 重命名元数据／删除文件 |
| GET | `/api/users/storage` | 当前用户已用字节数 |
| GET | `/api/storage/nodes` | 节点健康、容量、心跳、Primary 与 Replica 数量 |
| POST/GET | `/api/uploads` | 创建或恢复／列出活跃上传 Session |
| GET/DELETE | `/api/uploads/:uploadId` | 查询进度／取消并清理 Session |
| PUT | `/api/uploads/:uploadId/chunks/:chunkIndex` | 流式上传并校验单个 chunk |
| POST | `/api/uploads/:uploadId/complete` | 组装、校验并发布文件 |

错误统一使用：

```json
{
  "error": {
    "code": "FOLDER_NOT_FOUND",
    "message": "Folder not found"
  }
}
```

## 文件存储设计

旧版上传仍流入 `uploads/tmp/<uuid>.part`。V0.2 chunk 独立校验后原子保存到 `uploads/sessions/<sessionId>/chunks/<index>`。complete 按 index 流式读取，不将完整文件载入内存；验证最终大小和 SHA-256 后，原子移动到 `uploads/objects/ab/cd/<uuid>`。完成、取消或过期时清理 Session 目录。

## 安全设计

- bcrypt cost 12 密码哈希，email 转小写并保持唯一
- JWT 存储于 `HttpOnly`、`SameSite=Lax` Cookie
- JWT 与 Cookie 有效期统一为默认 7 天；开发环境 `Secure=false`
- 严格 CORS origin、环境变量启动校验和 multipart 大小限制
- Zod 输入校验、非法文件名和路径穿越防护
- 所有资源查询同时包含资源 ID 与认证用户 ID
- 越权访问返回 404，避免泄露资源是否存在
- Prisma 参数化查询和显式 DTO，不暴露密码哈希或 storage key
- 全局 401 处理会清除用户状态和相关 Query 缓存，防止跨用户缓存泄漏

## 文件系统与数据库一致性

chunk 顺序为：临时流写入 → 大小/checksum 校验 → 原子移动 → chunk 元数据。complete 会原子抢占 Session，按序流式组装和校验，再将内容流式写入两个不同节点根目录。`File`、两条 `FileReplica` 与 UploadSession 删除在同一个数据库 transaction 中发布。transaction 失败会删除两个物理副本并把 Session 恢复为 ACTIVE；补偿删除失败会记录 node 与 storage key 日志。

新文件删除会先尝试全部副本，再删除 metadata。任一节点删除失败时 API 返回 `REPLICA_DELETE_FAILED`，并保留 File/FileReplica 记录，使故障仍可追踪并允许重试；其他已成功删除的副本会暂时显示为缺失。V0.2 legacy 文件继续使用 `LocalFileStorage` force-delete 兼容逻辑。当前没有跨数据库/文件系统事务或 orphan reconciliation，生产运维应同时备份 PostgreSQL 和 uploads volume。

## 当前限制

- 单 API 节点和本地文件系统
- 每个任务选择一个文件；暂不支持 Range 下载
- 不支持分享、配额、预览、搜索和回收站
- 文件夹只允许空目录删除，文件删除为永久删除
- 生产环境需要 HTTPS 反向代理并设置 `COOKIE_SECURE=true`
- Pause/Resume 支持当前页面生命周期。刷新会丢失浏览器 `File` 对象，本版本需重新开始；服务端 Session 与 chunks 会保留，为后续“重新选择相同文件恢复”流程提供基础。
- Storage Node 当前仍是在同一 API 进程中的独立本地目录实现。V0.3.1 明确不包含远程 RPC、repair、rebalancing、一致性哈希、Leader Election 或共识协议。
- 三个节点全部由同一个 API 进程承载；API 退出时 A/B/C 会同时停止。这是本地多节点故障路径模拟，不是三个独立远程服务器。
- 相对 `UPLOAD_ROOT` 固定以 monorepo workspace 根目录解析一次，不依赖 API 启动时的工作目录；文档默认路径对应 `apps/api/uploads` 的绝对路径。
- 下载可在节点 DEAD、不健康、对象缺失或 stream 打开失败时切换副本；一旦已有响应字节发送给客户端，后续 stream 失败无法在同一 HTTP 响应中安全切换，客户端需要重新下载。

## V0.3.1 分布式存储设计

- Metadata Service 在 PostgreSQL 中维护文件、节点和副本位置
- Storage A/B/C 使用隔离的文件系统根目录并实现与传输无关的 `StorageNode` 契约
- 每个新文件必须先成功写入一个 PRIMARY 和一个 REPLICA，之后才发布 metadata
- 每 10 秒模拟一次 heartbeat，超过 30 秒未更新的节点标记为 DEAD
- 下载跳过 DEAD、运行时不健康或对象缺失的 Primary，自动回退 Replica

## V0.2 上传设计

- 客户端增量计算最终 SHA-256
- 8 MiB 分块和 4 个并发上传 worker
- UploadSession/UploadChunk 持久化与缺失 chunk 查询
- chunk SHA-256、顺序流式组装和最终 SHA-256 校验
- 独立的 Pause/Resume（以服务端缺失 chunk 为准）、永久 Cancel、启动清理与每小时过期 Session 清理
- 网络错误和 5xx chunk 请求按 500/1000/2000 ms 退避重试，4xx 不重试

旧 multipart 上传接口和 V0.2 文件继续兼容。V0.3.1 只加入本地副本模拟，不引入 Redis、消息队列、分布式锁、S3、远程 RPC 或 Storage Node 共识。

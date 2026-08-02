# DepotDrive V0.1

[English](./README.md) | 简体中文

## 项目简介

DepotDrive 是一个可自行部署的私人云盘 MVP，支持账户认证、无限层级文件夹、流式上传和下载、文件元数据管理，以及严格的用户数据隔离。V0.1 采用单节点架构，同时通过存储接口为后续分块上传和分布式存储演进保留清晰边界。

## 功能

- 注册、登录、退出及 Cookie 会话恢复
- 浏览根目录和无限层级文件夹，支持面包屑导航
- 创建、重命名文件夹，删除空文件夹
- 最大 500 MB 流式上传，显示上传进度并计算 SHA-256
- 流式下载、文件展示名重命名及文件删除
- 当前用户存储用量、加载/错误/空状态和响应式 Drive 界面
- 所有资源查询均按用户隔离，访问其他用户资源统一返回 404
- 全局 401 会话失效处理和跨用户前端缓存隔离

## 技术栈

- 前端：React、TypeScript、Vite、Tailwind CSS、React Router、TanStack Query、Axios
- 后端：Node.js、TypeScript、Fastify、Prisma、PostgreSQL、JWT、bcrypt、Zod、multipart
- 基础设施：npm workspaces、Docker、Docker Compose、本地文件系统
- 测试：Vitest、Fastify 集成测试

## 系统架构

```mermaid
flowchart TD
  Web[React Web] --> API[Fastify API]
  API --> DB[(PostgreSQL 元数据)]
  API --> Storage[LocalFileStorage]
  Storage --> FS[(本地文件系统)]
```

Fastify API 是模块化单体应用。HTTP 路由通过 Prisma 访问元数据，通过 `FileStorage` 接口访问二进制文件。V0.1 使用 `LocalFileStorage`；后续可替换为分布式 Storage Client，而无需在业务代码中散落文件系统操作。

## 数据库 ER 图

```mermaid
erDiagram
  User ||--o{ Folder : owns
  User ||--o{ File : owns
  Folder o|--o{ Folder : contains
  Folder o|--o{ File : contains

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
| `API_PORT` | API 端口，默认 `3000` |
| `WEB_ORIGIN` | 允许携带凭据的前端 CORS origin |
| `COOKIE_SECURE` | 生产 HTTPS 环境设为 `true` |
| `MAX_FILE_SIZE_BYTES` | 单文件上传上限，默认 500 MB |
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

上传数据首先流入 `uploads/tmp/<uuid>.part`，同时计算 SHA-256 和字节数。完成后原子移动到 `uploads/objects/ab/cd/<uuid>`，避免单目录对象过多。storage key 只接受服务端 UUID，原始文件名仅作为元数据保存，从而防止路径穿越。下载同样使用流，不会把完整文件加载进内存。

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

上传顺序为：临时流写入 → checksum → 原子移动 → 插入元数据。流写入失败时删除 `.part`；数据库插入失败时补偿删除正式对象，因此不会在文件落盘前发布元数据。

删除采用磁盘优先、数据库随后。磁盘文件已不存在时仍允许删除元数据，防止损坏记录无法清理。如果磁盘删除后数据库暂时不可用，重试会再次容忍磁盘文件缺失并删除元数据。

V0.1 不具备跨数据库/文件系统事务、垃圾回收、对象对账、复制或恢复日志。生产运维应同时备份 PostgreSQL 和 uploads volume。

## 当前限制

- 单 API 节点和本地文件系统
- 单请求单文件，不支持分块、断点续传、并行上传或 Range 下载
- 不支持分享、配额、预览、搜索和回收站
- 文件夹只允许空目录删除，文件删除为永久删除
- 生产环境需要 HTTPS 反向代理并设置 `COOKIE_SECURE=true`

## V0.2 计划

- 客户端文件分块
- 可恢复上传会话
- 并行分块上传
- 上传恢复
- 分块 checksum 校验

V0.2 将引入上传会话模型和可替换的 Storage Client。每个分块拥有独立 checksum，组装完成后通过最终清单和总校验值验证，再发布文件元数据。

# DepotDrive V1.0 — 自愈分布式存储

[English](./README.md) | 简体中文

DepotDrive 是一个基于 React、TypeScript、Fastify、PostgreSQL、Prisma 和 Docker Compose 的类 Dropbox 项目。它实际演示两个独立 Storage Node 进程/volume、字节级完整性校验、持久化副本修复，以及可跨页面/API 重启恢复的 8 MiB 分片上传。

最终 React 产品包含完整认证、响应式 Drive、真实测速的多文件上传管理器、文件详情、管理员 System Monitor，以及由 PostgreSQL 真实事件驱动的可靠性时间线。

## 产品界面

![My Drive 文件详情](./docs/portfolio/screenshots/drive-file-details.png)

![实时 System Monitor](./docs/portfolio/screenshots/system-monitor.png)

![交互式 Reliability Demo](./docs/portfolio/screenshots/reliability-demo.png)

## 已验证能力

- 文件只有在两个独立节点都保存完整、已验证副本后才进入 `AVAILABLE`。
- 下载候选先写入 Coordinator staging 并流式计算 SHA-256，校验通过后才向客户端发送。
- `MISSING`、`CORRUPT`、`UNAVAILABLE`、`HEALTHY` 均持久化到 PostgreSQL。
- Primary 损坏时从健康副本返回正确内容，并提交持久化自动修复任务。
- Scrubber 按最久未验证顺序抽查副本并触发 repair。
- `REPAIR_REPLICA` 在 API 重启后继续，重复执行安全。
- 浏览器刷新、断网和 API 重启不会丢失服务端上传进度；重新选择同一文件只发送缺失分片。
- 默认测试真实运行 PostgreSQL、两个 Storage Node、容器故障、字节损坏、修复、并发恢复和 100 MiB 重启续传。

## 架构

```text
React Web :5173
  |
Fastify API / Coordinator :3000 ─── PostgreSQL :5432
  |                                  元数据 + durable operations
  ├── HTTP ── Storage Node A :4001 ── storage_a_data
  └── HTTP ── Storage Node B :4002 ── storage_b_data

API session/verification staging ── api_uploads_data
```

API 不挂载节点 volume，只通过内部认证 HTTP 访问。这仍是 single-host、single-Coordinator 部署，不宣称多机或多地域容灾。

## 技术栈

- React 19、TypeScript、Vite、React Query
- Node.js 与 Fastify
- PostgreSQL 16 与 Prisma
- 两个 Fastify Storage Node 服务及独立 filesystem named volume
- Docker Compose、Vitest 与 Playwright

## Docker 启动

```bash
git clone <repository-url>
cd DepotDrive
cp .env.example .env
# 执行两次 `openssl rand -hex 32`，把两个独立结果分别粘贴到
# .env 的 JWT_SECRET= 和 STORAGE_INTERNAL_TOKEN= 后面。
docker compose up -d --build --wait
docker compose ps
```

前端：`http://localhost:5173`；API：`http://localhost:3000`。API 容器启动前自动执行已提交 migration。

需要本地交互演示时，显式启用 demo override；生产 Compose 不创建 demo 管理员，也不开放 demo mutation：

```bash
docker compose -f docker-compose.yml -f docker-compose.demo.yml up -d --build --wait
# 本地默认：demo@depotdrive.local / DepotDemo123!
# 可通过 DEMO_ADMIN_EMAIL / DEMO_ADMIN_PASSWORD 覆盖。
```

```bash
docker compose stop           # 保留数据
docker compose down --volumes # 删除本地数据
```

## Host 开发

```bash
cp .env.example .env
# 将 JWT_SECRET 与 STORAGE_INTERNAL_TOKEN 设置为两个独立的 32+ 位随机值。
npm install
npm run prisma:generate
docker compose up -d postgres storage-node-a storage-node-b --wait
npm run prisma:deploy -w @depot-drive/api
npm run dev
```

## 质量门禁

```bash
npm run typecheck
npm run build
npm test
```

`npm test` 会创建隔离 PostgreSQL 与两个临时 Storage Node、执行全部 migration、unit 和真实 integration/fault tests，最后清理环境。基础设施不可用时明确失败，不会静默 skip。

最后一次结果：**55 passed、0 failed、0 skipped**（API unit 15、Web 19、Storage Node 4、PostgreSQL/Storage integration/fault 15、完整 Compose Playwright 浏览器 E2E 2）。

浏览器测试真实上传 100 MiB 文件，在刷新和 API 重启后验证仅请求服务端权威 missing chunks；随后停止节点验证 fallback、双停验证 503、注入单字节损坏并观察持久化 corrupt/repair 事件。该 E2E 不 mock monitoring API。

## Phase 2 演示

完整 Compose 运行后执行：

```bash
node scripts/phase2-demo.mjs
```

脚本实际上传 100 MiB，验证两个 volume，修改 Node A 对象一个 byte，捕获 `CORRUPT`、验证从 B fallback、等待自动修复并校验两份 hash；随后把第二个 100 MiB 上传中断在 7/13 分片，重启 API，仅发送 7–12，最后校验 SHA-256。

## 设计取舍

- PostgreSQL 同时承担权威 metadata 与 durable operation queue；V1 不需要 Redis 或消息队列。
- PostgreSQL 与远程 filesystem 无法形成 ACID transaction，因此依靠幂等写入、持久化状态和 reconciliation 收敛。
- 下载在发送响应前完整 staging 并校验 hash，以首字节延迟换取“坏数据不会返回”的可证明正确性。
- 单机上的 container/process/volume 隔离支持真实独立故障测试，但不宣称物理主机隔离。

## 主要配置

| 变量 | 默认值 | 说明 |
|---|---:|---|
| `CHUNK_SIZE_BYTES` | 8388608 | 8 MiB 分片 |
| `UPLOAD_SESSION_TTL_SECONDS` | 86400 | 未完成 session TTL |
| `MAX_ACTIVE_UPLOAD_SESSIONS_PER_USER` | 20 | 每用户活跃 session 上限 |
| `HEARTBEAT_INTERVAL_MS` | 10000 | 节点探测间隔 |
| `STORAGE_FAILURE_TIMEOUT_MS` | 30000 | 心跳新鲜度 |
| `REPAIR_INTERVAL_MS` | 30000 | 修复 worker 间隔 |
| `REPAIR_UNAVAILABLE_GRACE_MS` | 300000 | 节点短暂故障宽限期 |
| `SCRUB_INTERVAL_MS` | 21600000 | 默认六小时 scrub |
| `SCRUB_BATCH_SIZE` | 10 | 每批校验副本数 |

## 限制

- 下载先完整 staging 验证，会增加首字节延迟与临时磁盘占用。
- 刷新后用户需要重新选择文件；浏览器只持久化 session metadata，不保存 `File`。
- 只有两个节点时，一个节点完全下线期间无法恢复到两个物理副本，只能等待节点恢复。
- 仅支持一个 Coordinator；数据库 claim 防止明显重复，但不是分布式共识。
- 所有服务仍位于同一物理 Docker host。不宣称 multi-region、S3、Kubernetes、Redis、Kafka、sharing、preview、search 或 trash。
- 节点启停和损坏注入仅通过本地 CLI。API/Web 不挂载 Docker socket；网页 demo mutation 仅限管理员、同源、带 CSRF 的 scrub/repair。

## 文档

- [Phase 2 实现](./docs/v1/PHASE2_IMPLEMENTATION.md)
- [自愈设计](./docs/v1/SELF_HEALING_DESIGN.md)
- [断点续传设计](./docs/v1/RESUMABLE_UPLOAD_DESIGN.md)
- [Phase 2 测试结果](./docs/v1/PHASE2_TEST_RESULTS.md)
- [Phase 2 演示](./docs/v1/PHASE2_DEMO.md)
- [更新后架构](./docs/v1/UPDATED_ARCHITECTURE.md)
- [最终前端实现](./docs/portfolio/FRONTEND_IMPLEMENTATION.md)
- [最终测试结果](./docs/portfolio/FRONTEND_TEST_RESULTS.md)
- [交互演示指南](./docs/portfolio/INTERACTIVE_DEMO.md)
- [简历声明验证](./docs/portfolio/RESUME_VERIFICATION.md)
- [75 秒视频脚本](./docs/portfolio/DEMO_VIDEO_SCRIPT.md)
- [最终 Git 审计](./docs/release/GIT_AUDIT.md)
- [安全审计](./docs/release/SECURITY_AUDIT.md)
- [人工验收清单](./docs/release/MANUAL_ACCEPTANCE.md)
- [最终发布审计](./docs/release/FINAL_RELEASE_AUDIT.md)

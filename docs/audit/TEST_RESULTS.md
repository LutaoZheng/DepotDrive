# DepotDrive 测试与命令结果

执行日期：2026-09-26  
环境：macOS，Node `v24.16.0`，npm `11.13.0`，Docker CLI `29.6.2`，Docker Compose `v5.3.1`。

> 历史记录：本文件保留 2026-09-26 初始审计时的真实结果。此处记录的 Xcode license、Docker 和跳过集成测试状态已在后续开发与最终发布审计中解决；当前发布结论见 `docs/release/FINAL_RELEASE_AUDIT.md`。

## 结果总览

| 命令 | 退出状态 | 结果 |
|---|---:|---|
| `npm test` | 0 | API 18 passed / 16 skipped；Web 18 passed。skipped 的 16 个全部是 PostgreSQL integration tests。 |
| `npm run typecheck` | 0 | API、Web、Shared 均通过。 |
| `npm run build` | 0 | API/Shared TypeScript build 通过；Web Vite production build 通过。 |
| `DATABASE_URL=... npm exec --workspace @depot-drive/api prisma validate -- --schema prisma/schema.prisma` | 0 | Prisma schema valid。 |
| `docker compose config --quiet` | 0 | Compose YAML/插值配置有效。 |
| `docker info --format '{{.ServerVersion}}'` | 1 | Docker daemon socket 不存在，无法 build/up。 |
| `nc -z 127.0.0.1 5432` | 1 | 本机 PostgreSQL 5432 不可达。 |
| `git status --short` | 非项目退出 | 系统 Git 被未接受的 Xcode license 阻塞。 |

## `npm test`

实际摘要：

```text
API:
  5 test files passed, 1 skipped
  18 tests passed, 16 skipped

Web:
  4 test files passed
  18 tests passed
```

API 已通过的测试覆盖：

- 5 GB 配置数值安全。
- upload root 路径解析。
- LocalFileStorage chunk checksum、按序组装、取消清理。
- JWT/Cookie 生命周期。
- placement、两副本写与补偿、Primary/Replica 选择、heartbeat helper/tick（mock）。

Web 已通过的测试覆盖：

- API error mapping。
- 401 cache/session policy。
- pause/resume/cancel、chunk retry、transfer metrics、5 GB preflight（API 均为 mock）。
- storage dashboard 百分比 helper。

### 不能从通过结果推出的结论

- 未真实连接 PostgreSQL、执行 migration 或 transaction。
- 未真实启动 API/Web/Postgres 三个容器。
- 未上传 100 MB 文件。
- 未停止独立 Primary（当前也没有独立 Primary service）。
- 未验证真实网络中断、两节点同时不可用、损坏检测或自动修复。
- 未验证 React 页面交互/E2E。

## 被跳过的集成测试

`apps/api/tests/integration.test.ts` 使用：

```ts
const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
```

本次 `TEST_DATABASE_URL` 未设置。Docker daemon 未运行，本机 5432 也无 PostgreSQL，因而无法安全提供测试 DB。以下 16 项全部未执行：注册/登录、未认证访问、folder CRUD、跨用户授权、上传/下载/重命名/删除、双副本、fallback、删除失败、legacy file、DB 发布补偿、dashboard、multipart limit、chunked resume/complete、upload ownership、BIGINT size。

这属于测试基础设施缺口，不是代码通过证据。未来默认 CI 应让缺少测试 DB 直接失败，或由 test script 自动启动隔离数据库。

## TypeScript 与构建

`npm run typecheck` 全部通过。`npm run build` 生成的 Web 摘要：

```text
151 modules transformed
dist/index.html                 0.35 kB (gzip 0.26 kB)
dist/assets/index-*.css       14.20 kB (gzip 3.48 kB)
dist/assets/index-*.js       364.91 kB (gzip 118.99 kB)
```

构建成功只证明编译/打包，不证明运行时 DB、Cookie/CORS、Nginx 或 storage behavior。

## Docker 验证

- Compose 静态配置通过。
- Docker daemon 错误：`failed to connect to the docker API ... docker.sock ... no such file or directory`。
- 因此未执行 `docker compose build` 或 `docker compose up`，也未创建/删除任何 Compose volume。

## Git 环境限制

`git status --short` 被系统消息阻塞：尚未接受 Xcode license。此次审计因此无法用 Git 确认工作区原始 dirty state，也未读取 Git history。审计只新增了 `docs/audit/*.md`；测试/build 可能生成项目已配置的构建产物。未执行 commit/push。

## CI 检查

仓库顶层没有 `.github` workflow；搜索到的 `.github` 目录均来自 `node_modules`，不属于本项目。因此当前没有可审计的 CI gate。

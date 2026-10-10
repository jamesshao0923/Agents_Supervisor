# P3 工作流运行时选型

决定日期：2026 年 10 月 10 日。首版延后 Temporal，P3 采用 `RuntimeAdapter` 后的本地持久运行实现。只建设一套产品引擎；本次隔离 Temporal 样板不接入产品依赖，也不作为 P3 整体通过证据。

## 决定依据

真实样板证明 Temporal 的持久等待、Worker 重试、Service 重启和历史回放可以在本机工作，安装和启动没有构成不可行因素。阻力是独立 macOS 产品的正式部署：官方明确 `start-dev` 以及 SQLite 嵌入部署仅用于开发测试；正式 Service 需要 MySQL、PostgreSQL 或 Cassandra。本产品已有领域 SQLite，直接采用 Temporal 还需交付第二种数据库及其服务生命周期、schema 升级、备份恢复和版本兼容。当前没有这套可交付实现，不能以开发服务恢复成功代替它。[开发服务说明](https://docs.temporal.io/cli/command-reference/server)、[嵌入部署限制](https://docs.temporal.io/self-hosted-guide/embedded-server)

本机 Docker CLI 可见但 daemon 不可连接，`psql` 与 Go 不在 PATH。这个环境事实不证明 Temporal 不可部署：官方 Server 1.32.0 发布包含 Darwin arm64/amd64 原生二进制，因此无需假设 Docker、付费云或本机 Go 是采用前提。延后基于尚未实现的数据库打包与维护路径；没有估算虚构开发工期。[自行托管部署](https://docs.temporal.io/self-hosted-guide/deployment)、[Server 1.32.0 发布](https://github.com/temporalio/temporal/releases/tag/v1.32.0)

## 实际样板与测量

隔离目录为 `.supervisor-dev/p3-temporal/`，由 `.gitignore` 排除。运行前冻结 `frozen-plan.json`；真实组件是 CLI 1.9.1 / Service 1.32.0、Node 24.20.0、TypeScript SDK 1.24.0、独立 Worker、持久 Service SQLite 和独立业务 SQLite。Workflow 只编排 Activity 与 Signal 等待；业务文件与 SQLite 写入放在 Activity。

| 操作 | 实际结果 |
| --- | --- |
| 下载 Darwin arm64 CLI | 43,195,714 字节压缩包，下载 20.26 秒；解压后二进制约 144 MiB |
| 安装 TypeScript SDK | 首次 npm 安装遇到 `ECONNRESET`；保留失败日志，重试成功；锁文件缓存重装 150 包耗时 2.16 秒。未完整计时冷安装，不能把缓存重装当冷安装成本 |
| 持久 Service 启动 | 1,028 ms 至 SDK 实际连接成功；关闭 Web UI，监听 `127.0.0.1:17233` |
| Worker 活跃时资源 | Service RSS 171,008 KiB（167.0 MiB）；Worker RSS 291,344 KiB（284.5 MiB）；SDK node_modules 约 254 MiB |
| Activity 已写入、尚未回报时强杀 Worker | 真实业务 SQLite 已落一条记录；新 Worker 在 Activity timeout 后重试。同一 operationId 的 2 次真实尝试仅有 1 条业务效果，幂等由业务唯一键负责 |
| Workflow 等待 Signal 时强杀 Service | 相同持久库重新启动，1,005 ms 至连接成功；原 Worker 重连，发送 Signal 后原执行完成 |
| 旧 History 回放 | 导出 15 条真实 History event，用保持相同命令序列的代码修订运行 `Worker.runReplayHistory`，成功 |
| 清理 | runner 的 finally 终止其 Service 与 Worker；未登录、未改全局配置、未启动 Docker |

以上 RSS 是 macOS `ps -o rss` 的单次实际快照，包含 SDK 和运行时开销；未测峰值、长期空闲或生产数据库资源，不能外推成长期容量保证。Compatible revision 仅证明这次保持命令序列的修订可回放，不能证明任意工作流升级兼容。SDK 的 replay 内部队列名带 `fake_replay_queue`，这是 SDK 回放 API 的实现名称；原 History 来自真实 Service、Worker 和业务写入，未使用 mock Activity。

证据索引：`evidence-index.json` 保存冻结清单、脚本、锁文件、报告和 History 的 SHA-256；`spike-report.json` 保存时间线、业务效果、尝试记录、版本及指标；`history.json` 为真实执行历史。`service-first.log`、`service-restarted.log`、`worker-first.log`、`worker-restarted.log` 与 `spike-run.log` 保留原始运行信息；`install-cli.json`、`install-sdk-ci.json`、`npm-cache/_logs/` 保存安装成功与失败；`environment.json` 保存环境限制。上述证据全部保留本地，不入库。

这只是可行性样板：未用它宣布真实 Codex 闭环、取消传递、监督服务恢复、睡眠唤醒、未知非幂等副作用或产品用例库恢复通过。这些由选定的 P3 本地运行实现按正式冻结清单验证。也未执行生产 PostgreSQL 安装、真实 Server schema 升级或备份恢复；不存在这三项的通过报告。

## 首版正式部署路线

选定本地运行实现沿用独立 Node 监督服务和领域 SQLite，持久记录稳定 operationId、outbox/inbox、检查点版本、执行资格与未知效果，恢复先核对受管进程和实际业务状态再决定派发。App 与 CLI 共用服务。P9 从真实交付包验证受管后台启动、退出重连、受限本地 Unix socket IPC、签名、公证和进程清理；安装不会通过启动 Temporal 开发服务填补缺口。

数据库升级先停派发、核对或隔离在途写者、备份领域与运行账本及证据索引，再事务迁移；恢复原冻结验证版本、预算和失败历史。SQLite 备份采用数据库一致性备份接口或停写后的完整快照，不能仅复制活跃 `.sqlite` 而忽略 WAL。恢复到隔离数据目录后核对内容摘要、版本、未决 operation 与旧写者，再重新开放派发。P9 必须实际从包验证安装、升级和备份恢复，本选型文档仅决定路线。

## 后续采用 Temporal 的条件与边界

可行的本机路线是签名的原生 `temporal-server`、受管 PostgreSQL 和 TypeScript Worker；主存储与 Visibility 可使用 PostgreSQL 的独立数据库，UI 可选，所有端口绑定 loopback。数据库初始化、私有凭证、schema 工具、进程顺序、退出与失效检测、磁盘和日志管理必须随 App 交付，禁止把用户预装 Docker 或云订阅作为隐含要求。PostgreSQL 支持 SQL Visibility，因此没有必要仅因默认 Compose 示例就额外强制 Elasticsearch。[部署方式](https://docs.temporal.io/self-hosted-guide/deployment)、[Visibility 支持矩阵](https://docs.temporal.io/self-hosted-guide/visibility)

正式采用前实测这套原生部署的安装、启动、后台资源、数据库备份和隔离恢复；领域库与 Temporal 历史分别备份，并核对 outbox/inbox 和在途副作用。Server 按官方要求逐 minor 升级，先更新必要 schema，再升级 Server；在升级副本上验证历史与数据，不能简单覆盖可执行文件后假设历史兼容。Worker 升级需历史回放或当前 Worker Deployment 版本策略，仍在使用的旧 Worker 不提前删除。[Server 升级规则](https://docs.temporal.io/self-hosted-guide/upgrade-server)、[TypeScript 工作流版本化](https://docs.temporal.io/develop/typescript/workflows/versioning)

未来默认只有新 Run 切换引擎并记录引擎与版本；在途 Run 留在本地引擎，或在核对完成的检查点创建关联的新执行。SQLite 轨迹不宣称自动转换为 Temporal History；迁移不重置预算、失败、验收版本或已发生的副作用。

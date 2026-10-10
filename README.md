# Supervisor

面向 macOS 的长程 Agent 任务监督管理器。将目标转成可验收契约，监督执行、验证、修复与交付。首接 Codex，后续保留其他执行器接口。

**当前阶段：P2 受控单次执行已完成真实运行验收与独立复核。** 已有独立 macOS 桌面薄切片、真实 Codex app-server、受管进程、SQLite 事件与用量账本。P3 持久工作流、P4 产品独立验证器及自主 Loop 尚未实现；执行结束保持“待验收”。

## 本地运行

固定工具链为 Node **24.20.0**、pnpm **11.25.0**、TypeScript **6.0.3**。选择 `.nvmrc` 指定的 Node，并准备对应版本的 pnpm 后执行：

```sh
pnpm install --frozen-lockfile
pnpm doctor
pnpm desktop
```

构建与真实测试子进程使用 Node 24.20.0；版本不符时构建失败。本机若通过 Codex 自带 pnpm 包装器启动，包装器可能使用另一 Node 版本并提示 engine warning，应区分包装器与实际构建/测试进程；报告记录实际执行路径和版本。

| 命令 | 行为 |
| --- | --- |
| `pnpm build` | 严格 TypeScript 编译并构建 Electron/React 界面 |
| `pnpm desktop [--data PATH]` | 启动或复用独立后台，再打开 macOS 桌面；默认 `.supervisor/local` |
| `pnpm typecheck` | 只检查类型 |
| `pnpm check:boundaries` | 检查领域依赖与开发验收工具的边界 |
| `pnpm doctor` | 只读检查本地工具、登录状态和环境能力，保存 JSON 报告 |
| `pnpm test:unit` | 按 P2 配置选择 unit 套件，输出独立证据 |
| `pnpm test:integration` | 运行真实文件、进程、探测与仓库检查，输出独立证据 |
| `pnpm verify:stage` | 默认执行 P2 当前必要套件及所选回归（含真实模型调用），并逐项对账 |
| `pnpm verify:p0` | 在当前候选上执行 P0 基座回归，不表示 P1 完成 |
| `pnpm verify:stage --modules domain` | 按模块影响及核心回归选择，保守扩大到完整套件；结果是局部检查 |
| `pnpm verify:stage --reason "修复原因"` | 运行新一轮，保留原因和原失败历史 |
| `pnpm verify:evidence --run /absolute/path/to/run` | 对当前候选复验已有证据，追加检查结果 |
| `pnpm test:live` | 调用真实 Codex，执行隔离工程修复、取消和截图识别；需登录及实际截图 |
| `pnpm verify:release` | 发布门禁尚未实现，明确非零退出 |
| `pnpm verify:p1` | 当前候选的 P1 回归，不表示 P2 阶段通过 |
| `pnpm supervisor serve --data .supervisor/local` | 启动本地 SQLite 与 Unix socket 服务；先执行 `pnpm build` |
| `pnpm supervisor health --data .supervisor/local` | 查询实际后台健康状态 |

`test:unit` 或 `test:integration` 通过只表示该层检查通过。阶段放行需要 `verify:stage` 全部必要检查通过以及独立审查。P1 及后续阶段不能借用 P0 的通过结果。

测试用例按全局能力持续维护，允许有依据地新增、修改、合并和退役；不能只因上层使用了底层就认定覆盖了底层异常。[全局目录](tests/catalog/current.json) 保存稳定 ID、场景和风险映射，[P0](tests/acceptance/p0.json)/[P1](tests/acceptance/p1.json)/[P2](tests/acceptance/p2.json) 配置引用同一目录。选择时校验登记与源码声明，冻结后不从运行发现重建必要清单。当前按套件保守选测，未知影响扩大集合；局部结果 `stagePassed=false`，未选项目不算通过。迁移与用例变化见 [CHANGELOG](tests/catalog/CHANGELOG.md)。

[测试与验收用例的持续迭代](docs/architecture.md#测试与验收用例的持续迭代) 同时是 Supervisor 的关键产品设计。P1 提供项目用例修订、覆盖/替代关系、变更提案、快照发布、佐证产物引用和冻结计划的存储约束；产品独立复核与影响选择在 P4 接通，自主维护在 P6 接通。研发测试库与产品项目用例库分别管理。

## P2 真实执行与桌面

桌面使用 Electron 44.7.0 与 React 19.3.0。渲染器关闭 Node 集成、启用隔离和沙箱，只通过限定 IPC 操作后台。左侧按项目目录分组并在组内列出任务，中间自适应 3:4 Agent 卡片，右侧显示真实事件、执行器输出、thread/turn、用量和停止状态。工作区与事件面板独立滚动，取消操作保持可见。窗口关闭或退出桌面不会停止独立后台；重新打开按原执行编号恢复，不重放提示词。

首次运行需本机 Codex **0.153.4** 已登录，协议版本和选定 schema 摘要必须匹配。模型及图像能力从当前账户 `model/list` 读取；本机实测可用 `gpt-5.6-sol`，不把设计中的候选模型当作已可用。版本升级需重新审查协议，不能只替换摘要绕过兼容检查。生成器见 [generate-baseline.ts](packages/executor-codex/generate-baseline.ts)。

| 能力 | 当前行为 |
| --- | --- |
| 派发 | 命令回执、预算预留、工作区占用与操作意图同事务提交；同 ID 同内容幂等，内容不同拒绝 |
| 进程控制 | 先持久化进程身份再释放目标；核对 PID、启动时间、进程组与继承 token；TERM/KILL 后复查停止 |
| 工作区 | 有路径时按规范化真实目录归入同一项目；无路径时创建 `~/.supervisor/workspace/<稳定标识>`。拒绝同目录及父子目录并发写入；候选摘要采集后才释放占用 |
| Codex | 独立 thread/turn、原始事件先落库、归一化状态；每次单轮，断连未知结果不自动重发 |
| 工具配置 | 本次执行关闭额外 apps/plugins、已配置 MCP、内置多 Agent 和网页搜索；不改全局配置 |
| 预算 | 使用供应商原始累计 tokens（包含缓存输入），保留输入/缓存/输出细分；不是金额估算 |
| 收尾 | 保存 tracked diff 与 tracked/untracked 文件摘要；只有供应商终态及已报告用量才能正常结算；未知用量不记成零 |
| 恢复 | 重启核对旧进程并停止/保留未知状态；可查看旧事件，无自动续跑；完整工作流恢复留 P3 |
| 结果 | `Execution.completed` 是执行器结束，`Run` 仍等待独立验收；不能通过底层 P1 接口伪造受管任务完成 |

停止确认覆盖继承 Supervisor ownership token 的受管进程，包含脱离原进程组的子进程；这是实际 OS 身份观察与有界静默窗口，不是针对恶意清除 token 或外部调度任务的操作系统级隔离。token 超限在供应商上报后触发取消，可能存在上报延迟与超支；默认总额 170,000、单次预留 150,000、验证预留 20,000，可在界面修改。无权把未确认的进程或用量写成成功。

CLI 与桌面使用同一后台。先执行 `pnpm build` 与 `pnpm supervisor serve --data .supervisor/local`，再调用：

```sh
pnpm supervisor capabilities --data .supervisor/local
pnpm supervisor run --data .supervisor/local --file /absolute/path/execution.json
pnpm supervisor executions --data .supervisor/local
pnpm supervisor inspect --data .supervisor/local --execution EXECUTION_ID
pnpm supervisor trajectory --data .supervisor/local --execution EXECUTION_ID --after 0
pnpm supervisor cancel --data .supervisor/local --execution EXECUTION_ID
```

`execution.json` 示例（使用实际存在的隔离项目路径和能力发现返回的模型）：

```json
{
  "commandId": "my-project-change-1",
  "workspace": "/absolute/path/to/project",
  "prompt": "修复已明确的问题，并报告真实测试结果。仅修改该项目。",
  "model": "gpt-5.6-sol",
  "effort": "medium",
  "timeoutMs": 300000,
  "tokenLimit": 170000,
  "reservation": 150000,
  "verificationReserve": 20000
}
```

`workspace` 可选：省略或留空时，后台创建持久保留的暂存目录；同一 `commandId` 重试复用同一目录，独立请求使用不同目录。侧栏没有全局“运行历史”，旧任务仍按原路径保留在项目下；任务详情继续显示完整执行轨迹。侧栏“新任务”默认创建独立暂存工作区，项目内“在此项目新建”沿用当前路径，可随时改选目录。“打开目录”在 Finder 中显示真实文件。暂存目录不会随退出应用自动删除。此项只解决任务归属和资料存放，P2 网页搜索与完整 deep research 流程仍未启用。

新桌面要求后台声明 `workspaceManagement: path-v1`；旧后台仍在运行时会明确拒绝复用，须先确认在途任务状态并正常退出旧服务再启动。

`images` 可选，接收最多 5 张本地截图的绝对路径。IPC 请求结果未知时用原 `commandId` 核对；界面确定拒绝时允许修改输入，传输结果未知时保留原 ID。`reconcile --execution ID` 会核对并停止不确定的旧执行，不是继续运行。

### 项目目录管理修订验收

2026 年 10 月 10 日，按“项目目录 → 任务”调整桌面与后台后，当前全局目录共 **184 个唯一 ID：113 单元 + 68 集成 + 3 真实模型场景**。保留原有 180 项并新增 4 项目录生命周期/兼容检查，未复制历史阶段清单。本轮完整冻结执行 **184/184 通过**，无失败、跳过、TODO 或未运行项。

- 真实桌面留空路径启动 Codex，在 `~/.supervisor/workspace/<稳定标识>/notes.md` 写入资料，并通过“打开目录”在 Finder 检查文件。
- 正常停止并重启后台后，原回执、目录和文件内容全部一致；同项目新建的第二个真实任务读取原资料、创建 `followup.txt`，仍属于同一暂存项目，原文件未变。
- 旧项目下的两项真实执行记录保留，项目切换只显示对应任务，并清除上一项目的详情；不再提供全局运行历史入口。
- 实测发现的正常收尾误报“连接中断”已修复；新执行 `error=null`，原错误回执保留，现有真实工程验收增加对应断言。

自动证据：`.supervisor-dev/verification/2026-10-10T04-37-56-299Z-ec46c2a9-8a13-4cca-bfc3-b2f76d5c94da/summary.html`。桌面与文件证据索引：`.supervisor-dev/workspace-ui/manual-review.json`；最终截图：`.supervisor-dev/workspace-ui/final-workbench.png`。独立复核已通过，记录于同目录的 `independent-review.json`；CLI 证据校验退出码 0，143 个候选文件及 10 份桌面证据摘要全部一致。

暂存目录中的实际文件持续保留；P2 对非 Git 目录的候选元数据采集仍明确报告不可用，不能当作完整交付快照。此次实际文件由独立读取与摘要核对验证。联网研究与产品独立验收仍按后续阶段实现。

### P2 验收与复现

P2 初次完成时的冻结必要清单为 **14 套件、180 个唯一 ID：113 单元 + 64 真实集成 + 3 真实模型场景**。P0/P1 用例按全局 ID 引用一次，未复制阶段历史；真实进程替换链在原场景内扩展断言。保留协议构造输入的单元测试，同时明确它们不能代替供应商 live 证据。

完整验收前，请用截图工具捕获实际 Supervisor 空工作台，设置 `SUPERVISOR_LIVE_SCREENSHOT` 指向该 PNG（本机已有 `.supervisor-dev/p2-ui/empty-workspace.png`）。截图缺失或账户不可用会失败，不跳过。图像门禁验证图中应用名、按钮和空工作台；它不是未来 P4 的完整 UI 功能验证器。

```sh
SUPERVISOR_LIVE_SCREENSHOT=/absolute/path/supervisor-empty.png pnpm verify:stage
```

运行会真实消费模型额度。隔离 TypeScript 项目的断言先实际失败，Codex 修改源码后再由独立工具编译和运行固定断言，同时校验验收文件未被修改。另执行实际 turn 取消和截图识别；原始数据、候选文件、数据库及构建输出保存在本轮 `artifacts/`。桌面手动验证另存 `.supervisor-dev/p2-ui/`，包括退出界面前后的同一任务、取消记录与截图。

2026 年 10 月 10 日本机 P2 初次完成的冻结候选（路径管理改动前）：**180/180 通过**，14 套件，无失败、跳过、TODO 或未运行项，95 秒。真实工程修复使用 `gpt-5.6-sol / medium`，供应商报告累计 85,898 tokens（其中缓存输入 55,296）；独立编译、固定功能断言及验收文件摘要全部通过。取消测试在实际 turn 创建后停止，用量缺失仍保持未知；截图识别实际回报 16,379 tokens。桌面实际操作另行验证，未计入自动用例数量。

最终证据运行：`2026-10-10T03-49-57-073Z-83de1a61-f451-4454-b170-5f6d1cd3b6f1`。候选 SHA-256：`7b7b1d9714ebe77b0d9c0e5df953db45f038282c2fc5154bc1ad07f0812ca963`。

```sh
open .supervisor-dev/verification/2026-10-10T03-49-57-073Z-83de1a61-f451-4454-b170-5f6d1cd3b6f1/summary.html
```

桌面证据索引：`.supervisor-dev/p2-ui/manual-review.json`，最终截图：`.supervisor-dev/p2-ui/final-workbench.png`。独立复核记录：`.supervisor-dev/p2-audit/independent-final-review.json`；CLI 证据校验退出码为 0，143 个候选文件摘要全部匹配，6 份桌面证据摘要核对通过，无未解决的阻塞发现。

早期预算不足导致取消的失败记录 `2026-10-10T03-35-39-016Z-88ee9063-0d4b-481c-b1ca-a7459e48e95a`、进程竞态/夹具失败 `2026-10-10T03-39-29-174Z-ceafb807-a50a-4953-bbb9-d1367f0bd8cf`、界面修复引起候选变更的旧运行 `2026-10-10T03-41-49-777Z-2d81174a-13d7-4c00-a0c9-0d358c176236` 均保留，不改写成绿灯。

供应商 `waitingOnApproval`、`waitingOnUserInput`、`willRetry` 等异常状态目前经过协议边界测试，未声称每种状态都已在真实服务稳定触发。P2 不包含自主 Loop、语义验收、Temporal、移动平台交付、安装包签名或自动升级。

## P1 本地内核与后台（历史阶段）

| 已落地部分 | 行为 |
| --- | --- |
| 领域规则 | 版本化契约、依赖节点、尝试、暂停/取消、必要证据和完成条件；旧版本及迟到结果不使取消复活 |
| 预算与资源 | 派发前预留、独立验证额度保留、一次结算、真实超支留账；全局精确资源键的逻辑租约 |
| SQLite | 磁盘数据库、WAL/FULL、版本迁移、乐观修订检查；状态、事件、预算和命令回执同事务提交 |
| 产物发布 | SHA-256 内容快照先写盘再发布索引；孤儿文件不可用，读回校验内容；失效证据不能完成任务 |
| 项目用例记录 | 修订不可覆盖，替代保留必要覆盖与缺陷引用，按项目隔离；冻结计划保留参数组合和原版本 |
| 服务与 CLI | 单后台所有者、Unix socket、真实命令/查询、事件游标；崩溃后重启可按相同 `commandId` 核对结果 |

预算单位 `work-unit` 是安全整数的本地记账单位，不代表已接入供应商 token 或金额计费；P2 受管执行另使用 `token` 单位和真实用量。逻辑租约不代表操作系统文件锁或已停止外部进程。P1 的 `recordEvidence` 与用例发布是受信本地调用者使用的低层存储接口，只检查结构、版本和引用；不宣称证据已由模型独立审核，也不把 `Run.succeeded` 当成完整监督产品已验收。

构建后在一个终端启动后台：

```sh
pnpm build
pnpm supervisor serve --data .supervisor/local
```

另一个终端创建项目并查看真实存储结果：

```sh
cat > .supervisor/create-project.json <<'JSON'
{"method":"command","command":{"commandId":"example-project-v1","type":"createProject","project":{"id":"example","name":"My first Supervisor project"}}}
JSON
pnpm supervisor send --data .supervisor/local --file .supervisor/create-project.json
pnpm supervisor projects --data .supervisor/local
pnpm supervisor events --data .supervisor/local --project example --after 0
```

命令与查询字段见 [P1 协议](packages/contracts/p1.ts)，包括创建 Run、提交动作、发布产物及冻结用例计划。`runs --project ID` 列出任务，`show --project ID --run ID` 查看任务；更新使用返回的 `revision`，重试同一操作沿用原 `commandId`，不要用新 ID 盲目重发。停止后台按 Ctrl+C；重启使用相同数据目录。产物完整性失败时查询明确报错，事件仍可用于核对历史与停止/结算记录。

2026 年 10 月 10 日本机完整验收：**103 项单元测试 + 49 项真实集成测试 = 152/152 通过**，10 个套件，无失败、跳过、TODO 或未运行项。集成测试实际写入 SQLite 和文件、并发提交、终止进程并重启、发起 Unix socket 请求。纯规则测试调用真实领域函数，不用模拟数据库或预设成功响应替代阶段验收。

独立审查重新冻结并运行领域、持久化和 IPC 的 **62/62** 项测试；对正式证据的 CLI 复验实际退出码为 **0**。另行通过 README 入口执行后台健康、创建项目、项目列表和事件查询的 4 项 CLI 检查。HTML 报告已在浏览器检查，JUnit XML 可解析。

最终证据运行：`2026-10-10T02-56-30-850Z-6ed54aee-d3b6-411e-bf7e-37f09d06a404`。

候选 SHA-256：`640b5ae807f7cbb17c6f14fba924b56cfe9582d0fff8bf60214350abce2391b6`。

本机打开完整报告：

```sh
open .supervisor-dev/verification/2026-10-10T02-56-30-850Z-6ed54aee-d3b6-411e-bf7e-37f09d06a404/summary.html
```

独立审查记录：`.supervisor-dev/audit/independent-final-1791601069304/review.json` 与 `decision.json`；手动 CLI 检查：`.supervisor-dev/p1-manual/cli-smoke.json`。首轮失败记录保存在 `.supervisor-dev/verification/2026-10-10T02-50-11-750Z-b77797aa-0d07-4433-a8c6-5322e22b4d81/`。边界命名歧义、SQLite 并发初始化锁竞争，以及独立审查发现的覆盖缩减、完成与预算判断不一致、产物损坏阻断安全操作均已修复并复验，未改写原失败证据。

## P0 历史验收与通用证据格式

P0 原始冻结清单保存在 [p0-v1.json](tests/acceptance/history/p0-v1.json)，包含 6 个套件、71 个必要测试名。当前配置已经迁移到全局目录；以下是原 P0 验收记录，不能作为更改后 P1 候选的通过证据。

| 套件 | 必需测试数 | 覆盖 |
| --- | --- | --- |
| unit-contracts | 33 | 清单解析、结果分类、漏测/重复/跳过、身份与汇总对账 |
| unit-environment | 10 | 路径、完整版本、认证标签、真实命令输出/退出/超时 |
| unit-boundaries | 4 | 领域依赖、验收工具隔离及 TypeScript 导入边界 |
| integration-runner | 18 | 真实子进程和文件写读、失败、零测试、超时与后代清理、证据篡改和 CLI 拒绝 |
| integration-environment | 2 | 真实环境探测及项目目录不被修改 |
| integration-repository | 4 | 真实源码边界、gitignore、未实现入口拒绝及工具链一致性 |

每轮产生唯一目录 `.supervisor-dev/verification/<run-id>/`，控制台输出绝对路径。用浏览器打开其中的 `summary.html` 查看逐项结果，或检查以下原始文件：

- `input.json`：执行开始前冻结的清单、候选与环境。
- `manifest.json`：实际进程、命令、时间、退出码及各证据摘要。
- `results.json`、`junit.xml`：逐项机器结果，区分通过、失败、跳过及未运行。
- `events.jsonl`、`logs/`、`artifacts/`：实际执行日志和原始 Node 测试报告。
- `gate-self-tests/`：门禁自测子运行；部分原件是故障注入前的通过状态，`rejections/` 保存注入后的实际拒绝判定。检测用例通过与坏候选被拒绝分别记录。
- `checks/`：对同一证据目录的后续复验，原运行结果不覆盖。

候选摘要包含工具源码、测试及清单、构建输出和工程配置；README、说明文档和本地输出不参与执行候选摘要。改源码、改清单、缺报告、报告摘要不符、借用其他 run 的结果均拒绝通过。相同系统权限下这些机制用于可追溯与错误检测，不声称能阻止恶意同时重写全部证据。

2026 年 10 月 10 日本机完整验收：**47 项单元测试 + 24 项真实集成测试 = 71/71 通过**，无失败、跳过、TODO 或未运行项。独立审查实际复验新候选，退出码 0；缺报告、缺冻结记录、候选摘要改写等拒绝记录已抽核，CLI 坏证据检查实际退出码为 1。HTML 报告已在浏览器打开检查，JUnit XML 可解析。

最终证据运行：`2026-10-10T02-25-02-723Z-a3f8fb0a-bd93-4493-ac17-b72ce83d67be`。

候选 SHA-256：`1ca60ca0596ac2c5b13825f72a9314206c045a065b21b98fc152c8c33b63a5bf`。

本机打开完整报告：

```sh
open .supervisor-dev/verification/2026-10-10T02-25-02-723Z-a3f8fb0a-bd93-4493-ac17-b72ce83d67be/summary.html
```

复验现有证据使用上表 `verify:evidence`；更改执行源码后应产生新的运行记录，旧结果不会自动沿用。早期检查发现的后代进程清理、冻结记录复验、导入边界与版本截断问题均已修复并纳入回归，未删除原失败用例。

## 环境能力边界

P0 的 `doctor` 不启动 Agent 任务，不登录、不安装移动工具链、不启动模拟器。安装或本地登录状态不代表真实 API 已调用成功；能力报告将它们分开。

当前本机探测到 Codex 0.153.4 且本地已登录；Android SDK、Java、adb、emulator 和 2 个 AVD 已发现，但尚未构建或启动应用。Temporal CLI 未找到；`xcodebuild` 失败且 `simctl` 尚不可用，因此 iOS 构建与模拟器路径仍未验证。这些是后续阶段的环境缺口，不是 P0 已经完成的产品能力。

P2 已接入真实模型调用；P1 已实现数据库和领域持久化，阶段验收状态见文首；Temporal 选型、移动交付与完整桌面体验按 [开发计划](docs/development-plan.md) 的依赖推进。

## 仓库维护

每个阶段完成后更新本 README，记录可运行能力、命令、实际验证结果、证据位置和未完成项。约定保存在 [AGENTS.md](AGENTS.md)。

`.gitignore` 排除 `node_modules/`、`dist/`、覆盖率、`.supervisor-dev/`、`.supervisor/`、SQLite 数据及 WAL/SHM、socket、服务锁、本地环境文件、日志与常见私钥/证书；源码、测试清单、环境示例和 `pnpm-lock.yaml` 保留。原始本地证据不上传 Git，不能从 GitHub 上的文档摘要推断任意机器已经通过测试，应按上述命令重新执行。

架构与产品范围见 [产品方案](docs/architecture.md)。

# Supervisor

面向 macOS 的长程 Agent 任务监督管理器。将目标转成可验收契约，监督执行、验证、修复与交付。首接 Codex，后续保留其他执行器接口。

**当前阶段：P0 已完成并通过独立验收。** 当前可运行的是工程、环境探测和测试证据基座；P1 及后续阶段尚未实施，桌面工作台、持久化监督服务、自主 Loop 与真实模型执行尚未实现。

## 本地运行

固定工具链为 Node **24.20.0**、pnpm **11.25.0**、TypeScript **6.0.3**。选择 `.nvmrc` 指定的 Node，并准备对应版本的 pnpm 后执行：

```sh
pnpm install --frozen-lockfile
pnpm doctor
pnpm verify:stage
```

构建与真实测试子进程使用 Node 24.20.0；版本不符时构建失败。本机若通过 Codex 自带 pnpm 包装器启动，包装器可能使用另一 Node 版本并提示 engine warning，应区分包装器与实际构建/测试进程；报告记录实际执行路径和版本。

| 命令 | 行为 |
| --- | --- |
| `pnpm build` | 清理项目 `dist/`，进行严格 TypeScript 编译 |
| `pnpm typecheck` | 只检查类型 |
| `pnpm check:boundaries` | 检查领域依赖与开发验收工具的边界 |
| `pnpm doctor` | 只读检查本地工具、登录状态和环境能力，保存 JSON 报告 |
| `pnpm test:unit` | 运行冻结清单中的 unit 套件，输出独立证据 |
| `pnpm test:integration` | 运行真实文件、进程、探测与仓库检查，输出独立证据 |
| `pnpm verify:stage` | 执行 P0 全部必要套件并逐项对账 |
| `pnpm verify:stage --reason "修复原因"` | 运行新一轮，保留原因和原失败历史 |
| `pnpm verify:evidence --run /absolute/path/to/run` | 对当前候选复验已有证据，追加检查结果 |
| `pnpm test:live` / `pnpm verify:release` | 当前明确非零退出并报告未实现，不返回空绿灯 |

`test:unit` 或 `test:integration` 通过只表示该层检查通过。阶段放行需要 `verify:stage` 全部必要检查通过以及独立审查。P1 及后续阶段不能借用 P0 的通过结果。

## P0 验收与证据

冻结清单为 [tests/acceptance/p0.json](tests/acceptance/p0.json)。它显式列出 6 个套件、71 个必要测试名，执行时不会从现有测试文件自动重建清单；删测试或只发现零个测试会导致门禁失败。

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

真实模型调用在 P2 接入；数据库及领域持久化从 P1 开始；Temporal 选型、移动交付与完整桌面体验按 [开发计划](docs/development-plan.md) 的依赖推进。

## 仓库维护

每个阶段完成后更新本 README，记录可运行能力、命令、实际验证结果、证据位置和未完成项。约定保存在 [AGENTS.md](AGENTS.md)。

`.gitignore` 排除 `node_modules/`、`dist/`、覆盖率、`.supervisor-dev/`、`.supervisor/`、本地环境文件、日志与常见私钥/证书；源码、测试清单、环境示例和 `pnpm-lock.yaml` 保留。原始本地证据不上传 Git，不能从 GitHub 上的文档摘要推断任意机器已经通过测试，应按上述命令重新执行。

架构与产品范围见 [产品方案](docs/architecture.md)。

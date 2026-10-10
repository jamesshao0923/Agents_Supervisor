# Supervisor 研发测试目录变更记录

## dev-catalog-v3 / p2-catalog-v1

- P2 执行配置继续引用同一全局目录的稳定 ID；必要用例去重后执行一次，不重放历史阶段的冻结清单。P0/P1 原配置引用及 `history/p0-v1.json` 保留；历史失败、冻结摘要和运行证据不改写。本记录只说明目录与接口变更，不宣称 P2 验收通过。
- 支持 `P2` 和 `live` 测试层，默认选取 P2 配置。live 复用原始冻结、候选摘要、报告对账和复验路径；`--layer live` 始终是局部范围，`stagePassed=false`。必要外部服务失败、缺失报告、跳过、零测试或超时仍阻断，不退回模拟执行器。
- `manifest rejects invalid schema stage and revision` 与 `profiles reject unknown stages stale references empty selection and uncovered necessary risks` 的未知阶段输入由 `P2` 移至 `P3`。原断言“未实施/不支持阶段必须拒绝”保留；合法 P2/live 元数据及局部冻结、复验、注册缺口由明确断言覆盖，不把接口扩展解释为放宽。
- 仅合并 `impact selection expands transitive modules and conservatively deduplicates full suites` 内针对 `{ modules: ['shared'] }` 的 `mode === 'partial'` 重复断言。完全相同输入与断言保留在 `layer and impact selections never claim stage completion even when all suites expand`（`dev.catalog.013`）；原 `dev.catalog.011` 保留完整套件扩展数量、传递影响、选中原因及未选范围断言。所有 19 个原目录场景及稳定 ID 保留；未合并任何底层领域/持久化检查。
- `dev.integration-repository.003` 保留稳定 ID，将原“live/release 均未实施”临时输入迁为“live 接到真实冻结执行器、release 未实施仍非零拒绝”。新名称为 `repository live gate is wired and unavailable release gate fails closed`。live 的必要失败/缺报告/未执行行为继续由执行器门禁与 P2 live 场景核对；本仓库入口断言不冒称运行了模型，也不删除 release 拒绝假成功的负向控制。
- 新增 `dev.catalog.020`：以真实 Node 子进程验证 live 层的元数据冻结与复验、完整配置含 live、局部范围不放行阶段，以及未注册/缺失 live 源码拒绝冻结。这是研发执行器检查，不是供应商 live 事件证据。
- 登记 6 项 ExecutionManager/SQLite/IPC 真实组件集成：规范化持久回执、重叠工作区排斥、预算派发前拒绝、实际 writer 停止与未知用量保留、托管 run 的控制器授权、取消与能力探测的待派发竞态。只调用真实本地失败可执行文件或真实受管 writer，不模拟供应商成功；与 3 项供应商 live 检查分别登记。P2 当前必要清单为 14 套件/180 个唯一 ID，复用本轮受影响领域、持久化及开发执行器回归，不累计重放 P0/P1 历史运行。
- P2 live 套件登记 3 项实际供应商场景：隔离 TypeScript 修复与固定独立构建断言、真实 turn 取消与新 IPC 连接复验、实际桌面截图图像输入。供应商不可用或截图缺失即失败，不替换为协议样例。live 套件外层期限为 600000ms，为 3 项各 130000ms 的操作及清理保留有界包络；原 unit/integration 最大 300000ms 不变，超 live 上限拒绝仍由原 timeout 场景检查。
- 登记 9 项真实受管进程场景和 9 项 Codex 协议边界场景。协议输入仅证明真实适配器的校验、归一化、排序、断连及错误处理；供应商状态覆盖由独立 live 套件记录，不能相互放行。进程场景保留 durable intent/identity、真实超时及取消、PID 身份不匹配、监督进程退出和 guardian 故障后的整个进程组停止检查。独立复核后追加 `p2.process-control.009`，真实核对脱离原进程组的 token-owned writer 在取消、正常结束、后台和 guardian 死亡后的停止及外部操作隔离；原 8 项未改预期或移除。


## dev-catalog-v2 / p1-catalog-v2

- 首轮 P1 正式验收包含 143 项，运行 `2026-10-10T02-50-11-750Z-b77797aa-0d07-4433-a8c6-5322e22b4d81` 的失败证据保留。领域局部断言 helper 更名，避免与模块加载 `require` 混淆；SQLite 在首次 schema 读取前配置锁等待，并在迁移事务内重读版本。原断言未放宽。
- 独立审查发现后增加 7 项领域回归：持续保留覆盖/替代链、循环与退役复活拒绝、完成与预算判定、完成所需的执行核对条件、JSON 键序无关的不可变定义比较。新增 2 项真实持久化回归：产物损坏后仍可停止/结算，以及佐证产物引用的项目隔离和完整性。原 143 项全部保留。
- 所有新增项在新一轮执行前分配稳定 ID 并登记，最终必要清单 152 项。修复代码与增加回归分别记录，不根据运行发现缩减清单；产品用例库的独立语义复核仍留 P4。

## dev-catalog-v1 / p0-catalog-v1 / p1-catalog-v1

- 将 P0 `p0-v1` 的 6 套件、71 个独立场景逐项迁入 `current.json`。保留原测试名称、实现和风险覆盖；首次登记的稳定 ID 此后不因排序或名称改变重新编号。没有合并、替换或退役原 P0 场景。
- 原完整清单逐字保存到 `tests/acceptance/history/p0-v1.json`，用于旧运行格式复验；当前 P0/P1 配置仅引用同一目录中的 ID。历史运行和失败证据不改写，旧候选发生变化时复验仍拒绝通过。
- `manifest rejects invalid schema stage and revision` 的未知阶段输入由 `P1` 调整为 `P2`。原断言“未实现/不支持的阶段拒绝”保留；P1 成为受支持阶段后不再把其当作非法输入。新增目录测试明确证明 P1 执行清单合法。这是接口扩展后的固定输入迁移，不改变非法阶段的要求。
- 增加 `unit-catalog` 场景，覆盖稳定登记、声明对账、跨阶段引用、去重、必要风险覆盖、退役/替代、影响传播、局部范围和冻结复验。登记与源码声明不一致时，冻结前拒绝；运行发现只能核对结果，不用于重建或缩减必要清单。
- 使用文件配置维护模块影响图。局部范围按传递影响与核心回归选择；未知影响扩大为完整适用 profile。初期以完整套件执行并明确记录扩大原因，保留各场景独立结果与未选范围；局部运行 `stagePassed=false`。
- 每条用例的具体输入、断言与清理以测试实现为准，`scenario` 和 `covers` 保留对应行为/故障。替代必须提供原因、旧新 ID 和针对输入/断言/故障的覆盖复核；链末活跃用例不得丢失旧用例的必要覆盖。正式移除的范围可无替代，但任何 profile 的必要风险未覆盖时仍拒绝。
- 研发目录只依赖 `tools/p0`，与 `packages/domain` 的受监督项目验证定义分开保存，不能互相放行。

P1 新业务场景由对应工作包的稳定测试登记追加到同一目录，并纳入 P1 profile；P0 profile 不复制这些业务测试。新增/修订目录、修复实现与真实验收分别留痕。测试耗时取自真实 `results.json`，本迁移不虚构成本收益，也不以测试总数减少表示质量提升。

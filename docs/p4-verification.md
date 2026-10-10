# P4：项目独立验收与当前交付

本文说明 P4 已实现的产品入口和约束。最终冻结候选已通过 231 项真实自动检查、桌面操作与独立门禁审查，正式结果见 [README](../README.md#p4-验收与复现)。下文示例用于运行用户项目验收，不代替 Supervisor 自身的阶段通过证据。

工作流步骤结束后，任务进入 `awaiting-verification`，并不自动交付。产品验收依次执行：提出定义、独立复核、发布、冻结、实际验收、确认交付。Supervisor 的研发测试清单与这里的用户项目用例库分别管理，不能互相放行。

## 准备一个真实工程

在 Supervisor 仓库根目录操作。需要已有的 Node `24.20.0`、已安装的仓库锁定依赖、可用的本地 Codex 安装和账户。本文不执行登录、安装工具链或修改全局配置。先按仓库正常流程构建 Supervisor；不要在正在验收的冻结环境中重新构建。

下面的准备命令创建独立的正确工程、已知错误控制工程和当前候选，并实际编译三个工程。它只准备数据，没有给任务写入通过状态。命令会打印新建示例目录的绝对路径。

```bash
node --input-type=module <<'JS'
import { mkdir, mkdtemp, writeFile, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

const repository = await realpath(process.cwd());
await mkdir(join(repository, '.supervisor-dev'), { recursive: true });
const directory = await mkdtemp(join(repository, '.supervisor-dev/p4-example-'));
const good = join(directory, 'good'), bad = join(directory, 'bad');
const project = join(directory, 'project'), definition = join(directory, 'definition');
const correct = `export function discountedPrice(amount:number,percent:number):number {
  if (!Number.isFinite(amount) || !Number.isFinite(percent) || amount < 0 || percent < 0 || percent > 100)
    throw new RangeError('Invalid discount input');
  return amount*(1-percent/100);
}\n`;
const broken = `export function discountedPrice(amount:number,percent:number):number { return amount*percent; }\n`;
for (const [workspace, source] of [[good, correct], [bad, broken], [project, correct]]) {
  await mkdir(join(workspace, 'src'), { recursive: true });
  await writeFile(join(workspace, 'package.json'), '{"type":"module"}\n');
  await writeFile(join(workspace, 'src/price.ts'), source);
  await promisify(execFile)(process.execPath, [
    join(repository, 'node_modules/typescript/bin/tsc'), '--ignoreConfig',
    'src/price.ts', '--target', 'es2022', '--module', 'nodenext', '--strict',
    '--types', 'node', '--typeRoots', join(repository, 'node_modules/@types'),
    '--rootDir', 'src', '--outDir', 'build'
  ], { cwd: workspace });
}
await mkdir(definition);
const spec = {
  schemaVersion: 1, contractVersion: 1, standardsVersion: 'discount-v1',
  obligations: [
    { id: 'normal', criterionId: 'independent-acceptance', expectation: 'Return amount*(1-percent/100), including zero and full discount.', required: true, applicable: true },
    { id: 'invalid', criterionId: 'independent-acceptance', expectation: 'Negative amount, percent outside [0,100], Infinity and NaN in either argument raise RangeError.', required: true, applicable: true }
  ],
  cases: [{
    id: 'price', revision: 1, status: 'active', obligationIds: ['normal', 'invalid'],
    parameters: [
      { amount: '200', percent: '25', expected: '150' },
      { amount: '80', percent: '0', expected: '80' },
      { amount: '30', percent: '100', expected: '0' }
    ],
    modules: ['price'], replaces: [], defectRefs: ['WRONG-FORMULA', 'ILLEGAL-INPUT'],
    verifier: {
      kind: 'command', version: 'price-check-v1', entry: 'price.mjs', files: ['price.mjs'], timeoutMs: 5000,
      build: { kind: 'typescript', sources: ['src/price.ts'], rootDir: 'src', outputDir: 'build', timeoutMs: 15000 }
    }
  }],
  controls: [
    { id: 'known-good', workspace: good, expect: 'passed', mustFail: [] },
    { id: 'known-bad', workspace: bad, expect: 'failed', mustFail: ['normal', 'invalid'] }
  ],
  moduleDependencies: {}
};
await writeFile(join(definition, 'spec.json'), JSON.stringify(spec, null, 2));
await writeFile(join(directory, 'workflow.json'), JSON.stringify({
  commandId: randomUUID(), workspace: project,
  goal: 'discountedPrice returns amount*(1-percent/100). Finite nonnegative amount and finite percent in [0,100] are required; invalid inputs throw RangeError. Verify the actual source and built deliverable independently.',
  tokenLimit: 500000, verificationReserve: 300000,
  steps: [{ id: 'ready', kind: 'input', prompt: 'Confirm the prepared files are ready for independent verification.' }]
}, null, 2));
console.log(directory);
JS
```

将下面的 `P4_EXAMPLE` 设为刚打印的路径。把校验器保存到 `$P4_EXAMPLE/definition/price.mjs`；它位于候选工程之外，避免执行器修改验收标准。示例定义已经使用真实绝对控制目录，`entry` 和 `files` 则相对于 `spec.json` 所在目录。

```javascript
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const candidate = process.argv[2];
const parameters = JSON.parse(process.argv[3]);
const { discountedPrice } = await import(pathToFileURL(join(candidate, 'build/price.js')).href);
const checks = [];
for (const [obligationId, check] of [
  ['normal', () => assert.equal(discountedPrice(Number(parameters.amount), Number(parameters.percent)), Number(parameters.expected))],
  ['invalid', () => {
    for (const [amount, percent] of [[-1, 5], [1, -1], [1, 101], [NaN, 5], [Infinity, 5], [-Infinity, 5], [1, NaN], [1, Infinity], [1, -Infinity]])
      assert.throws(() => discountedPrice(amount, percent), RangeError);
  }]
]) {
  try { check(); checks.push({ obligationId, verdict: 'passed', reason: 'Actual assertion passed for ' + JSON.stringify(parameters) }); }
  catch (error) { checks.push({ obligationId, verdict: 'failed', reason: String(error) }); }
}
await writeFile(process.env.SUPERVISOR_VERIFY_REPORT, JSON.stringify({ schemaVersion: 1, checks }));
process.exitCode = checks.some(check => check.verdict === 'failed' || check.verdict === 'unknown') ? 1 : 0;
```

命令校验器收到两个参数：候选副本目录、参数 JSON。必须向 `SUPERVISOR_VERIFY_REPORT` 写报告；每个声明义务恰好一个 check，包含 `obligationId`、`verdict` 和非空 `reason`。允许的 verdict 为 `passed`、`failed`、`unknown`、`not-applicable`。全部 passed/not-applicable 时退出码为 `0`；存在 failed/unknown 时为 `1`。崩溃、超时、缺失或错误报告、退出码与报告冲突都是验收器错误，不能作为产品通过或有效负控制。

`build` 是可选字段。本例保留它：Supervisor 用锁定的 TypeScript 实际重编译冻结源码，在证据目录输出，再按全部输出文件、字节与执行权限比对 `build/`。源码错误或源码与旧二进制不一致会失败。省略 `build` 只运行声明的 Node 校验器，不应据此声称已验证编译一致性。当前构建器支持指定源码的 TypeScript 构建；它不自动安装项目依赖，不继承项目配置或任意构建插件。

## 连接工作流

先启动后台，在另一个终端继续操作。数据目录使用短路径，以满足本地 Unix socket 的长度限制。

```bash
node dist/apps/cli/main.js serve --data .supervisor/p4-guide
```

```bash
P4_EXAMPLE='/刚打印的绝对示例路径'
P4_DATA='.supervisor/p4-guide'
node dist/apps/cli/main.js capabilities --data "$P4_DATA"
node dist/apps/cli/main.js workflow --data "$P4_DATA" --file "$P4_EXAMPLE/workflow.json"
```

记录 workflow 响应的 `value.id`，并按实际账户返回的 capability 选择评审模型和深度。下文采用 `gpt-5.6-sol` / `low`，只有账户实际提供该组合时才使用。

```bash
P4_RUNTIME='上一步的 runtime ID'
node dist/apps/cli/main.js input --data "$P4_DATA" --runtime "$P4_RUNTIME" --step ready --text 'Files are ready for independent verification.'
node dist/apps/cli/main.js runtime --data "$P4_DATA" --runtime "$P4_RUNTIME"
```

等待真实 Worker 将 input 步骤执行为 confirmed，且 runtime phase 为 `awaiting-verification`。它证明声明步骤结束，不证明价格工程正确。实际模型开发任务也通过工作流推进至该状态。

## 六个 CLI 动作

每个动作保存在独立 JSON 文件中，然后调用同一个入口：

```bash
node dist/apps/cli/main.js verify --data "$P4_DATA" --file /绝对路径/action.json
node dist/apps/cli/main.js verification-status --data "$P4_DATA" --runtime "$P4_RUNTIME"
```

用实际响应的 ID 和绝对路径替换下面字段；`commandId` 为每次新动作唯一的 ID。重试不确定请求时复用完全相同的文件和 commandId，不要创建第二次 review/run。review/run 返回作业后仍须查询其完成结果，CLI 请求成功不等于作业通过。

| 顺序 | 动作 JSON | 可进入下一步的条件 |
| --- | --- | --- |
| 1 | `{"type":"propose","commandId":"example-propose-1","runtimeId":"RUNTIME_ID","specPath":"ABSOLUTE_EXAMPLE/definition/spec.json"}` | 提案已保存；记录 proposal ID |
| 2 | `{"type":"review","commandId":"example-review-1","proposalId":"PROPOSAL_ID","model":"gpt-5.6-sol","effort":"low","reservation":180000,"timeoutMs":120000}` | 作业 finished、approved、无 error、进程停止且用量已结算 |
| 3 | `{"type":"publish","commandId":"example-publish-1","proposalId":"PROPOSAL_ID","reviewId":"REVIEW_JOB_ID"}` | 真实复核通过，正反控制正确分类；发布版本递增 |
| 4 | `{"type":"freeze","commandId":"example-freeze-1","runtimeId":"RUNTIME_ID","mode":"final"}` | 冻结定义、契约、候选与环境，记录 plan ID |
| 5 | `{"type":"run","commandId":"example-run-1","planId":"PLAN_ID","model":"gpt-5.6-sol","effort":"low","reservation":180000,"timeoutMs":120000}` | 作业 finished、approved、evaluation.complete 为 true，无环境/验收器错误 |
| 6 | `{"type":"deliver","commandId":"example-deliver-1","jobId":"VERIFICATION_JOB_ID"}` | 再次核对当前文件、定义、证据、环境和 source；生成交付记录 |

定义复核会真实运行正反控制，再启动新建、只读的 Codex 评审上下文，核对要求、完整校验器实现与控制结果。候选的纯命令断言无需模型给每一条数值检查打分；UI 和资料验证还包含独立模型评审。

取消作业使用 `{"type":"cancel","jobId":"JOB_ID"}`，单独查询使用 `{"type":"job","jobId":"JOB_ID"}`。取消请求之后仍须核对实际进程停止与账本结算。服务中断不会把原作业变成通过，也不会自动重跑未知用量的模型尝试。

## 实际桌面入口

使用 `node tools/desktop.mjs --data .supervisor/p4-guide` 打开同一后台的实际桌面；此命令使用已构建产物。选择持久任务，右侧进入“独立验收与交付”。按界面依次操作“选择 JSON”“提交验收提案”“2 · 独立复核定义”“3 · 发布已复核定义”“4 · 冻结完整必要清单”“5 · 执行独立验收”“6 · 确认当前交付”。模型、深度、本次 token 预留和超时在“独立模型与验收预算”中设置；桌面显示秒，API 使用毫秒。

界面显示执行状态、义务 verdict、控制样本、预算和当前交付有效性。连接失败时显示上次已知状态，不能当作实时有效交付。“核对”重新读后台证据，“取消正在执行的验收”请求停止作业，“清除待核对记录”只清除界面记录。当前桌面冻结入口使用 final；impact 范围通过 CLI/API 指定。

## 本地页面与资料验证

UI 验证范围是候选目录内的本地 HTML 页面。实际 Electron 驱动执行 `fill`、`click`、`assertText`、`assertVisible`，记录步骤和真实 PNG；随后独立模型对截图、步骤与声明期望评审。没有 DOM 值直接赋值来替代输入，也不调用页面业务函数代替点击。可见、可交互和功能满足要求才有依据，不要求像素完全一致。外部页面请求、下载、新窗口和越界导航被拒绝。

下面是可加入新定义的完整 UI case。候选和控制工程都须真实提供 `index.html`：`#amount`、`#percent` 是输入框，`#calculate` 是按钮，`#result` 显示计算反馈。给该 case 对应的 `ui-price` 添加必要义务，并将交互要求写进任务契约目标；好控制须真正交互通过，坏控制须实际失败。

```json
{
  "id": "ui", "revision": 1, "status": "active",
  "obligationIds": ["ui-price"], "parameters": [{}], "modules": ["ui"],
  "replaces": [], "defectRefs": ["WRONG-INTERACTIVE-RESULT"],
  "verifier": {
    "kind": "ui", "version": "ui-v1", "entry": "index.html", "timeoutMs": 25000,
    "expectations": ["Clear visible input labels and enabled Calculate button; readable actual result feedback."],
    "steps": [
      {"kind":"fill","selector":"#amount","value":"200"},
      {"kind":"fill","selector":"#percent","value":"25"},
      {"kind":"click","selector":"#calculate"},
      {"kind":"assertText","selector":"#result","text":"150.00"},
      {"kind":"assertVisible","selector":"#result"}
    ]
  }
}
```

source 验证读取候选的 claim 文件，真实通过 HTTPS 获取指定一手资料，保留 URL、原始字节摘要、获取时间、原始文件和摘录附近文本，再由独立模型核对声明。单有 URL 不构成支持证据。摘录必须确实存在于下载文本；过期、来源不可用、错误摘录或不受资料支持的 claim 都不能通过。单份来源有 2 MiB 限制，claim 有 100,000 字符限制；当前实现不是任意网页/PDF的全文解析器。

例如 [RFC 9110 的官方文本](https://www.rfc-editor.org/rfc/rfc9110.txt) 可核对安全 HTTP 方法。对应完整 source case 如下；还需添加 `source-safe` 义务、把资料要求纳入任务目标、提供正确/错误 claim 控制。

```json
{
  "id": "source", "revision": 1, "status": "active",
  "obligationIds": ["source-safe"], "parameters": [{}], "modules": ["source-note"],
  "replaces": [], "defectRefs": ["UNSUPPORTED-SAFE-METHOD-CLAIM"],
  "verifier": {
    "kind": "source", "version": "rfc-v1", "claimFile": "claim.txt", "timeoutMs": 20000,
    "sources": [{
      "id": "rfc9110", "url": "https://www.rfc-editor.org/rfc/rfc9110.txt",
      "excerpt": "OPTIONS, and TRACE methods are defined to be safe.", "maxAgeMs": 86400000
    }]
  }
}
```

加入 UI/source 后，更新标准版本并重新提案、复核、发布、冻结，不在已发布定义上原地增删。现有必要义务仍须保留。该能力不代表完整 DeepResearch、远程网站、Android/iOS 原生应用验收或自主 Loop 已实现。

## 冻结、迭代与失效规则

- `contractVersion` 对应业务契约；`standardsVersion` 标识义务语义。同一契约不能通过维护用例删除、放宽或改变必要义务的适用性。`not-applicable` 必须有冻结理由，不能自动豁免仍适用的检查。
- 同一个 case revision 内容不可复用；修实现使用新 revision 和 verifier version，并保留旧实现文件。替代/退役须保留历史定义、缺陷引用，以及具体义务与参数覆盖；同一个 criterion 名称不足以证明替代等价。
- 首次必须同时有真实正控制和负控制。`mustFail` 是义务 ID；负控制须真实执行且这些义务确实 failed，环境阻塞或验收器崩溃不能冒充负控制成功。已发布控制的身份、内容和约束不能原地换掉或放宽。
- 一个 case 的不同参数分别成为实例；仅完全相同的参数去重。impact 根据 `moduleDependencies` 扩展依赖消费者，未知或空影响保守全选。impact 即使所有已选项通过也始终不是完整交付，最终须 final。
- 每个必要实例、每个适用必要义务都须 `executionStatus: executed` 且 verdict passed。`environment-blocked`、`verifier-error`、`not-run`、unknown、遗漏或冲突报告均不能完成交付；后来的 passed 不覆盖历史失败。
- 候选包含源码、锁文件、构建输出和二进制，摘要包含文件执行权限。明确排除 `.git`、`.supervisor`、`.supervisor-dev`、`node_modules`；遇到 symlink、特殊文件、容量超限直接拒绝，不静默漏掉。当前快照上限为 10,000 个文件及 256 MiB。
- 当前有效性绑定契约、已发布定义、候选、证据、来源时效与环境指纹。源码/二进制、校验器/控制、原始证据、已发布库、Node/Electron/Codex/编译器、相关配置或进程环境变化，可能使旧交付失效。deliver 对 source 还会重新获取比对；普通 status 读本地摘要与时效，不表示已在该时刻重新联网。
- review/run 沿用同一任务累计 token 账本。reservation 是本作业总预留，UI/source 与定义评审可能启动多个模型上下文；timeoutMs 限制每次模型评审，不是整个多实例作业的总时长。原始 reported token 用量结算，未知用量不记为零，也不能靠重连恢复预算。

冻结计划和历史作业不可原地改写。修产品实现后可以为新候选重新 freeze/run；改校验器须先新提案复核发布。运行中的计划保持原始定义；更换已发布库会令旧交付的 current 检查失效。历史交付记录仍保留，可通过 `verification-status` 查看 `currentDelivery.current` 与具体原因。

## 边界与证据

公开 CLI、桌面和 IPC 通过 VerificationController 推进六个动作，不接受客户端提交 passed 报告或直接完成托管 Run。托管项目的普通 `command` 不能绕过独立复核发布产品用例，托管 Run 也不能用低层 act 伪造证据、预算或完成状态。内部 `SupervisorStore`/repository 是受信低层接口，供服务和真实测试组织账本；直接操作源码或本地数据库不是公开验收入口，也不是防止本机所有者篡改的安全边界。

命令校验器读取冻结候选与声明实现，候选只读，仅证据输出目录可写；禁止借该入口启动子进程、使用网络或读取未授权依赖。独立模型使用只读新上下文，不允许修改实现、标准或报告。运行前后还核对实例副本完整性，防止验收器修好副本后把原坏候选放行。

数据目录的 `verification/` 下保存提案候选、正反控制快照、定义文件、冻结计划，以及每个作业的报告、intent/identity/进程停止证据、构建清单、UI trace/PNG、source 原始资料和模型轨迹。作业记录保留证据文件摘要，交付保存 delivery 记录；缺失或改写证据会被拒绝。本地运行数据和测试证据不得提交入仓库。

当前使用范围是主机持续运行，可以息屏但不能让主机睡眠来假定验证继续执行。服务中断后的恢复仍须核对旧进程和用量，不自动当作继续通过；实际主机睡眠/唤醒未验证，不在本文宣称通过。

验收预留 `verificationReserve` 属于同一 Run 的累计预算，并非每轮重置的独立额度。实际 token 按供应商上报累计，取消和上报可能存在延迟，不能视为供应商强制金额上限。环境绑定包含完整 Codex 配置摘要及进程环境，暂未细分哪些变更与本任务有关；配置发生变化后，需要在新环境中重新复核、发布并验收。已交付 Run 的历史不重写，也不能自动复活为在途任务；这种情况应创建新 Run 重新验证。

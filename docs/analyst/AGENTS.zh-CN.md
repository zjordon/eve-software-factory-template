# AGENTS.md(简体中文译本)

> 译自仓库根目录的 `AGENTS.md`(2026-10-17,基线:feat/self-hosting 分支)。英文原文是权威版本,日后仓库演进以原文为准;本译本供中文阅读,不作为 agent 的生效指令。

面向在本仓库工作的 AI 编码代理的指引。

## 项目概览

eve Software Factory 模板:Foreman,一个基于 [eve](https://eve.dev) 框架构建的编排器代理,把工作项变成目标仓库(`FACTORY_REPO`)上经过评审的草稿 pull request。工作来源于 GitHub:打了 `factory` 标签的 issue 以无人值守方式运行,来自 OWNER/MEMBER/COLLABORATOR 的 @Foreman 提及以有人值守方式运行。编排器把每个工作项按顺序流转过四个声明的子代理站点:**classifier**(分诊,快速模型)→ **analyst**(计划 + 验收标准,自带仓库检出)→ **implementer**(编码、验证、从自己的检出推送特性分支)→ **reviewer**(对已推送分支的独立裁决,不同模型厂商,最多 2 轮返工)。随后编排器开启草稿 PR;标记 ready 会停在人工审批,关闭/重开 issue 属可逆分诊,合并不在工具面内。按用户存储的偏好放在 **Blob 存储**里(云端形态为 Vercel Blob,自托管形态为本地 `FACTORY_DATA_DIR` 后端),旁边还有共享的、按仓库隔离的**工厂大脑**(关于目标仓库的持久笔记)存放在保留的 Blob 前缀下——每次运行都可读,但只有受信调用方可写;以及**交接工件**:长篇 Markdown 文档(研究备忘、分析细节),各站点之间以 id 引用、经保留的 `artifacts/` 前缀传递,而不是经编排器内联转发。流水线定义在 `agent/instructions.ts`。

整个 agent 定义在 `agent/` 目录之下。eve 从文件系统发现能力。组件图、数据流、信任模型与边界见 [`ARCHITECTURE.md`](../../.github/ARCHITECTURE.md)。

## 安装与命令

```bash
pnpm install        # 安装依赖(Node 24.x)
pnpm dev            # eve dev — 本地 TUI;首次运行 /model 关联一个模型供应商
pnpm typecheck      # tsc(TypeScript,不产出)
pnpm check          # ultracite(Biome)lint + 格式检查
pnpm fix            # ultracite(Biome)自动修复
pnpm build          # eve build
pnpm eval           # eve eval — 跑评测套件(见下方标签;消耗真实 token)
eve deploy          # 部署到 Vercel 生产(用这个,不要裸跑 `vercel deploy`)
npx eve info        # 打印发现的能力面 + 发现期诊断
pnpm validate       # check + typecheck + eve info 三合一
```

**用 `pnpm validate` 验证改动**(lint、typecheck、发现期诊断必须全部 0 错误 / 0 警告),然后在 `pnpm dev` TUI 里实际操作 agent。评测套件(`pnpm eval --tag fast`)守护路由与安全行为;`pnpm eval pipeline/full-pipeline` 跑完整条流水线并推送真实分支,请审慎运行且只对着演练仓库跑。

## eve 约定

- **写代码前先读 `node_modules/eve/docs/` 里的相关指南。** 不要发明框架 API;对照文档确认。
- **身份来自文件系统,从不来自 `name` 字段。** `agent/tools/agent.ts` 处的工具就是工具 `agent`;`agent/connections/linear.ts` 处的连接注册为 `linear`;子代理目录 `agent/subagents/classifier/` 落为工具 `classifier`。
- 可编写的槽位:`agent/agent.ts`(模型 + 会话预算)、`agent/instructions.ts`(`defineInstructions`,编排器提示词;构建期解析,注入 `FACTORY_REPO`)、`agent/tools/*.ts`(`defineTool`)、`agent/connections/*.ts`、`agent/extensions/*.ts`、`agent/channels/*.ts`、`agent/skills/<name>/SKILL.md`、`agent/subagents/<id>/agent.ts`(`defineAgent`)、各 agent 的 `sandbox.ts`。
- **模型分配集中**在 `agent/lib/models.ts`(`MODELS` 映射)。每个 `agent.ts` 从中读取自己的条目(`model: MODELS.<agent>`)而不是硬编码网关 id,换模型就是改那一行。有一处拆分是刻意的:`implementer` 跑与 `reviewer` 不同厂商的最强编码模型,以保持评审独立;不要把这两者放到同一厂商。
- **扩展:** `agent/extensions/<ns>.ts` 挂载一个预构建的 eve 扩展;文件名即命名空间,其工具以 `<ns>__<tool>` 呈现给模型(这里是 `@github-tools/eve-extension` 带来的 `github__*`)。配置键(`include`、`requireApproval`)使用裸工具名。
- **通道:** `github`(eve GitHub 通道,走自持 GitHub App,botName 从 `GITHUB_APP_SLUG` 解析;`onComment` 保留内建的提及/忽略规则,只对 OWNER/MEMBER/COLLABORATOR 评论者派发,并盖 `attributes.trusted`;`onIssue` 只在 `factory` 标签的 `labeled` 动作上派发,校验打标者至少持有 triage 权限(建 issue 时附带的标签同样触发 `labeled`),并把 principal 改写为自主 principal,因此该运行在构造上就是无人值守的;`onCheckSuite` 只对 `factory/*` pull request 上失败的 suite 派发,无人值守,修复环以数 PR 线程上的尝试评论为上限;`onPullRequest` 在新开的 PR 上发一条摘要评论,bot 发送者跳过),外加 `eve` 路由鉴权通道。
- **子代理就是站点。** 声明在 `agent/subagents/<id>/` 下;`description` 必填(路由提示),每个站点设 `tool: false`,因为 `defineAgent` 已不带 `outputSchema`。编排器真正调用的是 `agent/tools/run_<id>.ts` 处的 `defineWorkflowTool`:它阻塞在 `ctx.agent(id, { message, outputSchema })` 上,按调用挂接 `agent/lib/stations/schemas.ts` 里对应的 schema。包装器不能与站点同名(`run_classifier` 而非 `classifier`):eve 的编译器拒绝一个工具和一个同名本地子代理,即使 `tool: false`。声明的子代理运行在全新的子会话里,且**不从根继承任何东西**(没有提示词、技能、连接、工具或沙箱),所以编排器把一切装进 `message`,站点需要的任何能力都住在站点自己的目录里(它的 `sandbox.ts`、它的 `tools/`)。长文档以**交接工件**在站点间流转:researcher 和 analyst 用 `save_artifact` 保存,下游站点用 `read_artifact` 打开,编排器只转交 id(工厂函数在 `agent/lib/artifacts/`)。
- **需要审批的工具绝不能放进站点。** 声明的子代理可以请求输入,但没人盯着站点自己的卡片,站点工具返回 `user-approval` 会把运行挂死。任何需要审批的东西都归根会话(这里的 `github` 扩展);站点的副作用必须在构造上无害,比如 `push_branch`(仅特性分支、校验过的名字、代理式凭据)。
- **`agent/lib/trust.ts` 是唯一的信任权威。** 通道在派发时盖章;`agent/lib/github/approval.ts` 里的审批策略读取盖章,返回 `not-applicable` / `user-approval` / `denied`。新能力永远不要自造调用方检查;在既有判定函数上设门。
- **站点沙箱**通过 `agent/lib/github/repo-sandbox.ts`(`createFactoryEnvironment`、`factoryInit`)共享环境与初始化逻辑:每个站点的 `defineSandbox(...)` 打开该环境,然后 `factoryInit` 克隆工厂仓库并执行 `FACTORY_SETUP_COMMAND`,每会话一次。eve 构建期快照 `prepare()` 沙箱没有 `setNetworkPolicy`(只有 `environment.open()` 开出的会话级沙箱才有),所以带凭据的克隆没法再按模板跑一次。每个环境(含根)都传该模块共享的 `FACTORY_SANDBOX_CREATE_OPTIONS`:保留一份快照、14 天过期,让模板快照在闲置期存活又不至于堆积。git 操作永远瞄准字面量远端 URL(绝不用 `origin`),令牌注入在沙箱防火墙。
- **工具**运行在应用运行时(完整 `process.env`),每个文件一个默认导出;站点 git 工具经 `ctx.getSandbox(environment)` 在站点的沙箱里执行命令,并从其 `sandbox.ts` 导入该站点自己的 `environment`(裸 `ctx.getSandbox()` 句柄没有 `setNetworkPolicy`)。破坏性根工具用 `eve/tools/approval` 的 `approval` 设门(这里是 `clear_user_preferences`);当门取决于调用方时,用 `agent/lib/github/approval.ts` 的信任策略(这里是 `update_factory_brain`,由 `factoryBrainPolicy` 设门,使无人值守运行无法写共享上下文)。
- **技能**按需加载。打包技能(`<name>/SKILL.md`)要求 `description` frontmatter;该描述即路由提示。这里的技能是 `writing-quality` 和 `triaging-issues`。技能按 agent 隔离:站点看不到根的技能。
- **评测**放在 `evals/`(`defineEval`,一文件一用例;`evals.config.ts` 持有全局配置;`t.judge` 使用 eve 的默认评测模型 `typesafe-ai/jev`)。分类目录即失败分类学(`routing/`、`safety/`、`pipeline/`);`helpers.ts` 携带共享的写工具清单,让只读评测对整个清单断言默认拒绝(`notCalledTool`)。标签:`fast`(廉价回路)、`slow`、`needs-connect`(断言必须对真实 Connect 认证成功的调用)、`pipeline`(推送真实分支;主动选择)。
- 改完后,**检查 LSP 诊断 / `pnpm typecheck`**,先修类型错误再继续。

## 代码风格

- lint 与格式化由 **Ultracite**(Biome 预设)负责。收尾前跑 `pnpm check`,自动修复用 `pnpm fix`。配置在 `biome.jsonc`;kebab-case 文件名规则在那里被关闭,因为 eve 工具用 snake_case 名字。
- TypeScript strict;ESM 加 `NodeNext` 解析(相对导入需要 `.js` 扩展名)。优先 `const`、箭头函数、可选链 / 空值合并。
- 用 `zod` schema 校验工具的输入/输出。
- markdown 文件里的正文不硬换行:每个段落或条目写成一整行。
- 面向 agent 的文本(提示词、技能正文、工具与子代理的 description)遵循 `agent/instructions.ts` 里 "How you write" 的规则:不用破折号、不用机器腔的词、不用加粗强调。只承载行为,绝不承载框架管线(审批如何渲染、登录流程长什么样),也不引用读它的 agent 摸不到的工具与技能——站点提示词尤其如此,因为站点看不到根的任何表面。

## 安全

- **绝不向用户索要 API key、client secret 或任何凭据。**
- **绝不提交秘密。** `.env*` 已 gitignore。GitHub 认证用自持 GitHub App(`GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_INSTALLATION_ID`):App JWT 在 `agent/lib/github/credentials.ts` 里签名、安装令牌按调用铸造,绝不暴露给模型。Blob 认证随后端:云端形态 Vercel OIDC,自托管形态本地 `FACTORY_DATA_DIR`。`FACTORY_REPO` 在模块加载期必需(`requireEnv`),缺值则发现期失败;`FACTORY_SETUP_COMMAND` 可选。
- **git 安全是结构性的;保持它。** 沙箱内 git 永远瞄准字面量 `https://github.com/<FACTORY_REPO>.git` URL,绝不用 `origin`(沙箱里的远端配置是模型可写的),安装令牌注入在沙箱防火墙(`brokerPolicy`),绝不进入沙箱。插值进 git 命令的一切都过 `validateBranch`,它同时拒绝 `main`/`master`。新增 git 能力时不要弱化这些。
- **尊重信任模型。** 信任由通道在派发时盖章;无人值守运行对写操作是拒绝(而非挂起),例外仅限:标签、限定在其盖章 intake issue 内的评论、关闭/重开 issue、草稿 PR。新增工具或连接时,从 `agent/lib/github/approval.ts`(或信任判定函数)里选策略,而不是硬编码 `"never"`。
- 如果你要用数据构造 `RegExp`,转义它(字面匹配)并限制输入长度。
- 不可逆或高影响的动作用 `approval` 设门(这里是 `clear_user_preferences`,外加 GitHub 扩展上的船闸策略)。
- 每个保留的 Blob 前缀都声明在 `agent/lib/blob.ts` 的命名空间注册表里,旁边是所有 Blob 工具必经的共享读/写/删文档助手。日后新增的任何通用 Blob 工具都必须先过注册表的守卫才能行动,让受管文档无法被通用文件操作触达;要在那里加命名空间,绝不在某个功能模块里留散落常量。
- 按用户存储时,键从解析出的 principal(`ctx.session.auth.current`)派生,绝不来自模型输入——见 `agent/lib/user-preferences.ts`。偏好文件住在保留的 `user-preferences/` Blob 前缀下,只能经 principal 范围的偏好工具触达。
- 共享的**工厂大脑**从 `FACTORY_REPO` 派生键,绝不来自模型输入或调用方 principal——见 `agent/lib/factory-brain.ts`。它住在保留的 `factory-brain/` Blob 前缀下,只能经 `read_factory_brain` / `update_factory_brain` 触达;写入由 `factoryBrainPolicy` 设门(无人值守拒绝、受信调用方直接写、其他人挂起),使不可信的 issue 正文无法污染每次未来运行都要读的上下文。
- **交接工件**住在保留的 `artifacts/` Blob 前缀下,只能经 `save_artifact` / `read_artifact` 触达——见 `agent/lib/artifacts/config.ts`。读取时 id 由模型提供,所以每个 id 必须先过锚定的 `ARTIFACT_ID_PATTERN`(不含点或斜杠)才能插值进 Blob 键;正是它让站点无法借工件工具去寻址大脑或偏好文件。保存永不覆盖且有大小上限,这让两个工具都足够无害,可以不带门地住在站点里。

## 提交前

- `pnpm validate` 通过(Ultracite check、`tsc`、`eve info` 均 0 错误 / 0 警告)。
- 不暂存任何秘密、`node_modules` 或构建产物(`.eve`、`.vercel`、`.output`)。

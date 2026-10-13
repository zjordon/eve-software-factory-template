---
description: 评审-修复自动循环——ocr 跑分支评审、逐条按严重度门控处置意见、修复提交后自动跑下一轮，直到零意见或连续两轮无 P1/P2 收敛（每轮一次修复提交由本命令授权——用户启动循环即授权；不 push）
argument-hint: "<issue 编号> [背景说明] [--from main] [--to branch] [--max-rounds N]"
allowed-tools: Bash(git:*), Bash(uv:*), Bash(ocr:*), Bash(which:*), Bash(ls:*), Bash(grep:*), Bash(pnpm:*), Read, Edit, Write, Grep, Glob, WebSearch, WebFetch
---

# 评审-修复自动循环（ocr review → 处置 → 提交 → 下一轮）

把「人工跑 code review → 摘要结果 → 修复 → 提交 → 再跑」固化为一轮自动循环。
前置：某 issue 的修复已在分支上实现完毕（分支创建与实现不在本命令范围）。
移植自 TreeWalker 同名命令，已适配本仓环境：pnpm 工具链、`main` 分支、
`pnpm validate` 门禁、`scripts/review_summary.py` 摘要（已随本命令移植）、
`review-issue-<issue>-<N>` 命名、评审 JSON 入库。**无人值守授权**（用户已显
式认可）：用户启动本循环即授权循环内**每轮一次修复提交**与**每轮测试门禁**
（validate + eval fast，后者走真实模型令牌）——这是「不主动 commit」纪律的
显式例外，且仅限这两类；除此之外不产生任何提交，不 push。

## 收敛规则（源仓 P2 实测 47 轮不收敛的教训，必读）

**「零意见」不是可达出口**：LLM 评审员对大 diff 的稳态输出是每轮 10-20 条意见，
与代码质量无关——修复本身持续生产新评审面（加一个告警 → 下轮挑它的去重维度/
归因/测试锚定 → 再下轮挑锚定的措辞），标准是弹性的没有不动点。因此本循环的
收敛判据是**严重度门控**而非零意见：

- **P1**（正确性/安全/数据泄露/契约破坏）与 **P2**（可达路径的健壮性、真实现象的
  观测缺失）：实施。
- **P3**（观测对称性、测试锚定、措辞/注释/结构、防御 unreachable 状态）：登记
  不实施——仅当「改动极小且在当轮已触碰的文件内」可顺手修。
- **连续两轮无 P1/P2 → 宣布收敛终止循环**，P3 backlog 留档，向用户汇报。
- 每轮汇报必须报「P1/P2/P3 分布」而不是只有条数——条数不反映缺陷密度，
  后期条数震荡全是 P3 时就是该停的信号（不要等用户质疑）。

## 参数（$ARGUMENTS）

- 首个纯数字参数 = **issue 编号**（评审结果文件名 `review-issue-<issue>-<N>.json`
  用）；缺省从当前分支名 `fix/<issue>-*` / `feat/<issue>-*` 推导，推不出则停下问用户。
- 其余位置参数（若有）：评审背景说明（业务上下文，喂给 `-B`）。缺省则从 issue
  标题/正文与 `git log --oneline <base>..<branch>` 推导一段，并向用户复述确认口径。
- `--from <base>`：diff 基线，缺省 `main`（本仓主分支）。
- `--to <branch>`：目标分支，缺省当前分支；解析后**不得是 base 自身**，否则停下让用户指定。
- `--max-rounds <N>`：轮次安全上限，缺省 10；达到上限时停下汇报并问用户是否续跑
  （每轮都是真金白银的 LLM 评审，不做无界循环）。

## 前置检查（只读，可立即执行）

0. **续跑/接手检测**（两种形态，都从盘上事实推导，不靠会话记忆）：
   - **状态文件续跑**：`.git/review-loop-state.json` 存在且 `phase != "done"` → 读状态
     文件，核对 `lastCommit` 是当前分支 tip 的祖先（`git merge-base --is-ancestor`；
     相等或落后均正常——采纳修复会产生更新的 tip）后**从记录的轮次续跑**
     （轮号不重推）；不是祖先（分支被外部改写）则向用户确认后重建状态。
   - **孤儿结果收养**（无状态文件或已 done 时必查）：`ls docs/bug-fix/code-review/
     review-issue-<issue>-*.json` 扫出的结果文件中，凡轮号 **大于状态文件/issue 已
     登记轮次**且 `git log --oneline --grep="<issue>"` 无对应修复提交的，即为
     「已生成未处置」的孤儿（典型：用户手工跑了 ocr 还没处置）。按轮号升序
     **先处置完所有孤儿**（初始化状态文件 `round=该轮, phase="triaging"`，走第 2 步
     起的正常流程），全部消化后才进入自动轮转——否则轮号推算（最大号+1）会跳过
     已付费的评审结果、对着同一分支 tip 重复跑一轮。
1. `which ocr`：不在 PATH 则停（open-code-review 需另装，npm 全局包）。
2. `git status --short`：工作区必须干净——未提交改动会混进本轮修复提交；不干净则
   停下让用户先处理。
3. 当前分支与 `--to` 一致（不一致时先确认/切换）。
4. `git log --oneline <base>..<branch> | head -5`：确认分支上确有待评审的实现
   （**ocr 只审已提交 range**——无提交时跑出 skipped 空档）。

## 状态持久化与上下文管理（长循环的生存机制）

单轮循环包含摘要阅读 + 多文件编辑 + 验证输出（validate 秒级；eval fast 约
1.5 分钟走真实令牌），**连续两轮以上上下文消耗已过半**。循环必须做到「任意时点
压缩/重开会话都无损续跑」：

- **状态文件 `.git/review-loop-state.json`**（在 .git 内，永不入库），字段：
  `{issue, base, branch, background, maxRounds, round, phase, stats, lastCommit}`。
  - `phase`：`reviewing`（ocr 在跑）/ `triaging`（处置中，结果 JSON 在盘可重读）/ `done`。
  - `stats`：`{rounds, findings, adopted, rejected, stale}` 累计值。
  - 写入时机：循环启动时、**每次发起 ocr 后台评审前**（round/phase=reviewing）、
    **每轮提交完成后**（stats / round=下一轮；lastCommit=本轮摘要 range 的终点
    head——不是修复提交，修复提交属于下一轮增量）。
  - `lastCommit` 语义：最近一次**完成评审**覆盖的分支 head，作下一轮 diffBase。
- **轮边界主动提醒（上下文 >50% 防线）**：每轮提交完成、即将发起下一轮评审前——
  若本会话已连续处理 ≥2 轮，向用户提示「上下文可能已过半，现在 /compact 最安全：
  循环状态已落盘，压缩后自动续跑或重开 /review-loop 均无损」（压缩是用户侧命令，
  agent 无法代触发）。**提示是通知不是门禁**：用户示意继续、或无人值守无回应时
  直接续跑——压缩/重开的续跑由状态文件机制兜底。评审后台运行的 10-20 分钟空窗
  是压缩的最佳时机。
- **压缩后恢复**：上下文被摘要后第一件事 Read 状态文件——`reviewing` → 等后台任务
  通知或检查输出文件已生成则直接进入处置；`triaging` → 重新跑 review_summary 读
  结果重新逐条处置（已提交的轮次不重复改）。

## 文件命名与轮次编号

- 评审输出：`docs/bug-fix/code-review/review-issue-<issue>-<N>.json`（目录随本命令
  引入，首次使用时自建；JSON **入库**——与源仓 TreeWalker 惯例一致）。
- 轮号 N = `docs/bug-fix/code-review/review-issue-<issue>-*.json` 现有最大号 + 1
  （`ls docs/bug-fix/code-review/ | grep review-issue-<issue>-` 提取）。
- 需要摘要落盘时：`docs/bug-fix/code-review/_r_issue<issue>_<N>.md`（`_` 前缀临时
  文件，**不入库**）。

## 每轮流程

### 1. 跑评审（后台，完成后续跑）

背景文本用 **Write 工具**写到 `.git/ocr-background.md`（UTF-8；**不得**用 `-b`
内联中文——Git Bash 中文传参乱码），同时把状态文件更新为
`{round: N, phase: "reviewing"}`，然后：

```
ocr review --from <diffBase> --to <branch> -B .git/ocr-background.md --format json --output docs/bug-fix/code-review/review-issue-<issue>-<N>.json --audience agent
```

- **增量 diff（防「修复生产新意见」的正反馈）**：`diffBase` 首轮 = `<base>`（如
  main），后续轮 = 状态文件的 `lastCommit`（**上一轮评审覆盖的分支 head**，不是
  上一轮修复提交——修复提交属于下一轮的评审增量；把 diffBase 设成修复提交本身会
  得到空 range：status=skipped、no items selected，本仓第 1 轮实测踩过）——只评审
  增量，旧代码不重复扫（全量重扫是 47 轮不收敛的机制之一）。**上一轮后分支无新
  提交时（全驳回/backlog）→ 增量为空，该轮即视为无 P1/P2 轮**，直接计入收敛
  判据，不空跑评审（空 range 的 ocr 结果 status 是 skipped 而非 complete，按本
  规则处置，不当作零意见收敛）。
- **必须后台运行（run_in_background）**：单轮评审 10-20 分钟，超出前台命令上限；
  任务完成通知到达后继续下一步。
- 完成后删除 `.git/ocr-background.md`。
- 退出码非 0 / 输出文件缺失 → 报告原始错误并**终止循环**，等用户处置。

### 2. 摘要与读取（固定脚本，绝不直接 Read JSON）

先把状态文件翻为 `phase: "triaging"`（压缩后凭它知道要重读结果），然后读摘要：

```
uv run python scripts/review_summary.py docs/bug-fix/code-review/review-issue-<issue>-<N>.json
```

**绝不直接 Read 评审 JSON**（thinking 大块会超限——既定纪律）。摘要不够处置时
加 `--full`（含建议代码全文；体量大，必要时重定向到 `_r_issue<issue>_<N>.md`
再 Read 分段）。已知坑：

- **range 是已提交 range**（manifest.input）——修复未提交时跑新一轮会重复报已修
  findings；先核对摘要头部 head 与当前分支最新提交。
- **comment 可能缺 `severity` 键**（脚本标 `?` 并告警）——按该 comment 的 thinking
  自述原意补严重度判定，不当垃圾丢弃。
- 意见数 = 0 → 本轮零意见，跳到第 6 步收尾；意见数 0 但状态异常（非 complete）→
  按失败处置。
- 评审自评严重度只当**先验**不当裁决（双向误标都有先例）。

### 3. 逐条 triage（P1/P2 实施 / P3 登记 / 驳回 / stale）

对每条意见先定严重度（P1/P2/P3，见「收敛规则」），再独立裁决并落修复，纪律
（源仓数十轮实战沉淀，违反任何一条都会翻车）：

- **外部事实声明先核实再采纳**：协议规格/端点行为类声明用 WebSearch/WebFetch 核实
  官方口径；本仓行为类声明对照 `agent/` 相关实现行号核实（eve 框架行为对照
  `node_modules/eve/docs/` 官方文档）。评审对运行时行为/官方规格的事实断言可能错误。
- **评审给出的修复代码也可能有缺陷**——建议片段须自行核验后再落。
- **驳回必须附实证**（web 链接 / 本仓源码行号 / 结构性不可达分析）；同议题被多轮
  重提时维持既有裁决并引用轮号，除非新证据成立。
- **stale 意见**（对照当前代码已失效/已修，如增量 diff 机制下的旧码重扫）核实后按
  stale 登记处理，不盲改。
- 缺 `severity` 键的意见按 thinking 自述归类后再走以上流程。

### 4. 测试与门禁

- 新增/修改行为同步补测试（evals 用例或类型/结构断言）；期望值锚定实现，
  不「看起来对」。
- **结构门禁（每轮必跑，秒级）**：`pnpm validate`——lint（Ultracite）+ tsc +
  `eve info` 发现诊断，必须 0 错 0 警。
- **行为门禁（每轮跑，真实令牌 ~1.5 分钟，后台）**：`pnpm eval --tag fast`。
  已知坑：eval 要起独立 dev 服务——**2000 端口被占（用户 TUI 在跑）时该轮跳过
  并在汇报中记录**，不阻塞轮转；**eval/validate 都不吃 `.env.local`**（只有
  `eve dev` 加载），脚本注入 env 后再跑；judge gate 在本地零网关形态属预期失败，
  按既有口径记录不阻塞。
- 行为级修复做一次双向验证：临时还原旧实现确认新测试必红，再还原回来。

### 5. 登记与提交

- 存在 `docs/bug-fix/<issue>-*` 或 `docs/implement-plan/` 下与该 issue 关联的文档时，
  在文末追加本轮登记：轮号、采纳/驳回/stale 计数与要点（含驳回理由）、门禁结果；
  无关联文档则随汇报给用户，收敛后由用户决定是否补文档/评论到 issue。
- 中文 commit message 用 Write 写 `.git/COMMIT_MSG.txt`（UTF-8），
  `git commit -F .git/COMMIT_MSG.txt`，提交后删除消息文件（shell 传参乱码纪律）。
- `git add` 范围：源码 + 测试 + 本轮评审 JSON（入库惯例）+ 相关 docs；
  **`_` 前缀临时摘要文件、`.git/` 内文件、`.env*` 一律不加**。
- 提交钩子若失败如实报告并修复后重试，不得 `--no-verify`。
- **不 push**。每轮一次修复提交由本命令授权（用户启动循环即授权——见开篇
  「无人值守授权」）；除此之外不产生任何提交。

### 6. 轮转与收尾

- 意见数 > 0：更新状态文件（stats 累计、`lastCommit`、`round: N+1`），向用户简报
  本轮处置（P1/P2/P3 分布 + 采纳/驳回/stale 计数 + 关键修复一句），然后：
  - **本轮与上一轮均无 P1/P2 → 宣布收敛**（状态 `phase: "done"`，P3 backlog 留档），
    不等额度；
  - **本会话已连续处理 ≥2 轮 → 先做轮边界上下文提醒**（见「状态持久化与上下文
    管理」），用户示意继续则直接续跑；
  - N+1 回到第 1 步自动续跑下一轮。
- 意见数 = 0：循环收敛——状态文件写 `phase: "done"` 与最终 stats，汇报累计数据
  （总轮数、累计意见/采纳/驳回/stale、分支提交数），等用户后续指令
  （/finish-issue 收尾等由用户决定，本命令不做收尾）。
- 达到 max-rounds：状态文件保留暂停态（记录已完成轮数），停下汇报进度，问用户
  是否继续。

## 硬性红线

- 评审 JSON 绝不直接 Read（只经 review_summary.py）；命令退出码绝不接管道 `| tail`
  （会掩码退出码）；中文绝不走 shell 传参。
- 不 force push、不 `--no-verify`、不 amend 已发布提交、不 push（用户明确要求除外）；
  每轮一次修复提交由本命令授权（用户启动循环即授权），除此之外不产生任何提交。
- 测试不走真实 GitHub 写操作（评审修复的测试同样遵守；只读 API 可接受）。
- 循环中断（失败/上限/用户叫停）后，工作区必须处于干净已提交状态，方便随时重启续跑。

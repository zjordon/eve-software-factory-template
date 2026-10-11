# 路线 B 操作步骤(v3):定制按钮 URL 为新工程接入第 N 个工厂实例

> 生成时间: 2026-10-11(v3:工厂 B `eve-factory-examination` 全流程实测通过后重写;v2 的两处理实测不符已修正,新增串线事故与隔离铁律)
> 原理:Deploy 按钮只是一条带参数的 URL;把 `repository-url` 指向自己的 fork(已含智谱改造),`repository-name`/`project-name` 换新名字,一次解决重名冲突和模型移植两个问题。
> 前置阅读:`out/部署手册.md`(坑位编号沿用)。本流程已固化为用户级技能 `create-factory`。

## 隔离铁律(最重要的一条,先读)

**每个工厂一个 GitHub App,每个 App 只安装在自己的 FACTORY_REPO 上,别的一个仓库都不勾。** eve 的 github 通道只按 `factory` 标签派发、不校验事件来自哪个仓库——App 安装范围是唯一隔离层。

2026-10-11 串线事故实录:工厂 A 的 App `zjordon-foreman` 当年装成了 "All repositories",工厂 B 上线当天 examination-system 的 issue #8 打标签后**两个工厂同时接单**(foreman 17 秒内抢跑),在用户真实仓库里留下重复评论,还在 factory-playground 开了跨仓库引用的错乱 PR。补救:foreman 收窄到只装 factory-playground + 清理遗留物。**所以每次建新工厂,阶段 3 都要审计所有旧工厂 App 的安装范围。**

## 阶段 0:准备(输入清单)

1. `FACTORY_REPO`:`<owner>/<new-repo>`,已存在于 GitHub(私有仓库也可,全链路实测通过)
2. 短名 `<slug>`:新仓库/新项目都用 `eve-factory-<slug>`(建议直接用目标仓库名)
3. 新 GitHub App 名:惯例 `<owner>-<角色名>`(现有:foreman→factory-playground、examiner→examination-system)。它会成为机器人的 @提及 名
4. 技术栈 → `FACTORY_SETUP_COMMAND`(沙箱是 Linux,命令要无交互引导工具链并装上 dev 依赖):
   - Python + uv:`curl -LsSf https://astral.sh/uv/install.sh | sh && export PATH="$HOME/.local/bin:$PATH" && uv sync --extra dev`
   - Node + pnpm:`pnpm install`(或 corepack 引导)
   - 无依赖仓库:可省略此变量
5. 本地检查命令(implementer 站点会跑):从 pyproject.toml / package.json / README 探测

## 阶段 1:定制按钮 URL,走浏览器部署流

6. 打开定制 URL(JSON 参数需 URL 编码;`repository-url` 指向 fork,新工厂生来就是智谱版):

```
https://vercel.com/new/clone
  ?project-name=eve-factory-<slug>
  &repository-name=eve-factory-<slug>
  &repository-url=https://github.com/zjordon/eve-software-factory-template
  &env=FACTORY_REPO,FACTORY_LABEL
  &envDefaults={"FACTORY_LABEL":"factory"}
  &connect=[{"type":"github","env":"GITHUB_CONNECTOR","triggers":true,"triggerPath":"/eve/v1/github"},{"type":"linear","env":"LINEAR_CONNECTOR","triggers":true,"triggerPath":"/eve/v1/linear"}]
  &stores=[{"type":"blob","access":"public"}]
  &redirect-url=https://ask-foreman.dev/welcome
```

7. 浏览器流(chrome-devtools MCP 可全自动,陷阱见文末):
   - 初始表单只有禁用的 Create:先点 **GitHub provider 按钮**(`github/connect-button`)激活 Git 连接,仓库名输入框出现且已预填,Create 解禁
   - 点 Create 后四个区块**顺序解锁**:Products → Connectors → Environment Variables → Deployment(未解锁的卡片挂着 `title="Complete the <上一步> step to continue."`)
   - **Products**:Add → Blob 对话框(店名 `eve-factory-<slug>-blob` 预填、public 预选,Hobby 上 private 不可选)→ Create。无需付款方式
   - **GitHub 连接器** Add → 对话框:Managed 模式(默认)→ namespace 组合框(输入账号名 + Enter 提交)→ 表单展开:
     - App Name:预填的是项目名,**改成 `<owner>-<角色名>`**
     - **Triggers 默认只勾 pull_request(坑⑥原样重演)——当场打开 "Trigger event types: 1 selected",补勾 5 个事件:`issues`、`issue_comment`、`check_suite`、`pull_request_review_comment`(pull_request 已有)。复选框本体点不动,点同名按钮**
     - Permissions(11 selected 默认)不动,与两个工厂实测可用集一致
     - Continue → Customize(品牌可选项,跳过)→ Create Connector
   - **GitHub sudo 认证**:弹出 "Confirm access" 页,创建 App 是敏感操作,**必须用户本人认证**(passkey/验证器/密码),认证后 manifest 确认页用户自己点 Create,页面自动回流
   - 回到 Vercel:"Your GitHub connector has been created" → 点 **Install to your GitHub org** → 安装页:**Repository access 从默认的 "All repositories" 改成 "Only select repositories",搜索并只勾 `<FACTORY_REPO>`**(注意相似名仓库,如 examination-system ≠ order-examination-system)→ Install
   - **Linear 连接器** Add:workspace 组合框(输入 + Enter)→ Connector Name 预填 → scopes 默认 → Create Connector → Install Linear → Linear 授权页 Authorize(默认 All public teams 即可)
   - **Environment Variables**:`FACTORY_REPO` 填 `<owner>/<new-repo>`(值字段是 textarea;`FACTORY_LABEL` 已有默认 factory)
   - 点 **Deploy** → 等成功页。流程中可能另弹 "Installing Vercel" 页(git 集成):Vercel 官方 App 已装且为 All repositories 时无事可做,直接关

产物:私有仓库 `eve-factory-<slug>` + Vercel 项目 + Blob + 连接器对(github 与 linear 的 UID 由流程自动写入环境变量,无需手动对)。

## 阶段 2:CLI 补配置

8. 克隆、关联、无痕搬密钥(密钥永不进对话;文件重定向防 BOM):

```powershell
git clone https://github.com/zjordon/eve-factory-<slug>.git factory-<slug>
cd factory-<slug>
pnpm exec vercel link --yes --project eve-factory-<slug>

# ZHIPU_API_KEY 从任一旧工厂无痕搬运(三环境各一条):
$key = ((Get-Content <旧工厂目录>\.env.local | Where-Object {$_ -like 'ZHIPU_API_KEY=*'}) -replace '^ZHIPU_API_KEY=','').Trim().Trim('"')
[System.IO.File]::WriteAllText("$env:TEMP\k.txt", $key)
cmd /c "pnpm exec vercel env add ZHIPU_API_KEY production --type config < %TEMP%\k.txt"   # preview、development 同理
Remove-Item "$env:TEMP\k.txt" -Force

# FACTORY_SETUP_COMMAND(见阶段 0 第 4 条):
[System.IO.File]::WriteAllText("$env:TEMP\setup.txt", '<命令>')
cmd /c "pnpm exec vercel env add FACTORY_SETUP_COMMAND production --type config < %TEMP%\setup.txt"
```

9. **重部署**(环境变量要重部署才进运行时;git 集成开箱即用,push 即部署,约 25 秒):

```powershell
git commit --allow-empty -m "chore: trigger redeploy with ZHIPU_API_KEY and FACTORY_SETUP_COMMAND"
git push origin main
```

注意顺序:若 FACTORY_SETUP_COMMAND 在 push 之后才加,再 push 一个空提交。核验:`pnpm exec vercel ls` 最新部署 Ready、`pnpm exec vercel env ls` 六个变量齐全。

## 阶段 3:Hobby 陷阱清理

10. **关部署保护**(坑⑩):`https://vercel.com/tree-ai1/eve-factory-<slug>/settings/deployment-protection` → Vercel Authentication → Require Log In 取消 → Save → 轮询 `https://eve-factory-<slug>-tree-ai1.vercel.app` 直到非 302(200 即可,传播要几分钟)
11. **审计所有旧工厂 App 的安装范围**(串线事故的教训,每次必做):`github.com/settings/installations` → 逐个旧工厂 App → Repository access 必须是 Only select repositories 且只含自己的 FACTORY_REPO。发现 "All repositories" 立即收窄——收窄也是 grant 页操作,护栏会要用户确认
12. 事件订阅已在阶段 1 配齐(坑⑥在源头免疫),可抽查:App settings → Permissions & events 应显示 5 项

## 阶段 4:终验

13. 建标签并触发:

```powershell
gh label create factory --repo <owner>/<new-repo> --color 5319e7
gh issue create --repo <owner>/<new-repo> --title "Add hello.txt" --body "Create hello.txt at repo root containing: hello world"
gh issue edit <issue号> --repo <owner>/<new-repo> --add-label factory
```

14. 预期时序(工厂 B 实测全程约 13 分钟):分类评论 → 分析评论(计划对准目标仓库技术栈)→ 实现评论(FACTORY_SETUP_COMMAND 装好依赖、跑通检查)→ 评审 → "The full pipeline ... draft pull request is up: #N" → **关联 issue 的草稿 PR**(Closes #N,四段式正文,验收标准全勾)
15. **评论作者只允许出现新 App 的机器人**——出现任何旧工厂机器人 = 串线,立即回阶段 3 第 11 步
16. 静默超 10 分钟:按部署手册排查表(App Advanced 投递记录 → 响应码 → `vercel logs`)

## 阶段 5(可选):本地 TUI

`factory-<slug>` 目录:`pnpm exec vercel env pull .env.local --yes` + 手动加 `ZHIPU_API_KEY` → `pnpm dev`。

## 多工厂台账

| 工厂 | Vercel 项目 | GitHub App | 连接器 UID | 服务仓库 | 本地目录 |
|------|------|------|------|------|------|
| A | eve-software-factory-template | zjordon-foreman | github/github | zjordon/factory-playground | fork\eve-software-factory-template |
| B | eve-factory-examination | zjordon-examiner | github/zjordon-examiner | zjordon/examination-system | factory-examination |

每建一个新工厂更新此表。Hobby 连接器限额:500 token 请求 + 1000 触发转发 / 30 天,超出暂停——App 装的仓库越少事件越少,又是保持最小范围的理由。

## v3 相对 v2 的修正与新增

- 修正:环境变量不在首个表单上,而是连接器完成后的第三区块(顺序解锁机制)
- 修正:连接器 UID 规则——按钮流程用 App 名拼 UID(`github/zjordon-examiner` 而非 `github/github`),但环境变量由流程自动写入,无需手动配
- 新增:GitHub provider 按钮激活、Blob 对话框、sudo 认证暂停点、事件订阅表单内补齐(坑⑥从"事后修"变"源头配")
- 新增:阶段 3 第 11 步"审计旧 App 范围"与隔离铁律
- 坑②消失:Vercel 官方 App(All repositories)覆盖 git 集成,push 自动部署实测可用
- `vercel link --yes --project <名字>` 可跳过全部交互

## 浏览器自动化陷阱(Vercel 表单页专用)

- a11y 树大面积丢元素(React portal):输入框/按钮不在 take_snapshot 里,用 evaluate_script 直查 DOM(按 name/testid/textContent)
- fill 到非空输入框会**追加**而非替换:先 click + Ctrl+A 再 type
- 隐藏 1px 复选框点不动(事件订阅):点同名 BUTTON
- 组合框选择:输入过滤文本 + Enter(JS 直接 click option 不触发 React 状态)
- take_screenshot 偶尔挂起 120 秒以上:转后台不等,改用 DOM 查询
- 快照落盘(filePath)+ Grep 按需读,避免撑爆上下文

## PowerShell 5.1 陷阱

- 管道传值给 `vercel env add` 前置 BOM:文件重定向(见第 8 步)
- jq 表达式里的双引号被 PS 剥掉(`contains("x")` 变 `contains(x)`):改用 `ConvertFrom-Json` + `Where-Object`
- 删 issue 评论的 REST API 要数字 ID;`gh --json` 返回的 `.id` 是 GraphQL ID(IC_ 开头),先用 `gh api repos/.../issues/N/comments` 拿数字 ID

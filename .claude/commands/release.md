---
description: 发布新版本——整理 changelog、bump 版本号、打 tag、建 GitHub Release（先展示计划，确认后再执行）
argument-hint: "[版本号|auto，例如 v0.1.0；留空则根据提交自动建议]"
allowed-tools: Bash(git:*), Bash(gh:*), Read, Edit, Write, Grep, Glob
---

# 发布新版本

你要帮用户发布本项目的新版本。**严格遵守"先展示计划、等用户确认、再执行写操作"的原则**——本会话纪律是不主动提交/推送，任何 tag / commit / push / release 动作都必须在用户明确确认后才执行。

## 参数

用户输入：$ARGUMENTS

- 若为空或 `auto`：根据自上个 tag 以来的提交自动建议版本号
- 若为具体版本号（如 `v0.1.0` 或 `0.1.0`）：以它为目标，但仍需按 SemVer 校验合理性，不合适时提醒用户

## 第一步：收集信息（只读，可立即执行）

并行读取以下信息：

- 当前版本：读 `package.json` 的 `"version"` 字段
- 上个 tag：`git describe --tags --abbrev=0`（无 tag 时说明这是首个版本，从 `0.0.0` 起算）
- 自上个 tag 以来的改动：`git log <上个tag>..HEAD`（看完整 commit message，关注 conventional commit 前缀 feat/fix/BREAKING）
- 工作区状态：`git status -s`（必须干净，否则停下提醒用户先处理未提交改动）
- 当前分支：确认在 `main`，且已 `git pull` 到最新

## 第二步：建议版本号（SemVer）

基于提交前缀判断：

- 含 `BREAKING CHANGE` 或 `feat!:` / `!:` → **MAJOR**（x.0.0）
- 含 `feat:` → **MINOR**（x.y.0）
- 其余 `fix:`/`docs:`/`chore:` 等 → **PATCH**（x.y.z）

给出建议版本号并说明判断依据。

## 第三步：整理 changelog 草稿

按 **Keep a Changelog** 风格生成新版本段落，分类用 `### Added` / `### Fixed` / `### Changed` / `### Docs` 等：

```markdown
## [X.Y.Z] - YYYY-MM-DD

### Added
- ...

### Fixed
- ...
```

`CHANGELOG.md` 尚不存在时按骨架新建（头部说明 + `## [Unreleased]` 占位 + 本次版本段落）。注意：CHANGELOG 里版本号用 `[X.Y.Z]`（不带 v），git tag 用 `vX.Y.Z`（带 v）。

## 第四步：展示完整发布计划，等用户确认

向用户展示以下内容并**明确请求确认**，未确认前不做任何写操作：

1. 新版本号 + 判断依据
2. changelog 段落草稿
3. 即将改动的文件：
   - `package.json`：version 改为 `X.Y.Z`
   - `CHANGELOG.md`：顶部插入新版本段落（不存在则新建）
4. 即将执行的 git/gh 命令清单：
   - `git add package.json CHANGELOG.md`
   - `git commit -F <msgfile>`（`chore(release): vX.Y.Z`，中文经 UTF-8 文件，不走 `-m`）
   - `git tag -a vX.Y.Z -m "Release vX.Y.Z"`
   - `git push origin main`
   - `git push origin vX.Y.Z`
   - `gh release create vX.Y.Z --notes-file <notes.md>`（notes 用 Write 写 UTF-8 文件，避免中文经 shell 乱码）

## 第五步：确认后执行

用户确认后，**分步执行、每步报告结果**：

1. Edit `package.json` 改 version
2. Edit/Write `CHANGELOG.md` 插入新版本段落
3. `git add` + `git commit -F`
4. `git tag -a vX.Y.Z -m "..."`
5. `git push origin main` 和 `git push origin vX.Y.Z`
6. `gh release create vX.Y.Z --notes-file ...`

任一步失败立即停下，不要继续后续步骤，报告错误让用户决定。用完删除临时文件。

## 约束

- 仅用附注 tag（`git tag -a`），不用轻量 tag
- tag 必须显式 push（`git push` 默认不推 tag，否则 GitHub 看不到）
- `gh` 未登录或无 remote 时停下，提示用户先 `gh auth login`、确认 `git remote -v` 有 origin
- 发布是对外、难逆转的操作：宁可多确认一次，不要自作主张

# Changelog

本文件记录 tree-shipyard 的版本变更,格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/),版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [Unreleased]

## [1.0.0] - 2026-11-15

首个正式版本:tree-shipyard,树哥的软件工厂——自托管形态的 eve software factory(前 eve-software-factory-template 深度改造)。

### Added

- 自托管主线 M1-M4:自持 GitHub App 凭据(JWT 换 1h 安装令牌)、pm2 常驻 + Basic 路由鉴权、cloudflared 命名隧道无人值守(webhook 五事件)、Docker 站点沙箱与自建镜像(uv+Chromium)、每日备份与孤儿容器巡检
- M5 可观测性:metadata-only 运行记录面(幂等 upsert,断电重放安全)、只读运行面板(列表/详情/NDJSON 实时流/僵尸检测置顶)
- M6 面板体验:管线图与甘特双视图(一键切换)、列表迷你管线、实时流驱动状态机、站级白名单摘要
- 智谱 GLM 直连(Anthropic 兼容端点)全线替代 AI Gateway
- factory/ 分支前缀与 main/master 保护的结构化强制

### Fixed

- 运行期实战与评审处置批次:备份预检守卫、沙箱凭据清理 best-effort、巡检零时间戳防误删、Blob 写入原子性、僵尸检测终态边界(#1/#3/#5 评审循环全量收敛)

### Changed

- 更名 tree-shipyard,从模板分家立户;云端 A/B 冻结维护,自托管为唯一活跃形态

### Docs

- architecture、自托管实施方案、运维手册、M1-M6 六份实施计划与评审记录全量回写

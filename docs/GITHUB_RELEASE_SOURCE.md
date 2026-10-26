# GitHub 更新源配置

本项目的稳定更新源固定为公开仓库 [JLKin/Study--Assistant](https://github.com/JLKin/Study--Assistant) 的 GitHub Releases。

仓库根 `release.config.json` 为后续双包构建提供配置：

```json
{
  "owner": "JLKin",
  "repo": "Study--Assistant",
  "channel": "stable",
  "provider": "github"
}
```

使用支持此配置的新版构建脚本执行 `npm.cmd run package:release -- --official`，两种成品会生成同一份 `resources/update-source.json`。环境变量可临时覆盖构建配置；客户端不需要作者的 GitHub Token。

注意：这个配置文件不会给旧客户端增加更新能力，也不会自动发布 Release。当前构建脚本及运行代码是否已同步到仓库，应由最终版本交付者单独核对。

## 地址

- 发布页：`https://github.com/JLKin/Study--Assistant/releases`
- 正式发布查询：`https://api.github.com/repos/JLKin/Study--Assistant/releases?per_page=20`
- 最新正式版清单：`https://github.com/JLKin/Study--Assistant/releases/latest/download/release-manifest.json`
- 最新正式版公告：`https://github.com/JLKin/Study--Assistant/releases/latest/download/announcements.json`
- 安装版更新元数据：`https://github.com/JLKin/Study--Assistant/releases/latest/download/latest.yml`

客户端仅接受较新的正式 Release，忽略 draft 和 pre-release。更新检查实际按所选 Release 的附件读取清单及程序包；不要通过覆盖仓库根的 `version.json` 或旧预发布附件来代替新版发布。

## 每次发布

1. 在包含最终源码的提交上使用唯一版本号，构建、核验安装版和免安装版。
2. 创建对应 `v<version>` 的 Release 草稿。Tag、包内版本和 `release-manifest.json` 必须一致，Tag 应指向对应源码提交。
3. 上传同一构建目录中的以下 7 个文件：

   - `ZHS-Study-Assistant-<version>-win-x64-Setup.exe`
   - `ZHS-Study-Assistant-<version>-win-x64-Portable.zip`
   - `ZHS-Study-Assistant-<version>-win-x64-Setup.exe.blockmap`
   - `latest.yml`
   - `release-manifest.json`
   - `announcements.json`
   - `SHA256SUMS.txt`

4. 核对大小、SHA-256、Setup 对应的 SHA-512、公告版本和双包启动检查。确认最终版本后发布为正式版，避免勾选 pre-release；需要成为默认更新目标时设为最新发布。
5. 用支持新更新协议的前一版本验证检查、下载、取消及人工确认应用。真实 Setup 覆盖安装、免安装切换和数据保留需要分别验收。

客户端不带发布凭据。发布者在 GitHub 网页或开发机的 GitHub CLI 登录后上传文件；凭据不能写入配置、成品、公告或仓库。已公开的同版本程序包不替换字节，有新改动则增加版本号。

## 2026-10-26 核对状态

仓库根 `release.config.json` 与本说明已同步到 `main`。经作者授权，[v0.3.1 正式版](https://github.com/JLKin/Study--Assistant/releases/tag/v0.3.1) 已发布为最新版本，7 个附件齐全，线上大小与 SHA-256 核对通过，清单、latest.yml 和公告回读一致。生产用更新源解析模块已实网确认 0.3.0 可发现 0.3.1，同版本不重复更新。旧 v0.1.0 预发布保持不变。

本轮发布只上传既有程序包与元数据，没有同步本地的新业务源码；GitHub 自动生成的 Source code 压缩包不代表 v0.3.1 程序包的对应源码。真实 Setup 覆盖升级及免安装版退出切换尚待隔离环境 A→B 验收，更新查询通过不能代替该结果。

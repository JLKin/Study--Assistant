# 智慧树学习助手

Windows 桌面学习辅助工具，提供课程视频播放监测、章节切换、弹窗处理、运行状态与参数设置。

**当前版本：测试版 v0.1（程序版本 `0.1.0`）**。界面包含「刷课 / 设置 / 使用说明」三个页签。

## 下载与使用

- [下载 Windows x64 免安装包](https://github.com/Wangyibo0703/zhihuishu-study-assistant/releases/download/v0.1.0/%E6%99%BA%E6%85%A7%E6%A0%91%E5%AD%A6%E4%B9%A0%E5%8A%A9%E6%89%8B-%E6%B5%8B%E8%AF%95%E7%89%88v0.1-win-x64.zip)
- [查看测试版发布说明与全部附件](https://github.com/Wangyibo0703/zhihuishu-study-assistant/releases/tag/v0.1.0)
- [使用说明](docs/使用说明.md)

需要 Windows 64 位环境与 Microsoft Edge。当前按 Windows 10/11 使用场景提供，未完成所有系统版本的兼容性验收。
普通使用者无需安装 Node.js 或 Python。完整解压压缩包，再双击 `智慧树学习助手-测试版v0.1.exe`；请保留同目录的资源文件。

首次启动阅读并确认程序内的使用声明。在「刷课」页输入课程名，或留空处理课程队列；点击「开始刷课」，在弹出的专用 Edge 窗口中自行登录。登录和人机验证需要人工处理。

## 当前功能

- 支持共享课与智慧课程两类已适配播放页；站点改版或不同课程布局可能影响使用。
- 监测视频播放，按设置的阈值切换章节（默认 81%）。平台是否记录完成，以平台显示为准。
- 处理已适配的播放弹窗；弹题采用随机选择，不保证答案正确。
- 显示当前课程、视频、播放进度和运行日志，支持停止与断点记录。
- 设置切章阈值、刷新间隔、等待时间、异常停止和提醒等参数。
- 使用独立浏览器配置目录；支持手动重置浏览器配置。

章节测试尚未接入默认桌面流程。倍速与验证码需要人工操作。软件中的更新检查需配置更新源后才会工作，详见 [维护与发布](docs/维护与发布.md)。

## 数据与隐私

桌面主进程的打包版数据目录为 `%APPDATA%\智慧树学习助手\data`，开发版为项目根目录 `data/`。当前内核的目录初始化存在已知问题，浏览器配置与内核日志的实际位置还需按启动方式核验，见 [开发说明](docs/开发说明.md#已知目录初始化问题)。
浏览器配置、登录会话、运行日志和截图可能包含个人信息，请勿上传或转发这些目录。

本仓库只包含源码、配置模板与测试素材，不包含作者本机的登录数据或内部验收档案。
反馈问题时请先移除姓名、账号、Cookie、课程链接中的身份参数和截图中的个人信息。

## 从源码运行

开发环境：Windows、Node.js 24、npm、Microsoft Edge。依赖版本以 `package-lock.json` 为准。

```powershell
npm.cmd ci
npm.cmd run setup:electron
npm.cmd run typecheck
npm.cmd test
npm.cmd run build
npm.cmd start
```

`npm ci` 与 Electron 安装需要联网；若 Electron 已完整安装，安装脚本会复用已有文件。
默认测试包含本地浏览器集成测试，需要 Edge；测试结果不等同于真实平台验收。OCR 专项不属于普通使用流程，需要额外 Python 环境，见 [开发说明](docs/开发说明.md)。

```powershell
# 在 Windows 上生成免安装包（先确保 Electron 安装完成）
npm.cmd run package:app
```

打包结果位于 `release/`，压缩包和校验值在同一版本目录。当前发布附件为作者提供的原始压缩包，未重新打包；本次公开源码整理不构成二进制可复现构建保证。

## 项目结构

| 目录                | 内容                                         |
| ------------------- | -------------------------------------------- |
| `apps/desktop/`     | Electron 主进程、预加载脚本与桌面界面        |
| `tools/auto-study/` | 当前桌面流程使用的浏览器与播放内核           |
| `packages/`         | 状态持久化、任务、浏览器桥接、站点适配等模块 |
| `scripts/`          | 构建、打包与开发验收工具                     |
| `tests/`            | 单元测试、本地模拟页面与集成测试             |
| `docs/`             | 使用、开发与发布说明                         |

## 使用范围与许可

请仅在本人有权访问的课程中使用，并遵守平台与学校的规则。平台完成状态以官方页面为准。测试版可能存在缺陷，不承诺持续兼容。

**源码公开不代表已经采用开源许可证。** 当前保留原工程的 `UNLICENSED` 声明，未新增 MIT、GPL 等授权。第三方组件分别遵循自身许可，见 [第三方说明](THIRD_PARTY_NOTICES.md)。关于公开仓库与许可证的区别，参阅 [GitHub 官方说明](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/licensing-a-repository)。

## 问题反馈

请通过 [Issues](https://github.com/Wangyibo0703/zhihuishu-study-assistant/issues) 提交可复现步骤、软件版本、Windows/Edge 版本和脱敏后的错误提示。不要公开上传浏览器配置、登录会话或完整运行数据。

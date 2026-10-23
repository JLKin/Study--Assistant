# 自动学习内核

当前 Electron 桌面流程通过 `apps/desktop/main/kernel.ts` 调用本目录下的纯 ESM 模块。浏览器启动与配置在 `src/browser.mjs`，任务协调在 `src/engine.mjs`，两类页面适配主要位于 `src/site.mjs`、`src/mooc.mjs` 与 `src/hall.mjs`。

普通使用者请参阅仓库首页和 `docs/使用说明.md`。命令行入口保留在 `src/cli.mjs`、`src/console.mjs` 和两个 `.bat` 文件中，需要从源码安装 Node.js 依赖。

`config.json` 为默认配置；`data/`、`logs/` 和 `shots/` 为本地运行目录，均不进入仓库。不得上传浏览器配置或登录会话。

`src/quiz.mjs` 为实验性章节测试模块，未接入默认桌面流程。源码中保留的实验能力不代表桌面版已支持或完成真实验收。

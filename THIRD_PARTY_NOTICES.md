# 第三方组件说明

本项目自身保持 `UNLICENSED`；第三方组件继续适用各自许可证。

| 组件                         | 本次版本 | 许可                                  | 上游                                    |
| ---------------------------- | -------- | ------------------------------------- | --------------------------------------- |
| Electron                     | 44.9.0   | MIT；所含 Chromium 等组件另有各自许可 | https://github.com/electron/electron    |
| Playwright / playwright-core | 1.64.1   | Apache-2.0；附带第三方说明            | https://github.com/microsoft/playwright |

作者提供的 Windows 压缩包内已包含 Electron 的 `LICENSE`、`LICENSES.chromium.html`，以及应用归档中 Playwright 的 `LICENSE`、`NOTICE`、`ThirdPartyNotices.txt`。再次分发时请保留这些文件及原有版权声明。

开发工具及其传递依赖的版本和许可元数据保留在 `package-lock.json`；OCR 可选依赖另见 `packages/ocr/requirements.in` 与对应锁定文件。本表不替代依赖包内的完整许可文本。

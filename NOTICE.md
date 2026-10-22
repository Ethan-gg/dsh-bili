# 第三方组件与许可

本插件（`dsh-bili-scroll` / **B站鱼娘**）本体以 **MIT** 协议发布，正文见仓库根目录的 `LICENSE`。

## 内置第三方组件

- `vendor/bilibili-mcp/` —— **bilibili-mcp**（**MIT**，Copyright (c) 2026 AGI_Ananas）
  - 内置的 Python MCP 服务；完整许可见该目录下的 `LICENSE`
- `vendor/qrcode/` —— **qrcode-svg**（**MIT**，纯 JS、零依赖）—— 用来在**不装 Python** 的机器上画登录二维码
  - 其中 QR 编码算法来自 Kazuhiko Arase 的 *QRCode for JavaScript*（同样是 MIT）
  - 存放为 `qrcode.cjs`：本包是 ESM，vendor 的 CJS 用 `.cjs` 才不会被 Node 当成 ESM
  - 完整许可见该目录下的 `LICENSE`

## 参考资料

部分模块（生物钟 / 分享闸门 / 通知后端 / 运行时定位）在实现时参考了开源项目
[`dsh-bili-whale`](https://github.com/Alterssss/dsh-bili-whale)（**MIT**）的公开实现。
按 MIT 许可要求，该项目的版权声明随本仓库保留在此：**Copyright (c) dsh-bili-whale 作者，MIT License**。
本项目其余代码为本项目原创。

## 关于版权

`LICENSE` 第一行写的是 `Copyright (c) 2026 c1overzz`。
二次分发时保留这一行与 MIT 正文即可，不必另行取得授权（MIT 本身就允许改、再发、商用）。

---
*本文件只是说明，不构成额外限制。*

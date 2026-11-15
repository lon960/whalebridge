# 目录说明

这个仓库里**只有我们自己写的东西**。

```
src/injector/     注入器：把 JS 送进 QQ 进程（C，约 250 行）
src/engine/       引擎：在 QQ 进程内把 ntApi RPC 翻成 OneBot v11（JS，单文件）
scripts/          安装 / 启动 / 看门狗 / 卸载（PowerShell + 一个 node 小脚本）
examples/         最小客户端（Python 标准库，无第三方依赖）
docs/             接口表、移植指南
bin/              编译产物，不入库（见 .gitignore）
bridge/           不在本仓库，见下
```

## 关于 `bridge/`

伴侣项目 [qq-bridge](https://github.com/Derpyu520/qq-bridge)（MIT）是独立的上游，
**不在本仓库里分发**。它是"人格 / 记忆 / 工具 / 控制台"那一层，可选：

- 只要 OneBot 接口 → 装引擎就够了，`bridge/` 留空
- 想要完整机器人 → 自己 clone 上游，然后
  `install.ps1 -BridgeSource <qq-bridge 路径>`

`install.ps1` 检测不到 `bridge/src/bridge.js` 时会跳过这一层并照常装好引擎。

## 为什么 bin/ 不入库

`payload.dll` 与 `wbinj.exe` 是编译产物。仓库里放二进制有三个坏处：
审计不了、可复现性差、每次改一行 C 都要提交一次二进制。

用 CI（`.github/workflows/build.yml`）或本地编译都能得到它们，见 README 的
「Build the injector」。release 附件里会带编译好的二进制。

## 子目录

| 路径 | 内容 |
|---|---|
| `docs/engine-api.md` | 引擎全部 HTTP/WS 路由、消息段格式、可直接调用的 cmdName |
| `docs/porting.md` | 换 QQ 版本时怎么重新找锚点、编译纪律、除错检查表 |
| `examples/ws_client.py` | 手写 RFC6455 的最小 OneBot 客户端，兼烟测 |

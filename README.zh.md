# WhaleBridge 鲸桥

**一种全新的 QQ 机器人连接方式。**

> 不重写协议，也不模拟登录。WhaleBridge 把引擎注入**真实的 QQ 客户端**，
> 借它已经登录好的会话直接发消息。对外是标准 OneBot v11，对内是 QQ 自己的 SSL 通道。

[English](README.md) | [中文](README.zh.md)

---

## 这是什么

多数 QQ 机器人框架（NapCat、Lagrange、go-cqhttp）走的是"重写协议"路线：自己实现握手、
自己实现加密、自己拼 SSO 包。代价是要不停追票据格式、跟风控打架，而且始终有一个封号面。

WhaleBridge 反过来：

```
传统方案：  你的程序 --（伪造的协议包）--> QQ 服务器
WhaleBridge：你的程序 --（注入到 QQ.exe 里）--> QQ 自己发
```

一个约 6 KB 的 DLL 改掉 `QQNT.dll` 里内嵌的 Node 源码中的**一个注释块**，让真客户端加载
我们的引擎；引擎通过官方 UI 用的那套内部 RPC 跟 QQ 内核对话，对外暴露标准的
**OneBot v11**（HTTP + WebSocket）。任何已经会说 OneBot 的东西直接就能用。

因为包是真客户端发出去的，没有指纹要伪造，也没有票据要偷。代价如你所料：
**它绑 QQ 版本。**

## 架构

```
┌──────────┐   OneBot v11   ┌───────────────┐   HTTP/WS   ┌────────────┐   HTTP   ┌────────┐
│ QQ 9.9.x │ <────────────> │ engine.cjs    │ <─────────> │ qq-bridge  │ <──────> │ 任意   │
│ (客户端) │  :3902         │ (在 QQ 进程内) │             │ :3100      │          │ agent  │
└──────────┘                └───────────────┘             └────────────┘          └────────┘
     ↑                             ↑
 payload.c (DLL)            OneBot v11 适配层
```

| 部件 | 跑在哪 | 干什么 |
|---|---|---|
| `src/injector/` | C，约 250 行 | 启动时把我们的 JS 塞进客户端 |
| `src/engine/engine.cjs` | **QQ 进程内** | ntApi RPC ⇄ OneBot v11 |
| `qq-bridge` | 独立 Node 进程 | 人格、记忆、工具、控制台（[独立仓库](https://github.com/Derpyu520/qq-bridge)） |

引擎刻意**零依赖**（只用 `fs` / `http` / `path` / `electron`），因为它跑在别人的进程里，
不能扰动那个进程的模块加载器。

## 状态

| | |
|---|---|
| 实测通过 | QQ **9.9.37-54395**，Windows 11 x64（build 26200） |
| 其它 9.9.x | 靠标记锚点**预期**可用，**未实测** |
| Windows 10 x64 1809+ | 应该可以（Node 24 基线），**未实测** |
| Win 7/8.1、32 位、Server Core | **不支持** |
| Linux / macOS | **不支持** |

能力：文本 ✅ · 图片 ✅（有 MD5 缓存前提）· @ ✅ · 表情 ✅ ·
合并转发 ✅（`get_forward_msg`）· 群/成员列表 ✅ · 历史消息 ✅ ·
媒体代理 ✅ · 文件/语音发送 ❌。

`message` 支持三种写法：纯字符串、CQ 码字符串、OneBot v11 消息段数组
—— 见 [docs/engine-api.md](docs/engine-api.md)。

## 安装

```powershell
git clone https://github.com/<you>/whalebridge.git
cd whalebridge
.\scripts\install.ps1 -QQ "D:\QQ\QQ.exe" -Port 3902
.\scripts\start.ps1
```

`install.ps1` 自己找 QQ、自己认账号目录、写 `config.json`、生成每机一份的 WebSocket 令牌，
并注册看门狗计划任务。

然后把机器人指到 `http://127.0.0.1:3902`（或 `ws://127.0.0.1:3902/`）。

> 顺序很重要：QQ 必须**挂起**启动 → 注入 → 恢复。`start.ps1` 三步都做了。
> 不要手动双击 QQ —— 那样它正常启动、不带引擎，然后你会疑惑 `/health` 为什么不通。

## 编译注入器

需要 MSVC（任意较新的 Build Tools）。没有 Windows SDK 也行：`src/injector/win32min.h`
声明了需要的约 30 个 kernel32 函数，不需要 `<windows.h>`：

```bat
cl /nologo /LD /O1 /GS- /wd4819 /Fe:payload.dll src\injector\payload.c src\injector\crt-stub.c ^
   /link /NODEFAULTLIB /ENTRY:DllMain /SUBSYSTEM:WINDOWS kernel32.lib
```

**构建目录必须是纯 ASCII**：`.bat` 里的中文路径会被代码页吃掉，报 `C1083`。

## 改的是什么

`QQNT.dll` 把 Node 标准库以明文 JS 形式内嵌。`internal/modules/cjs/loader` 里有一段块注释，
后面紧跟一个加载器函数：

```js
/** Internal method to add tracing capabilities for Module._load. ... */
function wrapModuleLoad(request, parent, isMain) {
```

我们把这段注释（**只在内存里**，绝不落盘）替换成：

```js
;process.nextTick(function(){try{Module._load(process.env.WB_JS||"C:/wb.js")}catch(e){}})
```

`process.nextTick` 不能省：注释被解析的那一刻 `Module._load` 还不存在，同步调用会抛
`TypeError: Module._load is not a function`。

退出 QQ 补丁就没了，磁盘上什么都没变 —— 这正是关键，因为
`resources\app\application.json` 给 `application.asar`、`wrapper.node`、`major.node`、
`package.json` 各带了 344 字节签名，改磁盘过不了验签。

## 锚点策略（v2.1）

| 步骤 | 日志 | 耗时 |
|---|---|---|
| 已知 RVA `0xb869804` | `PATCHED FAST` | 毫秒 |
| 该 RVA ±4 MB | `PATCHED WINDOW` | ~100 ms |
| 全镜像（按 PE `SizeOfImage`） | `PATCHED SCAN` | 秒级 |
| 都没命中 | `NO ANCHOR` | — |

**只有**注释后面紧跟下列标记之一时才动手：

```
function wrapModuleLoad(request, parent, isMain)
Module._load = function(request, parent, isMain)
function Module._load(request, parent, isMain)
```

这个约束是有来历的：早先的版本"看到注释就改"，日志写着 patched，JS 却从没跑起来。
另外只靠全镜像扫描会**输给 Node 的启动竞态** —— 补丁落地时，loader 早已用旧内容编译完。
所以快路径必须留着。

## 图片唯一的硬前提

图片必须已经按真实 MD5 存在于 QQ 自己的缓存：

```
<账号数据目录>\nt_qq\nt_data\Pic\<yyyy-mm>\Ori\<MD5-大写>.<ext>
```

并且 `picElement.sourcePath` 指向它。内核会重算哈希，名字不对就
`fileErrCode:"2006003"` + `totalSize:"0"`。成功的样子是
`traserStatus:4`、`fileErrCode:"0"`、`totalSize` 等于真实字节数。

带图的消息经常**根本不回包**（上传是异步的）。引擎把"带图 + 超时"也算成功，免得重复发。

## 排障

三层判据，按顺序，不要猜：

```
1. 内核有数据吗？    GET /rpc  {"cmd":"nodeIKernelMsgService/getMsgsIncludeSelf", ...}
                     → msgSeq 在涨吗？
2. 主进程转发了吗？  GET /debug-send   → `cnt` 在涨吗？
3. 引擎记录了吗？    GET /messages      → 有消息吗？
```

完整路由表在 [docs/engine-api.md](docs/engine-api.md)。

### 三条用血换来的规矩

1. **永远不要碰 `ipcMain._events`。** 包一层可能把 QQ 的 native handler 挤掉，之后内核完全
   不回包，消息是真的发不出去。
2. **运行期永远不要 `webContents.reload()`。** 渲染进程一重载，客户端就再也不重新订阅
   `onRecvActiveMsg`，收消息会一直死到重启 QQ。
3. **热重载只用于无状态的 HTTP 路由。** 碰 send 包装、tap、推送订阅的改动，必须整机重启。

## 安全

- **只改内存**，磁盘上的客户端逐字节不变。
- 通过客户端自己的 IPC 跟内核对话，没有伪造协议。
- `:3902` 与 `:3100` 绑回环；WebSocket 有一份每机独立的令牌。
- **它的权限等于那个 QQ 号的权限。** 谁能跟它说话，要白名单管住。
- 注入并非腾讯服务条款明确允许的行为。测试期间没遇到封号，但这不是保证。

## 许可

MIT，见 [LICENSE](LICENSE)。与腾讯无关。

## 致谢

- [qq-bridge](https://github.com/Derpyu520/qq-bridge) —— 人格 / 记忆 / 工具层
- [SnowLuma](https://github.com/SnowLuma/SnowLuma) —— 早期 OneBot 传输，现已可选
- [NapCat](https://github.com/NapNeko/NapCatQQ) —— `CreateFileW` 改道的先例

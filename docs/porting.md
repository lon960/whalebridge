# 怎么移植到别的 QQ 版本

注入器的目标是"在别的 9.9.x 上也能自己找到位置"。它有三层容错，但终归要有一个
**可识别的锚点**。这份文档说清：能容忍什么、不能容忍什么、坏了自己怎么补。

---

## 一、先看日志，别猜

注入结果写在 `%TEMP%\whalejs9.log`（安装包里是 `%LOCALAPPDATA%\WhaleBridge\...`，取决于
`payload.c` 里的 `LOGPATH`）。

```
PATCHED FAST   at=... len=0x81      最快路径命中，说明 RVA 和注释都没变
PATCHED WINDOW at=... len=0x81      在已知 RVA ±4MB 内找到，RVA 变了但结构没变
PATCHED SCAN   at=... len=0x81      全镜像扫到，可能要盯一下 boot.log
NO ANCHOR                           三条标记一条都没匹配上 —— 这个版本没适配
NO QQNT.dll                         1200 次轮询（约 3.6 秒）内模块没加载，通常是被杀软拦了
```

`PATCHED SCAN` 是有风险的：扫 214 MB 要几秒，可能**输给 Node 的启动竞态**——补丁写进去了，
但 Node 早就用旧内容编译完了 loader。判据是 `js\boot.log` 有没有内容、`/health` 通不通。

---

## 二、能容忍 / 不能容忍

| 变化 | 能否自动容忍 | 说明 |
|---|---|---|
| `QQNT.dll` 的 RVA 偏移变了 | ✅ | 窗口扫描 + 全镜像扫描兜住 |
| 注释文案改了 / 长度变了 | ✅ | 长度是运行时量的，只要求载荷放得下 |
| 注释被删掉了 | ✅ | 只要还跟着一个 loader 标记，标记前面有空白也行 |
| Node 把 `wrapModuleLoad` 改名 | ❌ | 要在 `MARKERS[]` 里加一行，重新编译 |
| QQ 不再内嵌 Node 源码（改预编译快照） | ❌ | 没有文本可改，只能换注入点 |
| 换成 Electron 之外的外壳 / 加壳 | ❌ | 同上 |
| 32 位 QQ | ❌ | 整个工具链都是 x64 |

---

## 三、手工找锚点（新版本来了怎么定位）

在**离线**状态下就能做，不用起 QQ。用 python 在 `QQNT.dll` 里搜：

```python
data = open(r'D:\QQ\versions\<new-build>\QQNT.dll', 'rb').read()
for pat in [b'function wrapModuleLoad(',
            b'Module._load = function(',
            b'function Module._load(']:
    i = data.find(pat)
    print(pat, '->', hex(i) if i >= 0 else 'MISSING')
```

命中后往前看有没有 `*/`，那就是可改的注释槽位。要确认"注释紧跟标记"这个结构还在：

```python
i = data.find(b'function wrapModuleLoad(')
print(data[i-200:i].decode('utf-8', 'replace'))   # 看 i 前面 200 字节长什么样
```

然后算出 RVA（`file_offset + (VA_of_section - file_offset_of_section)`，`.rdata` 里通常
是 `+0x1000` 的差）写进 `payload.c` 的 `KNOWN_RVA`——**这一步纯粹是加速**，不写也能靠扫描
起来，只是慢。

---

## 四、加一条新标记

`src/injector/payload.c`：

```c
static const char* MARKERS[] = {
    "function wrapModuleLoad(request, parent, isMain)",
    "Module._load = function(request, parent, isMain)",
    "function Module._load(request, parent, isMain)",
    /* 新版本这里加一行，越靠前越优先 */
};
```

要求：

1. **足够长**，至少 20 个字符，否则全镜像扫描会撞到一堆巧合
2. **是注释之后紧跟的那个 token**，不是随便哪个函数名
3. 只写标记本身，不含前后的空白或换行（匹配是从标记第一个字符开始的）

改完重新编译，用**打偏 RVA 的变体**验证扫描路径真的能工作：

```c
#define KNOWN_RVA 0x00000001u   /* 故意指到非法地址，强制走扫描 */
```

如果这种变体也能 `PATCHED WINDOW` / `PATCHED SCAN` 起来，说明新标记是有效的。
**只测快路径是不够的**——快路径会掩盖扫描逻辑的 bug。

---

## 五、编译纪律（踩过的坑）

- **构建目录必须是纯 ASCII**。`.bat` 里的中文路径会被代码页吃掉，报 `C1083: 无法打开包括文件`。
  用 `C:\Windows\Temp\whalebuild\` 这种路径。
- **没有 Windows SDK 也能编**：`win32min.h` 声明了需要的 kernel32 函数，
  `k32extra.def` 给 `lib.exe` 生成导入库。新增 API 时要两边都加：
  ```def
  LIBRARY kernel32.dll
  EXPORTS
  GetCurrentThread
  SetThreadPriority
  SetFilePointer
  ```
  然后 `lib /nologo /def:k32extra.def /out:k32extra.lib /machine:x64`。
- **`/NODEFAULTLIB` 要自带 memset/memcpy**：编译器会为结构体拷贝和栈探测插入调用，
  没有 CRT 就 `LNK2019`。`crt-stub.c` 里给了实现（`__chkstk` 是空实现，所以**不要在大栈帧里
  放缓冲区**，全部用 static）。
- **别在 `DllMain` 里做文件 I/O**：会把 QQ 卡死。起线程，在 `worker` 里干活。
- **线程要给 `TIME_CRITICAL`**：`SetThreadPriority(GetCurrentThread(), 15)`，
  否则抢不过 Node 的启动。
- **同一 DLL 二次 `LoadLibraryW` 不会重跑 `DllMain`**：改了代码要换文件名才能重测。

---

## 六、除错检查表

| 症状 | 先看 | 常见原因 |
|---|---|---|
| `/health` 打不开 | `whalejs9.log` | `NO ANCHOR` / 注入 rc≠0 / 端口冲突 |
| 日志有 `PATCHED` 但 `boot.log` 空 | `payload.c` 的 `PAYLOAD` | 载荷写错了（语法错），或补丁落在已经编译过的副本上 |
| QQ 直接消失 | 换个中性载荷（只有一个空格）对照 | 中性也死 = 锚点/时机问题；只有带载荷死 = 载荷问题 |
| 能收不能发 | `/debug-send` 的 `cnt` | native handler 被挤掉了，重启 QQ |
| 私聊收不到 | `/debug-send` + `/messages` | 只挂了 `onRecvActiveMsg`，缺 recentContact 分支 |

**中性载荷对照**是这套东西最有用的一个实验：把 `PAYLOAD` 改成 `" "`，只做"删注释"这个动作。
它能一次性把"补丁机制坏了"和"我的 JS 写坏了"分开。

# WhaleBridge

**Let a real QQ client run your bot — by borrowing its own session, not by re-implementing the protocol.**

[English](README.md) | [中文](README.zh.md)

---

## What this is

Most QQ bot stacks (NapCat, Lagrange, go-cqhttp) re-implement the QQ protocol: their own
handshake, their own encryption, their own SSO packets. That means chasing ticket formats,
fighting risk control, and a nonzero ban surface.

WhaleBridge goes the other way:

```
classic bots:  your program --(forged protocol packets)--> QQ servers
WhaleBridge:   your program --(injected into QQ.exe)--> QQ sends it itself
```

A ~6 KB DLL patches **one comment block** inside the Node source embedded in `QQNT.dll`.
That makes the real client load our engine, which speaks to the QQ kernel over the same
internal RPC the official UI uses. From there it exposes a normal **OneBot v11** service
(HTTP + WebSocket), so anything that already talks to OneBot just works.

Because the packets are produced by the genuine client, there is no fingerprint to fake
and no ticket to steal. The tradeoff is the one you'd expect: **it is tied to the QQ build.**

## Architecture

```
┌──────────┐   OneBot v11   ┌───────────────┐   HTTP/WS   ┌────────────┐   HTTP   ┌────────┐
│ QQ 9.9.x │ <────────────> │ engine.cjs    │ <─────────> │ qq-bridge  │ <──────> │ any    │
│ (client) │  :3902         │ (inside QQ)   │             │ :3100      │          │ agent  │
└──────────┘                └───────────────┘             └────────────┘          └────────┘
     ↑                             ↑
 payload.c (DLL)            OneBot v11 adapter
```

| Piece | Runs where | Job |
|---|---|---|
| `src/injector/` | C, ~250 lines, no SDK needed | Get our JS into the client at boot |
| `src/engine/engine.cjs` | **inside** the QQ process | ntApi RPC ⇄ OneBot v11 |
| `qq-bridge` | separate Node process | Persona, memory, tools, console ([own repo](https://github.com/Derpyu520/qq-bridge)) |

The engine is deliberately **dependency-free** (only `fs` / `http` / `path` / `electron`),
because it runs in a host process whose module loader we must not disturb.

## Status

| | |
|---|---|
| Verified on | QQ **9.9.37-54395**, Windows 11 x64 (build 26200) |
| Other 9.9.x builds | *expected* to work via the marker anchor — **untested** |
| Windows 10 x64 1809+ | should work (Node 24 baseline) — **untested** |
| Win 7/8.1, 32-bit, Server Core | **not supported** |
| Linux / macOS | **not supported** |

Capability: text ✅ · image ✅ (with an MD5-cache prerequisite) · @ ✅ · face ✅ ·
merged chat records ✅ (`get_forward_msg`) · group/member lists ✅ · history ✅ ·
media proxy ✅ · file/voice send ❌.

`message` accepts a plain string, a CQ-code string, or a OneBot v11 segment array —
see [docs/engine-api.md](docs/engine-api.md).

## Install

```powershell
git clone https://github.com/<you>/whalebridge.git
cd whalebridge
.\scripts\install.ps1 -QQ "D:\QQ\QQ.exe" -Port 3902
.\scripts\start.ps1
```

`install.ps1` finds QQ and your account directory itself, writes `config.json`, generates a
per-machine WebSocket token, and registers the watchdog task.

Then point your bot at `http://127.0.0.1:3902` (or `ws://127.0.0.1:3902/`).

> The injector and watchdog care about order: QQ must be started **suspended**, injected, then
> resumed. `start.ps1` does all three. Do not just launch QQ by hand — it will start normally
> with no engine, and you'll wonder why `/health` is dead.

## Build the injector

Needs MSVC (any recent Build Tools) **plus** the Windows SDK. No SDK?

```bat
:: the shipped binaries were built exactly like this
cl /nologo /LD /O1 /GS- /wd4819 /Fe:payload.dll src\injector\payload.c src\injector\crt-stub.c ^
   /link /NODEFAULTLIB /ENTRY:DllMain /SUBSYSTEM:WINDOWS kernel32.lib
cl /nologo /O1 /GS- /wd4819 /Fe:wbinj.exe src\injector\wbinj.c src\injector\crt-stub.c ^
   /link /NODEFAULTLIB /ENTRY:wbinj_entry /SUBSYSTEM:CONSOLE kernel32.lib
```

`src/injector/win32min.h` declares the ~30 kernel32 calls we need, so `<windows.h>` is not
required. Build in an **ASCII-only path** — non-ASCII directory names get mangled by the
code-page in `.bat` files and produce `C1083`.

## What gets patched

`QQNT.dll` embeds the Node standard library as plain JS text. Inside
`internal/modules/cjs/loader` there is a block comment immediately followed by a loader
function:

```js
/** Internal method to add tracing capabilities for Module._load. ... */
function wrapModuleLoad(request, parent, isMain) {
```

We replace that comment (in memory, never on disk) with:

```js
;process.nextTick(function(){try{Module._load(process.env.WB_JS||"C:/wb.js")}catch(e){}})
```

`process.nextTick` is not optional: at the moment the comment is parsed, `Module._load`
does not exist yet. Calling it synchronously throws
`TypeError: Module._load is not a function`.

Existing windows are untouched; kill QQ and the patch is gone. Nothing on disk changes —
which is the whole point, since `resources\app\application.json` carries 344-byte signatures
for `application.asar`, `wrapper.node`, `major.node` and `package.json`.

## Anchor strategy (v2.1)

| Step | Log line | Cost |
|---|---|---|
| Known RVA `0xb869804` | `PATCHED FAST` | ms |
| ±4 MB around that RVA | `PATCHED WINDOW` | ~100 ms |
| Whole image, PE `SizeOfImage` | `PATCHED SCAN` | seconds |
| Nothing matched | `NO ANCHOR` | — |

A patch is applied **only** when the comment is immediately followed by one of:

```
function wrapModuleLoad(request, parent, isMain)
Module._load = function(request, parent, isMain)
function Module._load(request, parent, isMain)
```

That guard exists because an earlier version happily rewrote *any* comment block: the log
said "patched" and the JS never ran. Full-image scanning alone also loses the race against
Node's boot — by the time the patch lands, the loader has already been compiled from an
earlier copy. Keep the fast path.

## The one hard prerequisite for images

A picture must already exist in QQ's own cache under its real MD5:

```
<account data dir>\nt_qq\nt_data\Pic\<yyyy-mm>\Ori\<MD5-UPPER>.<ext>
```

and `picElement.sourcePath` must point at it. The kernel recomputes the hash, so a
misnamed file fails with `fileErrCode:"2006003"` and `totalSize:"0"`. Success looks like
`traserStatus:4`, `fileErrCode:"0"`, and `totalSize` equal to the real byte count.

Image sends often do not reply at all (upload is asynchronous). The engine treats
"has image + timeout" as success so it does not send twice.

## Debugging

Three layers, in order — do not guess:

```
1. kernel has data?      GET /rpc  {"cmd":"nodeIKernelMsgService/getMsgsIncludeSelf", ...}
                          → is msgSeq advancing?
2. main process relays?   GET /debug-send   → is `cnt` growing?
3. engine recorded?       GET /messages      → any messages?
```

Full route list is in [docs/engine-api.md](docs/engine-api.md).

### Three rules that came from breaking things

1. **Never touch `ipcMain._events`.** Wrapping it can evict QQ's native handler; after that
   the kernel stops replying entirely and messages genuinely fail to send.
2. **Never `webContents.reload()` at runtime.** Once a renderer reloads, the client never
   re-subscribes to `onRecvActiveMsg`, and receive dies until QQ restarts.
3. **Hot-reload is only for stateless HTTP handlers.** Anything touching the send wrapper,
   the tap, or the push subscription needs a full QQ restart.

## Security

- Modifies **memory only**; the on-disk client is bit-identical.
- Talks to the kernel through the client's own IPC — no forged protocol.
- `:3902` and `:3100` bind to loopback; the WebSocket has a per-machine token.
- **Its power equals the QQ account's power.** Whitelist who may talk to it.
- Injection is not something Tencent's ToS explicitly permits. No ban observed in testing,
  but that is not a guarantee.

## License

MIT — see [LICENSE](LICENSE). Not affiliated with Tencent.

## Credits

- [qq-bridge](https://github.com/Derpyu520/qq-bridge) — the persona/memory/tooling layer
- [SnowLuma](https://github.com/SnowLuma/SnowLuma) — earlier OneBot transport, now optional
- [NapCat](https://github.com/NapNeko/NapCatQQ) — prior art for `CreateFileW` redirection

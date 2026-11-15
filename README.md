# WhaleBridge

**A brand-new way to connect a QQ bot.**

> Instead of re-implementing the QQ protocol, WhaleBridge injects into the *real* QQ client
> and borrows the session it already has. OneBot v11 in, real client packets out.


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

## Limitations

Read this before you plan around it.

**Tied to the QQ build.**
- Verified on QQ **9.9.37-54395** only. Other 9.9.x builds *should* work through the marker anchor, but none has been tested.
- The injector needs the Node standard library to still be embedded as **plain JS text** inside `QQNT.dll`. If a build ships a precompiled snapshot, or renames `wrapModuleLoad`, the log says `NO ANCHOR` and the only fix is re-porting (see [docs/porting.md](docs/porting.md)).
- A QQ update can break this overnight. Pin the version, or accept the maintenance.

**Platform.**
- Windows x64 only. Windows 11 verified; Windows 10 1809+ expected (Node 24 baseline).
- Win 7/8.1, 32-bit, Server Core, Linux, macOS: **not supported**. ARM64: untested.

**Startup and lifecycle.**
- QQ must be started **suspended -> injected -> resumed**. Launch it by hand and you get a normal client with no engine, and `/health` will never answer.
- Writing `C:\wb.js` needs **administrator** rights. `install.ps1` checks this up front.
- The engine lives inside that one QQ process. Restart QQ, log out, or let it crash, and the engine is gone - run `start.ps1` again.
- One QQ account per process. Multiple accounts means multiple clients (untested).

**Sending.**
- **Images require the file to already be in QQ's own cache**, named by its real MD5:
  `<data dir>\nt_qq\nt_data\Pic\<yyyy-mm>\Ori\<MD5-UPPER>.<ext>`. The kernel recomputes the hash; a misnamed file fails with `fileErrCode 2006003`. You cannot hand it an arbitrary local path.
- Image sends often produce **no RPC reply** at all (upload is asynchronous). The engine treats a timeout as success, so you may not receive a `message_id`.
- **Not implemented:** file, voice/record, video, and most non-message actions (`set_group_*`, group admin, friend requests, reactions). This is a useful subset of OneBot v11, not the whole spec.
- Merged chat records: **reading** is implemented (`get_forward_msg`), but it has never been verified against a real forwarded record - the test account had no sample to try.
- Private messages are addressed by `uid`, not by QQ number. The engine keeps a `uin -> uid` map (`js/uin-uid.json`) learned from the messages it receives, so a QQ number works **once that person has sent the bot a message**. Until then the call returns `retcode 100` with `cannot resolve ... to a uid` rather than sending to a nonexistent peer.

**Things that will break it.**
- Don't touch `ipcMain._events`. Replacing the client's own handler destroys its reply channel and every send starts timing out.
- Don't reload the renderer at runtime. The client never re-subscribes to message push, and inbound messages stop silently.
- Hot-reload is safe only for stateless HTTP routes. Anything on the send/receive path needs a full QQ restart.

**Scope.**
- This repo is the transport only: injector + engine. Persona, memory, tools and the console live in [qq-bridge](https://github.com/Derpyu520/qq-bridge), a separate project.
- `:3902` and `:3100` bind to loopback. **The engine's power equals the QQ account's power** - whitelist who can reach it.

**Legal.**
- Injection is not something Tencent's ToS explicitly permits. No ban was observed during testing; that is not a guarantee.

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

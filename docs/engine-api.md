# 引擎 HTTP / WebSocket 接口

基址：`http://127.0.0.1:<port>`（默认 `3902`），WebSocket 同端口。

所有 POST 路由接受 `Content-Type: application/json`。返回统一为
`{"ok":true,...}` 或 `{"ok":false,"error":"..."}`；OneBot 动作返回 `{"status":"ok","retcode":0,"data":{...}}`。

---

## 只读 / 运维

| 路由 | 方法 | 说明 |
|---|---|---|
| `/health` | GET | `{ok, service, pid, online, win, events, groups, self:{user_id,nickname}}` |
| `/ws-status` | GET | `{ok, clients, gen}` — `gen` 是引擎代际号，每次热重载 +1 |
| `/events` | GET | 最近收到的原始事件（内存环形缓冲） |
| `/messages` | GET | 已解析成 OneBot 格式的消息列表 |
| `/cmdlist` | GET | 见到过的 `cmdName` 清单（诊断用） |
| `/media?path=` | GET | 读 QQ 缓存里的图片/语音，**只允许数据目录与包内 `media-tmp/`** |

## OneBot v11 动作

HTTP 上走 `POST /<action>`，WebSocket 上直接发 `{"action":"...","params":{...},"echo":"..."}`。

| action | params |
|---|---|
| `send_group_msg` | `{group_id, message}` |
| `send_private_msg` | `{user_id, message}` |
| `send_msg` | `{message_type:'group'\|'private', group_id?, user_id?, message}` |
| `get_login_info` | — |
| `get_status` | — |
| `get_version_info` | — |
| `get_group_list` | — |
| `get_group_member_list` | `{group_id}` |
| `get_group_info` | `{group_id}` |
| `get_friend_list` | — |
| `get_stranger_info` | `{user_id}` |
| `get_msg` | `{message_id}` |
| `get_recent_messages` | `{message_type, group_id?, user_id?, count}` |
| `get_group_msg_history` | `{group_id, count}` |
| `get_friend_msg_history` | `{user_id, count}` |
| `get_forward_msg` | `{id, group_id?\|user_id?}` — 合并转发的内容 |
| `can_send_image` / `can_send_record` | — |
| `get_cookies` | — |

### 消息段

`message` 接受三种写法，都等价：

```jsonc
// 1. 纯字符串
"hello"

// 2. CQ 码字符串（会被解析成元素，不会当纯文本发出去）
"hi [CQ:face,id=344] [CQ:at,qq=10001] [CQ:image,file=C:\\a.png]"

// 3. 消息段数组（OneBot v11 标准）
[{ "type": "text",  "data": { "text": "hi" } },
 { "type": "at",    "data": { "qq": "10001" } },
 { "type": "face",  "data": { "id": "344" } },
 { "type": "image", "data": { "file": "C:\\path\\a.png" } }]
```

支持的段类型：`text` / `at` / `face` / `image`。字符串里的 CQ 实体
（`&#44;` `&#91;` `&#93;` `&amp;`）会被反转义。

请求体既可以是 `application/json`，也可以是
`application/x-www-form-urlencoded`（PowerShell 5.1 的
`Invoke-WebRequest -Body <hashtable>` 会发成后者）。

`image` 的 `file` 可以是本地绝对路径。引擎会自己算 MD5、复制到
`<数据目录>\nt_qq\nt_data\Pic\<yyyy-mm>\Ori\<MD5-UPPER>.<ext>`，再以
`sourcePath` 引用它 —— 这一步不能省，见 README「The one hard prerequisite for images」。

### 合并转发（forward）

收到合并转发的聊天记录时，消息段是：

```json
{ "type": "forward", "data": { "id": "<resId>", "summary": "[聊天记录]" } }
```

内层消息要用 `get_forward_msg` 再取一次：

```json
POST /get_forward_msg
{"id": "<resId>", "group_id": "1132178767"}

-> {"status":"ok","retcode":0,"data":{"messages":[ <OneBot 消息对象> ]}}
```

底层是 `nodeIKernelMsgService/getMultiMsg`，它断言需要 3 个参数
（`needs 3 arguments`），但槽位顺序没有文档；引擎会依次试
`[peer, id, id]` / `[peer, '0', id]` / `[id, peer, 0]`，
哪个返回 `msgList` 就用哪个。都取不到时返回 `retcode 1404`。

## 直通 / 调试

| 路由 | 方法 | 说明 |
|---|---|---|
| `/rpc` | POST | `{cmd, payload, eventName}` 直调任意 ntApi。`cmd` 形如 `nodeIKernelMsgService/sendMsg` |
| `/eval` | POST | `{code, wc}` 在渲染进程执行（`executeJavaScript(code, true)` 会 await Promise） |
| `/main` | POST | `{code}` 在引擎所在（QQ 主进程）上下文执行 `new Function('d','require',code)`；**不能写 `await`**，异步用 `.then()` |
| `/log` | GET | 读 `engine.log` 尾部 |

诊断专用（正常使用不需要）：

| 路由 | 说明 |
|---|---|
| `/debug-wins` | 列出所有 BrowserWindow：id / URL / webContentId |
| `/debug-dom` | 某个窗口的 `document.body.innerText` |
| `/debug-send` | `{gen, mine, cb, cnt, wins:[{id,url,wrapped,sendName}], recent}` — **判断"收包为什么断了"的第一现场** |
| `/debug-ipc` | `ipcMain` 各通道的监听器数量与类型 |
| `/debug-members` `/debug-profiles` `/debug-recent` | 成员/资料/会话列表的原始回包 |
| `/ws-test` | 合成一条假消息广播给所有 WS 客户端：`?message_type=group&group_id=..&user_id=..&text=..` |
| `/dragimg` | CDP 拖拽图片进聊天窗口（实验性，可能挂住） |

## 常见 `cmdName`（`/rpc` 直调时用）

| cmd | payload 形状 | 说明 |
|---|---|---|
| `nodeIKernelMsgService/sendMsg` | `[{peer,msgElements,msgAttributeInfos}, null]` | 双槽位，第二个必须是 `null` |
| `nodeIKernelMsgService/getMsgsIncludeSelf` | `[{peer,msgId:'0',cnt:N,queryOrder:true}]` | `cnt` 别超过 8，大回包会回 `null` |
| `nodeIKernelGroupService/getGroupList` | `[{}]` | 数据其实走 `onGroupListUpdate` 推送 |
| `nodeIKernelGroupService/getAllMemberList` | `[{groupCode,forceUpdate:false}]` | 回 `result.ids[{uid}]` |
| `nodeIKernelProfileService/getUserSimpleInfo` | `[{uids:[...]}]` | 数据走 `onProfileSimpleChanged` 推送 |
| `nodeIKernelBuddyService/getBuddyList` | `[{force:false,sortField:0}]` | 同上，数据走推送 |
| `nodeIKernelAvatarService/getMembersAvatarPath` | `[{uids:[...],clarity:0}]` | 回真实路径 |

## 事件推送

WS 客户端会收到两类：

```jsonc
// 1. 元事件
{"post_type":"meta_event","meta_event_type":"lifecycle","self_id":123}
{"post_type":"meta_event","meta_event_type":"heartbeat","self_id":123,"interval":30000}

// 2. 消息
{"post_type":"message","message_type":"group","group_id":123,"user_id":456,
 "message_id":"7707932169488330589","message_seq":5925,
 "message":[{"type":"text","data":{"text":"hi"}}],"raw_message":"hi",
 "sender":{"user_id":456,"nickname":"...","card":"..."}}
```

`message_id` 一律是**字符串**：QQ 的 `msgId` 是 19 位数字，用 `Number()` 会丢精度并撞 id。

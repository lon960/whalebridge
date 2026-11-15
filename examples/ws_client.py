#!/usr/bin/env python3
"""
Minimal OneBot v11 client for WhaleBridge -- standard library only.

The engine speaks plain RFC6455, so you do not need `websockets` or `aiohttp`
to talk to it. This file is both an example and a smoke test: if it prints
your group list and sends a message, the whole chain works.

    python ws_client.py --token <token> --group 123456789 --text "hello"

Token is optional (only enforced if js/ws_token.txt exists).
"""
import argparse
import base64
import json
import os
import socket
import struct
import sys
import time
import uuid

GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"


def connect(host, port, path="/", token=None, timeout=10):
    key = base64.b64encode(os.urandom(16)).decode()
    sock = socket.create_connection((host, port), timeout=timeout)
    req = [
        f"GET {path} HTTP/1.1",
        f"Host: {host}:{port}",
        "Upgrade: websocket",
        "Connection: Upgrade",
        f"Sec-WebSocket-Key: {key}",
        "Sec-WebSocket-Version: 13",
    ]
    if token:
        req.append(f"Authorization: Bearer {token}")
    sock.sendall(("\r\n".join(req) + "\r\n\r\n").encode())

    buf = b""
    while b"\r\n\r\n" not in buf:
        chunk = sock.recv(4096)
        if not chunk:
            raise RuntimeError("server closed during handshake")
        buf += chunk
    head, rest = buf.split(b"\r\n\r\n", 1)
    status = head.split(b"\r\n")[0].decode()
    if "101" not in status:
        raise RuntimeError(f"handshake failed: {status}")
    return sock, rest


def frame(payload: bytes, opcode=0x1):
    mask = os.urandom(4)
    n = len(payload)
    if n < 126:
        head = struct.pack("!BB", 0x80 | opcode, 0x80 | n)
    elif n < 65536:
        head = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, n)
    else:
        head = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, n)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(payload))
    return head + mask + masked


class Conn:
    def __init__(self, sock, rest=b""):
        self.sock = sock
        self.buf = rest

    def _need(self, n):
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("closed")
            self.buf += chunk

    def recv(self):
        self._need(2)
        b0, b1 = self.buf[0], self.buf[1]
        opcode = b0 & 0x0F
        masked = b1 & 0x80
        ln = b1 & 0x7F
        off = 2
        if ln == 126:
            self._need(4)
            ln = struct.unpack("!H", self.buf[2:4])[0]
            off = 4
        elif ln == 127:
            self._need(10)
            ln = struct.unpack("!Q", self.buf[2:10])[0]
            off = 10
        mask = b""
        if masked:
            self._need(off + 4)
            mask = self.buf[off:off + 4]
            off += 4
        self._need(off + ln)
        data = self.buf[off:off + ln]
        self.buf = self.buf[off + ln:]
        if masked:
            data = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        if opcode == 0x8:
            raise ConnectionError("server closed")
        if opcode == 0x9:
            self.sock.sendall(frame(data, 0x0A))
            return self.recv()
        return data

    def send_json(self, obj):
        self.sock.sendall(frame(json.dumps(obj).encode()))

    def call(self, action, params=None, timeout=15):
        echo = str(uuid.uuid4())
        self.send_json({"action": action, "params": params or {}, "echo": echo})
        deadline = time.time() + timeout
        while time.time() < deadline:
            msg = json.loads(self.recv())
            if msg.get("echo") == echo:
                return msg
        raise TimeoutError(action)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--host", default="127.0.0.1")
    ap.add_argument("--port", type=int, default=3902)
    ap.add_argument("--token", default="")
    ap.add_argument("--group", type=int, default=0)
    ap.add_argument("--text", default="")
    ap.add_argument("--listen", action="store_true")
    args = ap.parse_args()

    sock, rest = connect(args.host, args.port, token=args.token or None)
    c = Conn(sock, rest)
    print("connected")

    print("login  :", c.call("get_login_info")["data"])
    groups = c.call("get_group_list")["data"]
    print("groups :", [g.get("group_name") for g in groups])

    if args.group and args.text:
        r = c.call("send_group_msg", {"group_id": args.group,
                                      "message": [{"type": "text", "data": {"text": args.text}}]})
        print("sent   :", r["data"])

    if args.listen:
        print("listening for events, ctrl-c to stop")
        while True:
            ev = json.loads(c.recv())
            if ev.get("post_type") == "message":
                print(f"[{ev.get('message_type')}] {ev.get('user_id')}: {ev.get('raw_message')}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        sys.exit(0)

#!/usr/bin/env python3
"""按秒采样「安得云荟」整个进程树的内存，用来定位到底是谁吃掉了几个 GB。

为什么需要它：2026-10-28 抓到一次 SIGABRT（glibc `corrupted double-linked list`，
两个 WebKitWebProcess 同时死），而 apport 里的 core 解开是 **4201 MB** —— 说明
**单个 Web 进程就持有 ~4GB**。系统明明有 32GB，不是 OOM，所以必须知道「什么时候涨、
哪个进程涨」，否则只能猜。

用法：
    python3 scripts/linux-mem-watch.py            # 每 2 秒一行，Ctrl-C 停
    python3 scripts/linux-mem-watch.py 1 120      # 每 1 秒，采 120 次

判读：
    * 打开音乐模块（尤其滚动曲目列表）时 `WebKitWebProcess` 的 rss 若持续爬升到 GB 级，
      基本就锁定「列表里的封面被全部解码」这类问题（947 张 × 每张解码后约 4MB ≈ 3.8GB）。
    * `anon` 一路涨 ⇒ JS/WASM 侧真的分配了；`shmem` 涨 ⇒ GPU/共享缓冲（DMA-BUF）。
"""

from __future__ import annotations

import os
import sys
import time

APP_COMM = "andeyunhui"


def proc_stat(pid: str) -> tuple[str, str, str] | None:
    """返回 (comm, state, ppid)；进程消失返回 None。"""
    try:
        with open(f"/proc/{pid}/stat", "rb") as f:
            raw = f.read().decode("utf-8", "replace")
    except OSError:
        return None
    # comm 里可能带空格和括号，按最后一个 ')' 切
    r = raw.rfind(")")
    if r < 0:
        return None
    comm = raw[raw.find("(") + 1 : r]
    rest = raw[r + 2 :].split()
    if len(rest) < 2:
        return None
    return comm, rest[0], rest[1]


def rss_kb(pid: str) -> int:
    try:
        with open(f"/proc/{pid}/status", "r", encoding="utf-8", errors="replace") as f:
            for line in f:
                if line.startswith("VmRSS:"):
                    return int(line.split()[1])
    except OSError:
        pass
    return 0


def all_pids() -> list[str]:
    return [p for p in os.listdir("/proc") if p.isdigit()]


def descendants(root: str) -> list[str]:
    children: dict[str, list[str]] = {}
    for pid in all_pids():
        st = proc_stat(pid)
        if not st:
            continue
        children.setdefault(st[2], []).append(pid)
    out: list[str] = []
    stack = [root]
    while stack:
        cur = stack.pop()
        for ch in children.get(cur, []):
            out.append(ch)
            stack.append(ch)
    return out


def find_app() -> str | None:
    for pid in all_pids():
        st = proc_stat(pid)
        if st and st[0] == APP_COMM:
            return pid
    return None


def scope_mem_mb(root: str) -> int | None:
    """尽力读 cgroup 的 memory.current（app.slice 下的 scope/unit）。"""
    try:
        with open(f"/proc/{root}/cgroup", "r", encoding="utf-8") as f:
            path = f.read().strip().split("::", 1)[-1].lstrip("/")
    except OSError:
        return None
    cur = f"/sys/fs/cgroup/{path}/memory.current"
    try:
        with open(cur, "r", encoding="utf-8") as f:
            return int(f.read().strip()) // (1024 * 1024)
    except OSError:
        return None


def main() -> int:
    interval = float(sys.argv[1]) if len(sys.argv) > 1 else 2.0
    count = int(sys.argv[2]) if len(sys.argv) > 2 else 0

    root = find_app()
    if not root:
        print(f"没找到正在运行的 {APP_COMM}（先启动应用再采样）", file=sys.stderr)
        return 1

    print(f"采样进程树根 pid={root}，间隔 {interval}s，Ctrl-C 结束")
    print(f"{'时间':8} {'cgroup':>8} {'进程':28} {'RSS':>9}")
    i = 0
    try:
        while True:
            i += 1
            scope = scope_mem_mb(root)
            now = time.strftime("%H:%M:%S")
            if scope is not None:
                print(f"{now} {scope:>6}MB")
            rows = []
            for pid in [root] + descendants(root):
                st = proc_stat(pid)
                if not st:
                    continue
                rows.append((rss_kb(pid), pid, st[0]))
            rows.sort(reverse=True)
            for kb, pid, comm in rows:
                if kb < 20 * 1024:  # 20MB 以下不打印，避免刷屏
                    continue
                print(f"{'':8} {'':>8} {comm[:24]:24}{pid:>6} {kb/1024:>8.0f}MB")
            sys.stdout.flush()
            if count and i >= count:
                break
            time.sleep(interval)
    except KeyboardInterrupt:
        print("\n已停止")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

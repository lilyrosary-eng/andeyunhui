#!/usr/bin/env bash
# 抽取关键事件明细（wevtutil 输出是 GBK，须转码；git-bash 会做路径转换，须关掉）
export MSYS_NO_PATHCONV=1
D=/c/Users/Rosary/Desktop/andeyunhui/shots/perf

q() {  # q <查询> <输出文件>
  wevtutil qe System "/q:$1" /f:text /c:200 /rd:true 2>/dev/null \
    | iconv -f CP936 -t UTF-8 -c 2>/dev/null > "$2"
}

q "*[System[(EventID=41 or EventID=6008)]]" "$D/ev-power.log"
q "*[System[Provider[@Name='volmgr']]]"     "$D/ev-volmgr.log"
q "*[System[Provider[@Name='Microsoft-Windows-Ntfs']]]" "$D/ev-ntfs.log"
echo "已抓取："
wc -l "$D"/ev-*.log | sed 's/^/  /'

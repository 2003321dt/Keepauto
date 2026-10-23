#!/usr/bin/env python3
"""
上游节点文件抓取脚本（GitHub Actions 专用）

不再直连 Telegram，改为直接读取上游仓库已筛选好的节点文件：
  https://raw.githubusercontent.com/yutian81/Keepalive/refs/heads/main/9r-proxy/socks5-otc.txt

上游那份 socks5-otc.txt 本身就是原作者从 TG 频道抓取、并经过连通性测试筛选后的
结果，所以本地不必再登录 TG，也就不需要任何 API 凭据。

流程：
1. 下载节点 txt
2. 正则提取 socks5/http 节点
3. 以 ip:port 去重
4. 输出到 socks5.txt（供 proxy-manager.py 上传 9router）

需要的配置（环境变量）：
  GH_NODE_URLS   节点文件地址，多个用逗号分隔，默认上游 socks5-otc.txt
  GH_TIMEOUT     单次下载超时秒数，默认 25
"""

import os
import re
import sys
import logging

import requests

# ================= 配置区域 =================
DEFAULT_URL = (
    "https://raw.githubusercontent.com/yutian81/Keepalive/refs/heads/main/"
    "9r-proxy/socks5-otc.txt"
)
GH_NODE_URLS = [
    u.strip()
    for u in (os.getenv("GH_NODE_URLS") or DEFAULT_URL).split(",")
    if u.strip()
]
GH_TIMEOUT = int(os.getenv("GH_TIMEOUT") or "25")
OUTPUT_FILE = "socks5.txt"
# ============================================

# 匹配 socks5/http/https 节点 URL（user:pass@ip:port）
# [^\s#@]+ 在 # 前停止 → match.group(0) 即纯净 URL（不含 #标签）
NODE_RE = re.compile(
    r"(socks5|http|https)://[^\s#@]+@(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)"
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("fetch-nodes")


def normalize_url(url: str) -> str:
    """把 github.com/.../blob/... 网页地址转成 raw 直链"""
    if "github.com" in url and "/blob/" in url:
        return url.replace("github.com", "raw.githubusercontent.com").replace("/blob/", "/")
    return url


def extract_nodes(text: str) -> list:
    """从文件文本中提取纯净节点 URL 列表（去重由调用方完成）"""
    return [m.group(0) for m in NODE_RE.finditer(text)]


def fetch_file(session: requests.Session, url: str, seen: dict) -> None:
    """下载单个节点文件，把节点写入 seen（以 ip:port 为 key）"""
    target = normalize_url(url)
    try:
        resp = session.get(target, timeout=GH_TIMEOUT)
    except requests.RequestException as e:
        log.error("下载异常 %s: %s", target, e)
        return

    if resp.status_code != 200:
        log.error("下载失败 HTTP %d: %s", target, resp.status_code)
        return

    text = resp.text
    # 防御：误传网页地址会拿到 HTML
    if text.lstrip()[:15].lower().startswith(("<!doctype", "<html")):
        log.error("返回的是 HTML 而非纯文本，请使用 raw 地址: %s", target)
        return

    before = len(seen)
    for node in extract_nodes(text):
        ip_port = NODE_RE.match(node)
        key = f"{ip_port.group(2)}:{ip_port.group(3)}" if ip_port else node
        seen.setdefault(key, node)

    lines = len([l for l in text.splitlines() if l.strip()])
    log.info("%s 文件 %d 行，新增 %d 个节点", target.rsplit("/", 1)[-1], lines, len(seen) - before)


def main():
    log.info("=" * 48)
    log.info("节点抓取启动（上游节点文件）")
    log.info("数据源: %d 个", len(GH_NODE_URLS))

    session = requests.Session()
    session.headers.update(
        {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}
    )

    seen = {}
    for url in GH_NODE_URLS:
        fetch_file(session, url, seen)

    log.info("提取节点数: %d", len(seen))

    # newline="\n" 固定 LF，避免 Windows 下写出 CRLF 污染仓库
    with open(OUTPUT_FILE, "w", encoding="utf-8", newline="\n") as f:
        for node in seen.values():
            f.write(node + "\n")

    log.info("已写入 %s (%d 个节点)", OUTPUT_FILE, len(seen))
    log.info("=" * 48)
    if not seen:
        sys.exit(1)  # 未抓取到节点，判定为失败


if __name__ == "__main__":
    main()

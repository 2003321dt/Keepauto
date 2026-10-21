#!/usr/bin/env python3
"""
节点抓取脚本（上游节点文件版，无任何 API 凭据）

不再直连 Telegram，改为直接读取上游仓库已筛选好的节点文件：
  https://raw.githubusercontent.com/yutian81/Keepalive/refs/heads/main/9r-proxy/socks5-otc.txt

上游作者的节点本身就是他从 TG 频道抓取并筛选过的，所以这里只做：
  1. 拉取 txt
  2. 正则提取 socks5/http 节点
  3. 以 ip:port 去重
  4. 输出到 socks5.txt（供 proxy-manager.py 上传到 9router）

需要的配置（环境变量）：
  GH_NODE_URLS   节点文件地址列表，逗号分隔（支持 github.com/.../blob/... 自动转 raw）
  FETCH_PLAIN    1 = 同时收录无认证的 ip:port 形式，默认 0
  GH_TIMEOUT     单次请求超时秒数，默认 25
  OUTPUT_FILE    输出文件名，默认 socks5.txt
"""

import os
import re
import sys
import logging
import requests

# ================= 配置区域 =================

DEFAULT_GH_URLS = [
    "https://raw.githubusercontent.com/yutian81/Keepalive/refs/heads/main/9r-proxy/socks5-otc.txt",
]

GH_NODE_URLS = [
    u.strip()
    for u in (os.getenv("GH_NODE_URLS") or ",".join(DEFAULT_GH_URLS)).split(",")
    if u.strip()
]

GH_TIMEOUT = int(os.getenv("GH_TIMEOUT") or "25")
FETCH_PLAIN = os.getenv("FETCH_PLAIN") == "1"
OUTPUT_FILE = os.getenv("OUTPUT_FILE") or "socks5.txt"

# ============================================

# 带认证的节点：socks5://user:pass@ip:port
NODE_RE = re.compile(
    r"(socks5|http|https)://[^\s#@]+@(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)"
)
# 无认证的节点：socks5://ip:port（可选启用）
NODE_PLAIN_RE = re.compile(
    r"(socks5|http|https)://(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d+)"
)

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("fetch-nodes")


def make_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": UA})
    return s


def normalize_url(url: str) -> str:
    """把 github.com/.../blob/... 网页地址转成 raw 直链"""
    if "github.com" in url and "/blob/" in url:
        return url.replace("github.com", "raw.githubusercontent.com").replace("/blob/", "/")
    return url


def node_key(url: str) -> str:
    """以 ip:port 作为去重键"""
    m = NODE_RE.match(url) or NODE_PLAIN_RE.match(url)
    return f"{m.group(2)}:{m.group(3)}" if m else url


def extract_nodes(text: str) -> list:
    nodes = [m.group(0) for m in NODE_RE.finditer(text)]
    if FETCH_PLAIN:
        nodes += [m.group(0) for m in NODE_PLAIN_RE.finditer(text)]
    return nodes


def fetch_file(session: requests.Session, url: str, seen: dict) -> int:
    """抓取单个节点文件，写入 seen，返回本次新增数"""
    target = normalize_url(url)
    try:
        resp = session.get(target, timeout=GH_TIMEOUT)
    except requests.RequestException as e:
        log.error("请求异常 %s: %s", target, e)
        return 0

    if resp.status_code != 200:
        log.error("HTTP %d: %s", resp.status_code, target)
        return 0

    text = resp.text
    # 防御：误传网页地址时会拿到 HTML
    if text.lstrip()[:15].lower().startswith(("<!doctype", "<html")):
        log.error("返回的是 HTML 而非纯文本，请使用 raw 地址: %s", target)
        return 0

    lines = [l for l in text.splitlines() if l.strip()]
    added = 0
    for node in extract_nodes(text):
        key = node_key(node)
        if key not in seen:
            seen[key] = node
            added += 1

    log.info("%s: 文件 %d 行, 当前累计 %d 个唯一节点（本次新增 %d）",
             target.rsplit("/", 1)[-1], len(lines), len(seen), added)
    return added


def main():
    log.info("=" * 52)
    log.info("节点抓取启动（上游节点文件，无 API 凭据）")
    log.info("数据源: %d 个", len(GH_NODE_URLS))
    log.info("模式  : %s", "含无认证节点" if FETCH_PLAIN else "仅含认证节点")

    session = make_session()
    seen = {}
    for url in GH_NODE_URLS:
        log.info("-" * 52)
        fetch_file(session, url, seen)

    log.info("-" * 52)
    log.info("去重后总计: %d 个节点", len(seen))

    if not seen:
        log.error("未取到任何节点，判定为失败")
        sys.exit(1)

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        for node in seen.values():
            f.write(node + "\n")
    log.info("已写入 %s", OUTPUT_FILE)
    log.info("=" * 52)


if __name__ == "__main__":
    main()

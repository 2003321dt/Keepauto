#!/usr/bin/env python3
"""
TG 公开频道 socks5 节点抓取脚本（零凭据版，GitHub Actions 专用）

与 tg-fetch.py 的区别：不使用 Telethon、不需要 TG_API_ID / TG_API_HASH /
TG_SESSION_STR。改为抓取 Telegram 官方公开网页预览 https://t.me/s/<channel>，
通过 ?before=<id> 向前翻页，直到覆盖最近 N 天的消息。

原理：Telegram 的公开频道（public channel）网页预览对未登录用户开放，
只要频道是公开的，任何人用普通 HTTP GET 就能读到全部历史消息，无需 API 凭据。

需要的配置（环境变量）：
  TG_CHANNELS       频道列表，逗号分隔（不带 @），默认 otcfxq
  FETCH_DAYS       抓取最近 N 天，默认 3
  MAX_PAGES        最多翻页数（安全阀），默认 40
  PAGE_DELAY       每页间隔秒数（避免触发限流），默认 2
  FETCH_PLAIN      1 = 同时收录无认证的 ip:port 形式（默认 0）
  OUTPUT_FILE      输出文件名，默认 socks5.txt
"""

import os
import re
import sys
import time
import html
import logging
import requests
from datetime import datetime, timedelta, timezone

# ================= 配置区域 =================
TG_CHANNELS = [
    c.strip().lstrip("@")
    for c in (os.getenv("TG_CHANNELS") or "otcfxq").split(",")
    if c.strip()
]
FETCH_DAYS = int(os.getenv("FETCH_DAYS") or "3")
MAX_PAGES = int(os.getenv("MAX_PAGES") or "40")
PAGE_DELAY = float(os.getenv("PAGE_DELAY") or "2")
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
# 消息块：按 data-post="channel/id" 切分
MSG_SPLIT_RE = re.compile(r'<div[^>]+data-post="([^"/]+)/(\d+)"')
# 消息发布时间
TIME_RE = re.compile(r'<time[^>]+datetime="([^"]+)"')
# 消息正文容器（取到下一个 .js-widget_message 为止）
TEXT_RE = re.compile(
    r'<div class="tgme_widget_message_text[^"]*"[^>]*>(.*?)'
    r'(?:<div class="tgme_widget_message_(?:reply|service)|</div>\s*</div>)',
    re.DOTALL,
)
# 翻页链接：Telegram 在 <link rel="prev" href="/s/<ch>?before=<id>"> 中给出上一页游标
BEFORE_RE = re.compile(r'<link[^>]+rel="prev"[^>]+href="[^"]*?before=(\d+)"')
BEFORE_RE_ALT = re.compile(r'<a[^>]+href="[^"]*?before=(\d+)"')

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    datefmt="%Y-%m-%d %H:%M:%S",
)
log = logging.getLogger("tg-fetch-web")


def make_session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": UA, "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8"})
    return s


def clean_text(fragment: str) -> str:
    """把消息 HTML 片段转为纯文本"""
    t = re.sub(r"<br\s*/?>", "\n", fragment)
    t = re.sub(r"<[^>]+>", "", t)
    return html.unescape(t)


def parse_messages(page_html: str) -> list:
    """从预览页 HTML 解析出 [{msg_id, dt, text}, ...]"""
    # 定位所有消息块起点
    heads = [(m.start(), m.end(), m.group(1), int(m.group(2))) for m in MSG_SPLIT_RE.finditer(page_html)]
    out = []
    for idx, (_s, e, _ch, msg_id) in enumerate(heads):
        end = heads[idx + 1][0] if idx + 1 < len(heads) else len(page_html)
        block = page_html[e:end]

        tm = TIME_RE.search(block)
        dt = None
        if tm:
            try:
                dt = datetime.fromisoformat(tm.group(1).replace("Z", "+00:00"))
                if dt.tzinfo is None:
                    dt = dt.replace(tzinfo=timezone.utc)
            except ValueError:
                dt = None

        tx = TEXT_RE.search(block)
        text = clean_text(tx.group(1)) if tx else clean_text(block)

        out.append({"msg_id": msg_id, "dt": dt, "text": text})
    return out


def next_before(page_html: str, current_min_id: int):
    """从 <link rel="prev"> 取上一页游标；无有效值返回 None

    Telegram 语义：?before=<id> 表示取 id 之前（即不含该条）的消息，
    因此 cur == current_min_id 是合法且必要的翻页条件，不能用严格小于。
    """
    m = BEFORE_RE.search(page_html)
    if m:
        cur = int(m.group(1))
        if cur <= current_min_id:
            return cur
        return None
    cands = [int(b) for b in BEFORE_RE_ALT.findall(page_html)]
    smaller = [b for b in cands if b <= current_min_id]
    return min(smaller) if smaller else None


def extract_nodes(text: str) -> list:
    nodes = [m.group(0) for m in NODE_RE.finditer(text)]
    if FETCH_PLAIN:
        nodes += [m.group(0) for m in NODE_PLAIN_RE.finditer(text)]
    return nodes


def node_key(url: str) -> str:
    m = NODE_RE.match(url) or NODE_PLAIN_RE.match(url)
    if not m:
        return url
    # 带认证的用 group(2,3)，无认证的用 group(2,3) 同样是 ip/port
    return f"{m.group(2)}:{m.group(3)}"


def fetch_channel(session: requests.Session, channel: str, cutoff: datetime, seen: dict) -> int:
    """抓取单个频道所有 cutoff 之后的节点，写入 seen，返回扫描消息数"""
    url = f"https://t.me/s/{channel}"
    before = None
    scanned = 0
    oldest_hit = None

    for page in range(1, MAX_PAGES + 1):
        target = url if before is None else f"{url}?before={before}"
        try:
            resp = session.get(target, timeout=25)
        except requests.RequestException as e:
            log.error("[%s] 第 %d 页请求异常: %s", channel, page, e)
            break

        if resp.status_code != 200:
            log.error("[%s] 第 %d 页返回 HTTP %d", channel, page, resp.status_code)
            break

        page_html = resp.text
        msgs = parse_messages(page_html)
        if not msgs:
            log.warning("[%s] 第 %d 页未解析到消息，停止翻页", channel, page)
            break

        page_new = 0
        page_oldest = None
        stop = False
        # 页面消息按时间倒序（新→旧）
        for m in msgs:
            scanned += 1
            if m["dt"]:
                page_oldest = m["dt"] if page_oldest is None else min(page_oldest, m["dt"])
            if m["dt"] and m["dt"] < cutoff:
                stop = True
                continue
            for node in extract_nodes(m["text"]):
                key = node_key(node)
                if key not in seen:
                    seen[key] = node
                    page_new += 1

        oldest_hit = page_oldest or oldest_hit
        log.info("[%s] 第 %d 页: %d 条消息, 新增节点 %d, 页内最早 %s",
                 channel, page, len(msgs), page_new,
                 page_oldest.strftime("%m-%d %H:%M") if page_oldest else "?")

        if stop:
            log.info("[%s] 已到达时间边界（%d 天前），停止翻页", channel, FETCH_DAYS)
            break

        nb = next_before(page_html, min(m["msg_id"] for m in msgs))
        if nb is None:
            log.info("[%s] 无更多历史分页链接，停止", channel)
            break
        before = nb
        time.sleep(PAGE_DELAY)

    return scanned


def main():
    log.info("=" * 48)
    log.info("TG 公开频道节点抓取启动（免 API 凭据）")
    log.info("目标频道: %s", ", ".join("@" + c for c in TG_CHANNELS))
    log.info("抓取范围: 最近 %d 天，模式: %s", FETCH_DAYS, "含无认证节点" if FETCH_PLAIN else "仅含认证节点")

    cutoff = datetime.now(timezone.utc) - timedelta(days=FETCH_DAYS)
    session = make_session()
    seen = {}
    total = 0

    for ch in TG_CHANNELS:
        log.info("-" * 48)
        total += fetch_channel(session, ch, cutoff, seen)

    log.info("-" * 48)
    log.info("扫描消息总数: %d", total)
    log.info("提取节点数: %d", len(seen))

    if not seen:
        log.error("未抓取到任何节点，判定为失败")
        sys.exit(1)

    with open(OUTPUT_FILE, "w", encoding="utf-8") as f:
        for node in seen.values():
            f.write(node + "\n")
    log.info("已写入 %s", OUTPUT_FILE)
    log.info("=" * 48)


if __name__ == "__main__":
    main()
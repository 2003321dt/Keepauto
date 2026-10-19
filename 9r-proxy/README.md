# 9R-Proxy — OTC 代理同步工具

从 TG 公开频道 [@otcfxq](https://t.me/otcfxq)（OTC分享群）获取 socks5/http 代理节点，同步到 9router 代理池，测试连通性后输出可用节点列表。

## 工作流程

```
tg-fetch-web.py ──► socks5.txt ──► proxy-manager.py ──► socks5-otc.txt
     │                │                │
     │                │                └── 可用节点列表
     │                └── 仅增不减
     └── 抓公开频道（免API 凭据）
```

## 节点获取方式：为什么不需要 Telegram API 凭据

`@otcfxq` 是**公开频道**，Telegram 官方对其提供免登录的网页预览
`https://t.me/s/<channel>`，任何人都能用普通 HTTP GET 读到完整历史消息。

因此默认抓取脚本 `tg-fetch-web.py` **完全不需要** `TG_API_ID` /`TG_API_HASH` /
`TG_SESSION_STR`，只需要 `requests` 一个依赖。它通过 `<link rel="prev">` 逐页向前
翻页，直到覆盖指定天数窗口。

> 仓库中保留的 `tg-fetch.py` 是旧版 Telethon 方案（以用户身份登录），仅在你确实
> 需要读取**非公开**频道时才使用。公开频道场景无需使用。

## 环境变量

| 变量 | 用途 | 必要 | 默认 |
|------|------|------|------|
| `TG_CHANNELS` | 频道列表，逗号分隔（不带 @） | 否 | `otcfxq` |
| `FETCH_DAYS` | 抓取最近 N 天 | 否 | `3` |
| `MAX_PAGES` | 最多翻页数（安全阀） | 否 | `40` |
| `PAGE_DELAY` | 每页间隔秒数，避免限流 | 否 | `2` |
| `FETCH_PLAIN` | `1` = 同时收录无认证的 `ip:port` 节点 | 否 | `0` |
| `R9_BASE_URL` | 9router 首页地址，https:// 开头 | 是 | 内置默认 |
| `R9_PASSWORD` | 9router 登录密码 | 是 | — |
| `GH_TOKEN` | 写回仓库 Token | 是（CI 用） | — |
| `TG_BOT_TOKEN` | TG 通知机器人 Token | 否 | — |
| `TG_CHAT_ID` | TG 通知接收 Chat ID | 否 | — |
| `TEST_CONCURRENCY` | 并行测试并发数 | 否 | `8` |
| `TEST_TIMEOUT` | 单节点测试超时秒数 | 否 | `10` |
| `DEAD_RATIO_LIMIT` | 不通比例阈值，系统性异常保护 | 否 | `0.9` |

> GitHub Actions 中 `TG_CHANNELS` / `FETCH_DAYS` / `MAX_PAGES` / `PAGE_DELAY`
> 读取仓库 **Variables**（非 Secrets），留空即用默认值。

## 安全机制

每次运行都重新登录获取 `auth_token`，不复用 cookie，避免过期 cookie 导致测试全部 401。

测试环节区分三种结果：

- **连通** → 保留并写入 `socks5-otc.txt`
- **不通**（`ok: false` / 超时 / 连接异常）→ 删除
- **系统性异常**（HTTP 401/403/429/5xx）→ 保留不删除

当「不通 + 异常」比例超过 `DEAD_RATIO_LIMIT`（默认 90%）时，判定为系统性异常（鉴权失效 / 服务故障 / 限流），**跳过全部删除操作，不覆盖 `socks5-otc.txt`**，发送告警通知后以非零码退出。

## 本地运行

```bash
# 安装依赖
pip install -r requirements.txt

# 1. 抓取TG 节点（免 API 凭据）
python tg-fetch-web.py

# 可选：多频道 / 更大时间窗口
TG_CHANNELS=otcfxq,otcjlq FETCH_DAYS=7 MAX_PAGES=30 python tg-fetch-web.py

# 2. 同步到 9router
export R9_PASSWORD=xxx
python proxy-manager.py

# 可选：调整并行测试参数
export TEST_CONCURRENCY=16 TEST_TIMEOUT=20
python proxy-manager.py
```

> 若本机设置了 `HTTP_PROXY`/`HTTPS_PROXY` 导致抓取失败，先 `unset` 再运行；
> GitHub Actions 环境无此问题。

## 定时任务

GitHub Actions 每天早上 **北京时间 18:00** 自动执行：
- 抓取 TG 频道最近 3 天的 socks5 节点
- 同步到 9router 代理池（只增不减）
- 测试连通性，删除不通的节点
- 更新 `socks5-otc.txt` 并提交到仓库
- 发送 TG 通知汇总
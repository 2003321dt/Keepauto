# 9R-Proxy — OTC 代理同步工具

从上游仓库已筛选好的节点文件读取 socks5/http 代理节点，同步到 9router 代理池，
测试连通性后输出可用节点列表。

## 工作流程

```
上游节点文件（raw txt）──► socks5.txt ──► proxy-manager.py ──► socks5-otc.txt
                                                              └── 可用节点列表
```

## 节点来源：不需要任何 Telegram 凭据

早期版本用 Telethon 以用户身份登录 TG 频道抓节点，需要 `TG_API_ID` /
`TG_API_HASH` / `TG_SESSION_STR` 三个凭据，而 `TG_SESSION_STR` 会过期、维护成本高。

现在改为**直接读取上游仓库已经筛选好的节点文件**：

```
https://raw.githubusercontent.com/yutian81/Keepalive/refs/heads/main/9r-proxy/socks5-otc.txt
```

上游那份 `socks5-otc.txt` 本身就是原作者从 TG 频道抓取、并经过连通性测试筛选后的
成果，所以本地不再直连 Telegram，也就不需要任何 API 凭据，只需 `requests`。

抓取脚本只做四件事：拉取 txt → 正则提取节点 → 按 `ip:port` 去重 → 写 `socks5.txt`。

## 环境变量

| 变量 | 用途 | 必要 | 默认 |
|------|------|------|------|
| `GH_NODE_URLS` | 节点文件地址，逗号分隔，支持多个源 | 否 | 上游 socks5-otc.txt |
| `GH_TIMEOUT` | 单次请求超时秒数 | 否 | `25` |
| `FETCH_PLAIN` | `1` = 同时收录无认证的 `ip:port` 节点 | 否 | `0` |
| `R9_BASE_URL` | 9router 首页地址，https:// 开头 | 是 | 内置默认 |
| `R9_PASSWORD` | 9router 登录密码 | 是 | — |
| `GH_TOKEN` | 写回仓库 Token | 是（CI 用） | — |
| `TG_BOT_TOKEN` | TG 通知机器人 Token | 否 | — |
| `TG_CHAT_ID` | TG 通知接收 Chat ID | 否 | — |
| `TEST_CONCURRENCY` | 并行测试并发数 | 否 | `8` |
| `TEST_TIMEOUT` | 单节点测试超时秒数 | 否 | `10` |
| `DEAD_RATIO_LIMIT` | 不通比例阈值，系统性异常保护 | 否 | `0.9` |

> `GH_NODE_URLS` 在 GitHub Actions 中读取仓库 **Variables**，留空即用默认值。
> 传入 `github.com/.../blob/...` 网页地址会自动转换为 raw 直链。

## 安全机制

每次运行都重新登录获取 `auth_token`，不复用 cookie，避免过期 cookie 导致测试全部 401。

测试环节区分三种结果：

- **连通** → 保留并写入 `socks5-otc.txt`
- **不通**（`ok: false` / 超时 / 连接异常）→ 删除
- **系统性异常**（HTTP 401/403/429/5xx）→ 保留不删除

当「不通 + 异常」比例超过 `DEAD_RATIO_LIMIT`（默认 90%）时，判定为系统性异常
（鉴权失效 / 服务故障 / 限流），**跳过全部删除操作，不覆盖 `socks5-otc.txt`**，
发送告警通知后以非零码退出。

## 本地运行

```bash
# 安装依赖
pip install -r requirements.txt

# 1. 抓取节点（无需任何凭据）
python fetch-nodes.py

# 可选：多个源
GH_NODE_URLS="https://raw.githubusercontent.com/A/repo/main/a.txt,https://raw.githubusercontent.com/B/repo/main/b.txt" python fetch-nodes.py

# 2. 同步到 9router
export R9_PASSWORD=xxx
python proxy-manager.py

# 可选：调整并行测试参数
export TEST_CONCURRENCY=16 TEST_TIMEOUT=20
python proxy-manager.py
```

> 若本机设置了 `HTTP_PROXY` / `HTTPS_PROXY` 导致抓取失败，先 `unset` 再运行；
> GitHub Actions 环境无此问题。

## 定时任务

GitHub Actions 每天早上 **北京时间 18:00** 自动执行：

- 读取上游节点文件，按 `ip:port` 去重
- 同步到 9router 代理池（只增不减）
- 测试连通性，删除不通的节点
- 更新 `socks5-otc.txt` 并提交到仓库
- 发送 TG 通知汇总

## 注意：读写同一文件的循环

本仓库的 `proxy-manager.py` 会**写出** `socks5-otc.txt`，而默认读取的正是
上游同名文件。只要你的仓库不是 `yutian81/Keepalive` 本身，这就是正常的
「读上游、写自己」，无需处理。

如果你正好在 `yutian81/Keepalive` 仓库里跑这个 workflow，那么读写的会是同一个
文件，效果是：上一轮被测试删除的节点，下一轮又会被读回来重新加入、再次测试、
再次删除。功能上不会出错（最终仍是不通的被删掉），但每天会多一轮无效测试。
这种情况建议把输出文件名改掉，例如 `socks5-live.txt`。

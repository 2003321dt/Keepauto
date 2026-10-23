# 9R-Proxy — OTC 代理同步工具

从上游仓库已筛选好的节点文件读取 socks5/http 代理节点，同步到 9router 代理池，测试连通性后输出可用节点列表。

## 工作流程

```
上游节点文件（raw txt）──► socks5.txt ──► proxy-manager.py ──► socks5-otc.txt
                                                                  │
                                                                  └── 可用节点列表
```

## 节点来源

直接读取上游仓库已经筛选好的节点文件：

```
https://raw.githubusercontent.com/yutian81/Keepalive/refs/heads/main/9r-proxy/socks5-otc.txt
```

上游那份 `socks5-otc.txt` 本身就是原作者从 TG 频道抓取、并经过连通性测试筛选后的成果，所以本地不再直连 Telegram，**不需要任何 Telegram API 凭据**。

`fetch-nodes.py` 只做四件事：下载 txt → 正则提取节点 → 按 `ip:port` 去重 → 写 `socks5.txt`。

## 环境变量

| 变量 | 用途 | 必要 |
|------|------|------|
| `GH_NODE_URLS` | 节点文件地址，多个用逗号分隔 | 否（有默认值） |
| `GH_TIMEOUT` | 单次下载超时秒数，默认 25 | 否 |
| `TG_BOT_TOKEN` | TG 通知机器人 Token | 否 |
| `TG_CHAT_ID` | TG 通知接收 Chat ID | 否 |
| `R9_BASE_URL` | 9router 首页地址，https:// 开头 | 是 |
| `R9_PASSWORD` | 9router 登录密码 | 是 |
| `GH_TOKEN` | 写回仓库 Token | 是（CI 用） |
| `TEST_CONCURRENCY` | 并行测试并发数，默认 8 | 否 |
| `TEST_TIMEOUT` | 单节点测试超时秒数，默认 10 | 否 |
| `DEAD_RATIO_LIMIT` | 不通比例阈值，默认 0.9（90%） | 否 |

> `GH_NODE_URLS` / `GH_TIMEOUT` 在 GitHub Actions 中读取仓库 **Variables**，留空即用默认值。
> 传入 `github.com/.../blob/...` 网页地址会自动转换为 raw 直链。

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

# 1. 抓取节点（无需任何凭据）
python fetch-nodes.py

# 可选：追加更多节点源
export GH_NODE_URLS="https://raw.githubusercontent.com/A/repo/main/a.txt,https://raw.githubusercontent.com/B/repo/main/b.txt"
python fetch-nodes.py

# 2. 同步到 9router
export R9_PASSWORD=xxx
python proxy-manager.py

# 可选：调整并行测试参数
export TEST_CONCURRENCY=16 TEST_TIMEOUT=20
python proxy-manager.py
```

> 若本机设置了 `HTTP_PROXY` / `HTTPS_PROXY` 导致下载失败，先 `unset` 再运行；GitHub Actions 环境无此问题。

## 定时任务

GitHub Actions 每天自动执行（cron `0 14 * * *`，即北京时间 22:00）：

- 读取上游节点文件，按 `ip:port` 去重
- 同步到 9router 代理池（只增不减）
- 测试连通性，删除不通的节点
- 更新 `socks5-otc.txt` 并提交到仓库
- 发送 TG 通知汇总

## 注意：读写同名文件的循环

`proxy-manager.py` 会**写出** `socks5-otc.txt`，而 `fetch-nodes.py` 默认读取的是上游
同名文件。只要你的仓库不是 `yutian81/Keepalive` 本身，就是正常的「读上游、写自己」。

如果恰好在该仓库里运行此 workflow，读写会是同一个文件：上一轮被测试删除的死节点，
下一轮又会被读回来重新加入、再次测试、再次删除。功能不会出错，但每天多一轮无效测试，
这种情况建议把输出文件名改为 `socks5-live.txt`。

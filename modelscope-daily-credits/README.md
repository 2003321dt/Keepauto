# ModelScope 每日登录领魔粒（GitHub Actions）

用 GitHub Actions 每天定时**用账号密码登录 [ModelScope 魔搭](https://www.modelscope.cn/my/overview)**，
登录成功后**等 10 秒 → 刷新页面 → 读取当前魔粒（积分）余额**，结果输出到 Job Summary、日志和 artifacts 截图里。

> 魔搭的规则是「注册并登录即可获得每日魔粒」，发放是**服务端在登录时自动完成**的，本项目只是
> 用浏览器真实走一遍登录，因此不需要点任何「签到/领取」按钮。

---

## 目录结构

仓库根目录里套了一层项目目录，工作流用 `defaults.run.working-directory` 统一指定，
所以本地跑命令前要先 `cd modelscope-daily-credits`。

```
<仓库根目录>
├── .github/workflows/daily-claim.yml   # 定时任务定义（run 步骤默认在项目子目录执行）
├── .gitignore                          # 仓库级忽略规则
└── modelscope-daily-credits/           # ← 项目目录
    ├── src/
    │   ├── index.js      # 主流程：登录 → 等 10s → 刷新 → 读余额
    │   ├── login.js      # 账号密码登录（阿里 passport iframe）/ Cookie 兜底
    │   ├── balance.js    # 魔粒余额读取（接口 / XHR 拦截 / DOM 三路兜底）
    │   ├── notify.js     # 可选：Telegram Bot 推送
    │   ├── utils.js      # 日志、截图、Step Summary
    │   └── env.js        # 本地 .env 加载
    ├── scripts/smoke-login.js   # 站点改版后验证选择器是否失效
    ├── .env.example
    └── package.json
```

---

## 5 分钟上手

### 1. 把项目推到 GitHub

```bash
git init
git add .
git commit -m "feat: modelscope daily credits workflow"
git branch -M main
git remote add origin git@github.com:<你的用户名>/<仓库名>.git
git push -u origin main
```

### 2. 配置 Secrets

仓库 → **Settings → Secrets and variables → Actions → New repository secret**

| Secret 名称 | 是否必填 | 说明 |
| --- | --- | --- |
| `MODELSCOPE_USERNAME` | 必填 | 魔搭账号（手机号 / 邮箱 / 用户名，就是网页登录框里填的那个） |
| `MODELSCOPE_PASSWORD` | 必填 | 密码 |
| `MODELSCOPE_COOKIE` | 选填 | 兜底用。浏览器里整段 Cookie 字符串，账号密码被滑块拦住时启用。取法见下 |
| `TG_BOT_TOKEN` | 选填 | Telegram 机器人 token，填了才会推送 |
| `TG_CHAT_ID` | 选填 | 接收消息的 chat id（自己 / 群 / 频道） |

#### 怎么拿 MODELSCOPE_COOKIE

真正代表「已登录」的是 **`m_session_id`** 这一条（前端就是靠 `document.cookie` 里有没有它来判断登录态的），
`csrf_token` 负责 POST/PUT 请求的校验头。其余 `cna`、`acw_tc` 之类是埋点/防护用的，可有可无。

**推荐做法（整段复制，最不容易出错）**

1. 浏览器登录 <https://www.modelscope.cn>，按 `F12` 打开开发者工具
2. 切到 **Network（网络）** 面板，刷新一下页面
3. 点任意一条 `www.modelscope.cn` 的请求 → **Headers** → 找 `Request Headers` 里的 **`Cookie:`**
4. 复制冒号后面**整行**，形如：

   ```
   m_session_id=xxxxx%3D%3D; csrf_token=yyyy%3D; cna=zzzz; ...
   ```

5. 一整串粘进 `MODELSCOPE_COOKIE`，不要加引号

**只填一条也行**

```
m_session_id=xxxxx%3D%3D
```

⚠️ 注意 `m_session_id` 的值是 **URL 编码的**（里面有 `%3D`、`%2B` 这类字符），必须原样保留。
所以别从 **Application（应用）→ Cookies** 面板手抄单条值——那里显示的是解码后的样子，粘回去容易失效。
要用单条的话，在 Console 里执行 `document.cookie` 复制，或者在 Network 面板里整段复制后只保留这一条。

**验证有没有效**

```bash
cd modelscope-daily-credits
MODELSCOPE_COOKIE='m_session_id=xxxxx' npm run login-only
```

日志里出现 `Cookie 登录成功，用户：xxx` 就算对了。失败会报 `COOKIE_INVALID`（过期了，重新复制一次换掉 Secret 即可）。

#### 怎么拿 Telegram 的两个值

1. Telegram 里搜 **@BotFather** → 发 `/newbot` → 起个名字 → 拿到
   `123456789:AAExxxxxxxxxxxxxxxxxxxxxxxx` 这样的 token，填进 `TG_BOT_TOKEN`
2. 拿 chat id：
   - **推给自己**：搜 **@userinfobot** 发消息，它回你的数字 id，填进 `TG_CHAT_ID`
   - **推到群**：把机器人拉进群，然后浏览器访问
     `https://api.telegram.org/bot<你的token>/getUpdates`，找 `"chat":{"id":-100xxxxxxxxx`，
     这一串负数就是群 id（记得先在群里随便发一句，`getUpdates` 才有数据）
   - **推到频道**：把机器人设为频道管理员，直接用 `@频道用户名`
3. 先手动给机器人发一句 `/start`，否则它没法主动给你发消息（群/频道不用）

> 消息是纯文本发送（不带 Markdown），避免余额里的特殊字符把 Telegram 的解析搞崩。

### 3. 跑一次

**Actions → ModelScope 每日登录领魔粒 → Run workflow**

跑完后：

- Job 页面底部的 **Summary** 里有一张结果表（账号 / 可用魔粒 / 短期 / 长期 / 数据来源 / 耗时）
- 日志最后会打印一段结果摘要
- **Artifacts** 里有 4 张截图 + `result.json`（登录后、概览页、刷新后、魔粒页）

### 4. 之后就是自动的

默认每天 **北京时间 08:10**（UTC `10 0 * * *`）自动执行一次。魔粒每天 00:00（北京时间）重置，
短期魔粒只有 24 小时有效期，所以每天跑一次刚好覆盖。

---

## 本地调试

```bash
cd modelscope-daily-credits          # 项目在这个子目录里

npm install
npx playwright install chromium

cp .env.example .env      # 填入账号密码
npm start                 # HEADLESS=false 可以肉眼看整个登录过程
npm run login-only        # 只验证登录，不查余额
npm run smoke             # 只检查登录页表单选择器是否还有效（不用填账号）
```

> 本机已装 Chrome 的话，可以加 `BROWSER_CHANNEL=chrome` 直接复用系统浏览器，省掉 chromium 下载：
> `BROWSER_CHANNEL=chrome HEADLESS=false npm start`

---

## 参数说明

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `MODELSCOPE_USERNAME` | - | 账号 |
| `MODELSCOPE_PASSWORD` | - | 密码 |
| `MODELSCOPE_COOKIE` | - | Cookie 兜底，优先级低于账号密码（账号密码失败才用） |
| `WAIT_SECONDS` | `10` | 登录成功后等待多少秒再刷新（你要的 10 秒） |
| `HEADLESS` | `true` | 是否无头运行，本地调试设 `false` |
| `LOGIN_TIMEOUT_SECONDS` | `90` | 等待登录态生效的最长时间 |
| `TG_BOT_TOKEN` | - | 机器人 token，和下一个一起填了才推送 |
| `TG_CHAT_ID` | - | 接收消息的 chat id |
| `TELEGRAM_API_BASE` | `https://api.telegram.org` | 走反代时改成自己的地址 |

---

## 它是怎么找到「积分」的

魔搭的积分体系叫**魔粒**（Magicube），余额页在 <https://www.modelscope.cn/magicube/usage>。
前端调的是 `/api/v1/magicubes/balance`（从站点的 JS bundle 里反查出来的）。
因为接口路径可能改版，脚本按下面的顺序找，谁先成功用谁：

1. **直接请求余额接口**（带登录 Cookie）
2. **拦截页面自己发出的 XHR**（URL 含 `magicube` / `credit` / `balance` 的 JSON 响应）
3. **解析页面 DOM**（`[class*="balanceValue"]` → 「我的魔粒」标题附近的数字 → 文本内联匹配）

三个都失败时会在日志里打 `::warning::`，并把截图和整页 HTML 存到 artifacts，方便按新结构改选择器。

---

## 登录是怎么做的

魔搭的登录页 `https://www.modelscope.cn/login` 里内嵌的是阿里 passport 的 `fm-login` 表单（在 iframe 里），
脚本会遍历所有 frame 找到 `#fm-login-id` / `#fm-login-password`，输入后点提交，然后轮询
`/api/v1/users/me` 判断登录态是否生效。

几个工程细节：

- **登录态缓存**：每次运行结束会把 `storageState` 存进 GitHub Actions 缓存，下次优先复用。
  这样绝大多数时候根本不用重新输密码，也就不会被滑块风控盯上。
- **滑块检测**：一旦发现 `.nc-container` / `#nc_1_wrapper` 之类的风控容器，不会硬刚，
  而是抛出 `CAPTCHA_REQUIRED` 并提示改用 `MODELSCOPE_COOKIE`。
- **Cookie 兜底**：账号密码失败且配置了 Cookie 时，自动降级为 Cookie 登录。

---

## 常见问题

**Q：报 `CAPTCHA_REQUIRED`（滑块验证）怎么办？**
阿里 passport 的风控在 GitHub 美国 IP 上更容易弹滑块。三种解法，按推荐顺序：

1. **什么都不用改**——多跑几次，登录态缓存命中后就不需要再登录了；
2. 配 `MODELSCOPE_COOKIE`：浏览器登录后 F12 → Network → 任意请求 → 复制 Cookie 请求头，
   整段塞进 Secret。Cookie 有效期通常较长，过期了再换一次；
3. 本地跑（家宽 IP 基本不弹滑块）：`npm start`。

**Q：`FORM_NOT_FOUND` / 找不到输入框？**
站点改版了。打开失败截图和 `99-error.html`，把新的选择器补到 `src/login.js` 顶部的
`ID_SELECTORS` / `PWD_SELECTORS` / `SUBMIT_SELECTORS` 里即可。

**Q：余额显示「未读取到」但登录成功？**
说明魔粒可能已经到账了，只是解析没命中。看 `04-magicube.png` 截图确认，再把新的 class 名补进
`src/balance.js` 的 `readFromDom()`。

**Q：短期魔粒为什么每天都是 200 左右？**
短期魔粒 24 小时有效、每天重置，不累积。绑定了阿里云账号的账号每日会多 50。所以余额长期看是
「长期魔粒在涨，短期魔粒每天归零再发」。

**Q：我把项目目录改名了 / 移到了别的子目录，工作流报 `找不到 package.json`？**
改 `.github/workflows/daily-claim.yml` 里这三处，保持一致即可：

1. `defaults.run.working-directory`
2. cache 的 `path`（两处：restore 和 save）
3. upload-artifact 的 `path`

工作流里有个「校验项目目录」步骤，会在跑测试前先 `ls` 一遍，路径不对会直接报错，不会跑到一半才失败。

---

## 注意

- 这是用**你自己的账号**做**你自己的**每日登录，密码只存在 GitHub Secrets 里，不会被打印（日志里只打前 3 位）。
- 自动登录存在被平台风控识别、账号被临时限制的可能；GitHub 的 runner IP 是公共云 IP，比家用 IP 更容易触发验证。
  如果你在意账号安全，优先用 Cookie 方式或本地定时任务。
- 平台规则可能随时调整（接口、每日发放金额、有效期），本项目按「登录即发放」的现有规则实现。

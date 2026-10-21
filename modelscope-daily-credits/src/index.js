/**
 * 主流程：
 *   打开浏览器 → 登录 → 进入「我的概览」→ 等 10 秒 → 刷新 → 读魔粒余额 → 输出结果
 */
const fs = require('fs');
const path = require('path');

const { loadEnv } = require('./env');
loadEnv();

const { chromium } = require('playwright');
const {
  sleep,
  log,
  logError,
  appendSummary,
  setOutput,
  screenshot,
  dumpHtml,
  ensureDir,
  ARTIFACT_DIR,
} = require('./utils');
const { HOME_URL, getMe, loginWithPassword, loginWithCookie, LoginError } = require('./login');
const { readBalance, attachCapture } = require('./balance');
const { notify } = require('./notify');

const SESSION_DIR = path.resolve(process.cwd(), 'session');
const STATE_FILE = path.join(SESSION_DIR, 'storage-state.json');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function ghAnnotation(level, message) {
  // 在 Actions 日志里高亮，本地运行时是无害文本
  console.log(`::${level}::${message}`);
}

function formatResult(result) {
  const lines = [];
  lines.push('==================================================');
  lines.push('ModelScope 每日登录领魔粒 — 执行结果');
  lines.push('--------------------------------------------------');
  lines.push(`账号        : ${result.user || '(未知)'}`);
  lines.push(`执行时间    : ${result.finishedAt}`);
  if (result.balance && result.balance.available) {
    lines.push(`可用魔粒    : ${result.balance.available.value}`);
  } else {
    lines.push('可用魔粒    : 未读取到');
  }
  if (result.balance && result.balance.shortTerm) {
    lines.push(`短期魔粒    : ${result.balance.shortTerm.value}（24 小时有效）`);
  }
  if (result.balance && result.balance.longTerm) {
    lines.push(`长期魔粒    : ${result.balance.longTerm.value}（90 天有效）`);
  }
  lines.push(`数据来源    : ${result.balance ? result.balance.source : 'n/a'}`);
  lines.push(`登录方式    : ${result.loginMethod}`);
  lines.push(`总耗时      : ${result.elapsedSeconds}s`);
  lines.push('==================================================');
  return lines.join('\n');
}

async function main() {
  const startedAt = Date.now();
  const waitSeconds = Number(process.env.WAIT_SECONDS || 10);
  const headless = String(process.env.HEADLESS ?? 'true').toLowerCase() !== 'false';
  const loginTimeoutMs = Number(process.env.LOGIN_TIMEOUT_SECONDS || 90) * 1000;
  const username = (process.env.MODELSCOPE_USERNAME || '').trim();
  const password = (process.env.MODELSCOPE_PASSWORD || '').trim();
  const cookie = (process.env.MODELSCOPE_COOKIE || '').trim();
  const loginOnly = process.argv.includes('--login-only');

  ensureDir(ARTIFACT_DIR);

  log('启动参数：', JSON.stringify({ waitSeconds, headless, loginOnly, hasPassword: !!username, hasCookie: !!cookie }));

  let browser;
  let context;
  let page;
  let result = {
    ok: false,
    user: null,
    loginMethod: 'none',
    balance: null,
    elapsedSeconds: 0,
    finishedAt: '',
  };

  try {
    // 代理：优先用工作流产出的 PROXY_HTTP（sing-box 的 http 入站，Chromium 最稳），
    // 其次 PROXY_SERVER（socks5）。两者都没有就直连。
    const proxyServer = (process.env.PROXY_HTTP || process.env.PROXY_SERVER || '').trim();
    if (proxyServer) log('浏览器将走代理：', proxyServer);
    else log('未配置代理，浏览器直连');

    const proxyOption = proxyServer ? { proxy: { server: proxyServer } } : {};

    browser = await chromium.launch({
      headless,
      // 可选：BROWSER_CHANNEL=chrome 使用本机已安装的 Chrome（本地调试更真实）
      ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}),
      ...proxyOption,
      args: [
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--lang=zh-CN',
      ],
    });

    const contextOptions = {
      viewport: { width: 1440, height: 900 },
      locale: 'zh-CN',
      timezoneId: 'Asia/Shanghai',
      userAgent: UA,
      extraHTTPHeaders: { 'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8' },
      ...proxyOption, // 这样 context.request（登录态检测、余额接口）也走代理
    };

    // 复用上次运行留下的登录态，能显著降低触发滑块的概率
    if (fs.existsSync(STATE_FILE)) {
      contextOptions.storageState = STATE_FILE;
      log('发现本地缓存的登录态，尝试复用：', STATE_FILE);
    }

    context = await browser.newContext(contextOptions);
    page = await context.newPage();
    page.setDefaultTimeout(30000);

    // 提前挂网络监听，登录过程中的魔粒接口也能被抓到
    const captured = attachCapture(page);

    page.on('console', (msg) => {
      if (msg.type() === 'error') log('[页面控制台]', msg.text().slice(0, 200));
    });

    // ---------- 1. 登录 ----------
    let me = await getMe(context);
    if (me) {
      result.loginMethod = '复用缓存登录态';
      log('缓存登录态有效，跳过登录，用户：', me.Name || me.UserName || '(未知)');
    } else if (username && password) {
      log('缓存无效，开始账号密码登录');
      try {
        me = await loginWithPassword(context, page, {
          username,
          password,
          timeoutMs: loginTimeoutMs,
        });
        result.loginMethod = '账号密码';
      } catch (err) {
        await screenshot(page, '10-login-failed');
        await dumpHtml(page, '10-login-failed');
        if (cookie) {
          logError(`${err.code || ''} ${err.message}`);
          log('改用 Cookie 兜底登录');
          me = await loginWithCookie(context, cookie);
          result.loginMethod = 'Cookie（账号密码失败后兜底）';
        } else {
          throw err;
        }
      }
    } else if (cookie) {
      log('未配置账号密码，使用 Cookie 登录');
      me = await loginWithCookie(context, cookie);
      result.loginMethod = 'Cookie';
    } else {
      throw new LoginError(
        '没有任何可用的登录凭据：请配置 MODELSCOPE_USERNAME + MODELSCOPE_PASSWORD，或 MODELSCOPE_COOKIE',
        'NO_CREDENTIALS'
      );
    }

    result.user = me.Name || me.UserName || me.EmployeeNo || '(未知)';
    await screenshot(page, '01-logged-in');

    if (loginOnly) {
      log('已按要求只执行登录，结束');
      result.ok = true;
    } else {
      // ---------- 2. 进入「我的概览」 ----------
      log('打开我的概览：', HOME_URL);
      await page.goto(HOME_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await screenshot(page, '02-overview');

      // ---------- 3. 等 10 秒（让服务端把当日魔粒发下来） ----------
      log(`等待 ${waitSeconds} 秒……`);
      await sleep(waitSeconds * 1000);

      // ---------- 4. 刷新页面 ----------
      log('刷新页面');
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 60000 });
      await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
      await sleep(2000);
      await screenshot(page, '03-after-reload');

      // 刷新后再次确认登录态没掉
      const stillLoggedIn = await getMe(context);
      if (!stillLoggedIn) {
        throw new LoginError('刷新后登录态丢失，可能被风控登出', 'SESSION_LOST');
      }

      // ---------- 5. 读余额 ----------
      log('读取魔粒余额……');
      const balance = await readBalance(context, page, captured);
      result.balance = balance;
      await screenshot(page, '04-magicube');

      if (!balance.available) {
        ghAnnotation('warning', '未读取到魔粒余额，请查看 artifacts 中的截图与 HTML');
      }
      result.ok = true;
    }

    // ---------- 6. 落盘 ----------
    result.elapsedSeconds = Math.round((Date.now() - startedAt) / 100) / 10;
    result.finishedAt = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });

    const output = {
      ...result,
      capturedUrls: captured.map((c) => ({ url: c.url, status: c.status })),
    };
    const resultFile = path.join(ARTIFACT_DIR, 'result.json');
    fs.writeFileSync(resultFile, JSON.stringify(output, null, 2), 'utf8');
    log('结果已写入：', resultFile);

    // 保存登录态给下次复用
    ensureDir(SESSION_DIR);
    await context.storageState({ path: STATE_FILE });
    log('登录态已缓存：', STATE_FILE);

    const text = formatResult(result);
    console.log('\n' + text + '\n');

    appendSummary([
      '## ModelScope 每日登录领魔粒',
      '',
      '| 项目 | 值 |',
      '| --- | --- |',
      `| 账号 | \`${result.user}\` |`,
      `| 可用魔粒 | **${result.balance?.available?.value ?? '未读取到'}** |`,
      `| 短期魔粒（24h） | ${result.balance?.shortTerm?.value ?? '-'} |`,
      `| 长期魔粒（90天） | ${result.balance?.longTerm?.value ?? '-'} |`,
      `| 数据来源 | \`${result.balance?.source ?? '-'}\` |`,
      `| 登录方式 | ${result.loginMethod} |`,
      `| 执行时间 | ${result.finishedAt} |`,
      `| 耗时 | ${result.elapsedSeconds}s |`,
    ].join('\n'));

    setOutput('user', result.user);
    setOutput('credits', result.balance?.available?.value ?? '');

    await notify(
      [
        `【ModelScope 每日魔粒】`,
        `账号：${result.user}`,
        `可用：${result.balance?.available?.value ?? '未读取到'}`,
        `短期(24h)：${result.balance?.shortTerm?.value ?? '-'}　长期(90天)：${result.balance?.longTerm?.value ?? '-'}`,
        `时间：${result.finishedAt}`,
        `https://www.modelscope.cn/magicube/usage`,
      ].join('\n')
    );

    process.exitCode = 0;
  } catch (err) {
    logError('执行失败：', err.message);
    result.error = { code: err.code || 'UNKNOWN', message: err.message };
    result.finishedAt = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
    result.elapsedSeconds = Math.round((Date.now() - startedAt) / 100) / 10;

    await screenshot(page, '99-error').catch(() => null);
    await dumpHtml(page, '99-error').catch(() => null);

    try {
      ensureDir(ARTIFACT_DIR);
      fs.writeFileSync(
        path.join(ARTIFACT_DIR, 'result.json'),
        JSON.stringify(result, null, 2),
        'utf8'
      );
    } catch {
      /* 忽略 */
    }

    ghAnnotation('error', err.message);
    appendSummary(
      [
        '## ModelScope 每日登录领魔粒 — 失败',
        '',
        `- 错误码：\`${err.code || 'UNKNOWN'}\``,
        `- 错误信息：${err.message}`,
        `- 时间：${result.finishedAt}`,
        '',
        '排查建议：',
        '- 若是滑块/风控（`CAPTCHA_REQUIRED`）：改用 `MODELSCOPE_COOKIE` 兜底',
        '- 若是找不到表单（`FORM_NOT_FOUND`）：站点改版，需更新 `src/login.js` 里的选择器',
        '- artifacts 里有失败截图与页面 HTML',
      ].join('\n')
    );

    await notify(`【ModelScope 领魔粒失败】\n${err.code || ''} ${err.message}\n详情见 Actions 日志与 artifacts`);

    process.exitCode = 1;
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

main();

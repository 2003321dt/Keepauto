/**
 * 冒烟测试：不填账号密码，只验证「能不能在登录页找到账号密码输入框」
 * 用于站点改版后快速判断选择器是否还有效。
 *
 *   node scripts/smoke-login.js
 */
const { chromium } = require('playwright');
const { sleep } = require('./../src/utils');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

(async () => {
  const channel = process.env.BROWSER_CHANNEL || undefined; // 例：BROWSER_CHANNEL=chrome 用本机 Chrome
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox'],
    ...(channel ? { channel } : {}),
  });
  const context = await browser.newContext({ locale: 'zh-CN', userAgent: UA, viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  console.log('打开登录页……');
  await page.goto('https://www.modelscope.cn/login', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(4000);

  const frames = page.frames();
  console.log(`\n共 ${frames.length} 个 frame：`);
  for (const f of frames) console.log(' -', f.url() || '(about:blank)');

  const candidates = ['#fm-login-id', 'input[name="loginId"]', 'input[type="password"]', 'button.fm-button'];
  console.log('\n选择器命中情况：');
  for (const f of frames) {
    for (const sel of candidates) {
      const el = await f.$(sel).catch(() => null);
      if (el) console.log(` - ${sel}  =>  ${f.url()}`);
    }
  }

  console.log('\n页面标题：', await page.title());
  await page.screenshot({ path: 'artifacts/smoke-login.png', fullPage: true }).catch(() => {});
  console.log('截图：artifacts/smoke-login.png');

  await browser.close();
})();

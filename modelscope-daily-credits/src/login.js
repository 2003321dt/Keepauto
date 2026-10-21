/**
 * 登录模块
 *
 * ModelScope 的登录走阿里 passport（iframe 内嵌 fm-login 表单），
 * 有些环境会弹滑块风控。因此这里提供两条路径：
 *   1) 账号密码登录（主方式，用户要求的方式）
 *   2) Cookie 注入（兜底，滑块拦死时用）
 */
const { sleep, log, logError } = require('./utils');

const ORIGIN = 'https://www.modelscope.cn';
const LOGIN_URL = `${ORIGIN}/login`;
const HOME_URL = `${ORIGIN}/my/overview`;
const ME_API = `${ORIGIN}/api/v1/users/me`;

// 阿里 passport 登录表单的常见选择器（按优先级）
const ID_SELECTORS = [
  '#fm-login-id',
  'input[name="loginId"]',
  'input[name="account"]',
  'input#login-email',
  'input[placeholder*="账号"]',
  'input[placeholder*="邮箱"]',
  'input[placeholder*="手机"]',
];
const PWD_SELECTORS = [
  '#fm-login-password',
  'input[type="password"]',
  'input[name="password"]',
];
const SUBMIT_SELECTORS = [
  'button.fm-button.fm-submit',
  'button.fm-submit',
  'button.fm-button',
  'button.login-btn',
  'button[type="submit"]',
  '.fm-button',
  '#login-submit',
];
// 必须先勾选《用户协议》《隐私政策》，否则登录按钮一直是禁用态
const AGREE_SELECTORS = [
  '#fm-agreement-checkbox',
  'input[name="fm-agreement-checkbox"]',
  'input[name="agreement"]',
  'label[for="fm-agreement-checkbox"]',
];
// 滑块 / 风控容器
const CAPTCHA_SELECTORS = [
  '.nc-container',
  '#nc_1_wrapper',
  '#nc_1_n1z',
  '#nc_1_captcha_input',
  '.nc_scale',
  '[id^="nc_1"]',
  '.baxia-dialog',
  '#nocaptcha',
];

class LoginError extends Error {
  constructor(message, code = 'LOGIN_FAILED') {
    super(message);
    this.name = 'LoginError';
    this.code = code;
  }
}

/** 通过接口判断当前是否为已登录状态，返回用户信息或 null */
async function getMe(context) {
  try {
    const res = await context.request.get(ME_API, {
      headers: { Accept: 'application/json' },
      timeout: 20000,
      failOnStatusCode: false,
    });
    if (!res.ok()) return null;
    const json = await res.json().catch(() => null);
    if (json && json.Code === 200 && json.Data) return json.Data;
    return null;
  } catch {
    return null;
  }
}

/** 在页面所有 frame（含主文档）里找登录表单 */
async function findFormFrame(page, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      for (const sel of ID_SELECTORS) {
        const el = await frame.$(sel).catch(() => null);
        if (el) {
          const visible = await el.isVisible().catch(() => false);
          if (visible) return { frame, idSelector: sel };
        }
      }
    }
    if (attempt % 6 === 5) {
      log(`仍在等待登录表单…… 已有 frame：${page.frames().map((f) => f.url()).join(' | ')}`);
    }
    attempt += 1;
    await sleep(1000);
  }
  return null;
}

/** 在 frame 内按选择器列表找第一个可见元素，返回 Locator */
async function firstVisible(frame, selectors) {
  for (const sel of selectors) {
    const locator = frame.locator(sel).first();
    if (await locator.isVisible().catch(() => false)) return locator;
  }
  return null;
}

/** 检测是否存在滑块 / 风控弹层 */
async function detectCaptcha(page, frame) {
  const scopes = [frame, page.mainFrame()].filter(Boolean);
  for (const scope of scopes) {
    for (const sel of CAPTCHA_SELECTORS) {
      const el = await scope.$(sel).catch(() => null);
      if (el && (await el.isVisible().catch(() => false))) return sel;
    }
  }
  return null;
}

/** 勾选《用户协议》《隐私政策》，不勾选登录按钮不可点 */
async function ensureAgreement(frame) {
  const input = frame.locator('#fm-agreement-checkbox').first();
  if (await input.count().catch(() => 0)) {
    if (await input.isChecked().catch(() => false)) return true;
    if (await input.isVisible().catch(() => false)) {
      await input.click({ force: true, timeout: 5000 }).catch(() => {});
    } else {
      // 真实 input 被隐藏时，点它的 label
      const label = frame.locator('label[for="fm-agreement-checkbox"]').first();
      if (await label.count().catch(() => 0)) {
        await label.click({ force: true, timeout: 5000 }).catch(() => {});
      }
    }
    const ok = await input.isChecked().catch(() => false);
    if (ok) log('已勾选《用户协议》与《隐私政策》');
    else log('协议勾选状态未确认，继续尝试提交');
    return ok;
  }

  // 兜底：找带「同意」字样的勾选框
  for (const sel of AGREE_SELECTORS.slice(1)) {
    const loc = frame.locator(sel).first();
    if (await loc.isVisible().catch(() => false)) {
      await loc.click({ force: true, timeout: 5000 }).catch(() => {});
      log('已尝试勾选协议');
      return true;
    }
  }
  return false;
}

/** 等登录按钮从禁用变为可点 */
async function waitSubmitEnabled(submit, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const cls = (await submit.getAttribute('class').catch(() => '')) || '';
    const disabledAttr = await submit.getAttribute('disabled').catch(() => null);
    if (!/disabled/i.test(cls) && disabledAttr === null) return true;
    await sleep(500);
  }
  return false;
}

/** 轮询等待登录态生效 */
async function waitForLogin(context, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const me = await getMe(context);
    if (me) return me;
    await sleep(2000);
  }
  return null;
}

/**
 * 账号密码登录
 * @returns {Promise<object>} 用户信息
 */
async function loginWithPassword(context, page, { username, password, timeoutMs = 90000 }) {
  if (!username || !password) {
    throw new LoginError('未提供 MODELSCOPE_USERNAME / MODELSCOPE_PASSWORD', 'NO_CREDENTIALS');
  }

  log('打开登录页：', LOGIN_URL);
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await sleep(2500);

  let found = await findFormFrame(page, 40000);
  if (!found) {
    throw new LoginError('没能在页面上找到账号密码输入框（页面结构可能已改版）', 'FORM_NOT_FOUND');
  }

  // 某些版本默认停在「短信登录」，需要先切到「密码登录」
  let pwdInput = await firstVisible(found.frame, PWD_SELECTORS);
  if (!pwdInput) {
    const tab = found.frame.locator('text=/密码登录|密码登陆|Password/i').first();
    const hasTab = await tab.isVisible().catch(() => false);
    if (hasTab) {
      log('切换到「密码登录」标签');
      await tab.click({ timeout: 5000 }).catch(() => {});
      await sleep(1500);
      pwdInput = await firstVisible(found.frame, PWD_SELECTORS);
    }
  }

  const idInput = await firstVisible(found.frame, ID_SELECTORS);
  if (!idInput) throw new LoginError('找不到账号输入框', 'FORM_NOT_FOUND');
  if (!pwdInput) throw new LoginError('找不到密码输入框', 'FORM_NOT_FOUND');

  log(`填写账号：${username.slice(0, 3)}***`);
  await idInput.click();
  await idInput.fill('');
  await idInput.pressSequentially(username, { delay: 40 });
  await pwdInput.click();
  await pwdInput.fill('');
  await pwdInput.pressSequentially(password, { delay: 40 });
  await sleep(400);

  // 必须勾选协议，否则登录按钮是 disabled 状态
  await ensureAgreement(found.frame);

  const captcha = await detectCaptcha(page, found.frame);
  if (captcha) {
    logError('检测到滑块/风控验证：', captcha);
    // 再等等看是不是自动通过（阿里云无痕验证有时会自己过）
    await sleep(3000);
    const still = await detectCaptcha(page, found.frame);
    if (still) {
      throw new LoginError(
        '登录前出现滑块验证，无法在无人值守环境下自动通过。请改用 MODELSCOPE_COOKIE 兜底。',
        'CAPTCHA_REQUIRED'
      );
    }
  }

  const submit = await firstVisible(found.frame, SUBMIT_SELECTORS);
  if (submit) {
    const enabled = await waitSubmitEnabled(submit, 15000);
    log(enabled ? '登录按钮已可点击' : '登录按钮仍为禁用态，仍尝试点击');
    log('提交登录表单');
    await submit.click({ timeout: 10000 }).catch(async () => {
      await pwdInput.press('Enter').catch(() => {});
    });
  } else {
    log('未找到提交按钮，改为回车提交');
    await pwdInput.press('Enter');
  }

  // 提交后可能才弹滑块
  await sleep(3000);
  const afterCaptcha = await detectCaptcha(page, found.frame);
  if (afterCaptcha) {
    throw new LoginError(
      '提交后出现滑块验证，自动化无法通过。请改用 MODELSCOPE_COOKIE 兜底。',
      'CAPTCHA_REQUIRED'
    );
  }

  log('等待登录态生效……');
  const me = await waitForLogin(context, timeoutMs);
  if (!me) {
    throw new LoginError(
      '等待登录态超时：可能账号密码错误，或被风控拦截。请查看 artifacts 里的截图。',
      'LOGIN_TIMEOUT'
    );
  }
  log('登录成功，用户：', me.Name || me.UserName || '(未知)');
  return me;
}

/**
 * 解析 Cookie 字符串，容错处理用户常见的粘贴姿势：
 *   - 多带了前缀 "Cookie: "
 *   - 前后带引号
 *   - 一条 cookie 占一行（从 Network 面板 copy 成多行的情况）
 * 返回 Playwright 可用的 cookie 数组。
 */
function parseCookieString(cookieString) {
  const normalized = String(cookieString)
    .replace(/^\s*cookie\s*:/i, '') // 去掉 "Cookie:" 前缀
    .replace(/^\s*["']|["']\s*$/g, '') // 去掉首尾引号
    .replace(/\r?\n/g, '; ') // 多行压成一行
    .trim();

  return normalized
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((pair) => {
      const idx = pair.indexOf('=');
      if (idx <= 0) return null; // 没有等号，或 name 为空
      return {
        name: pair.slice(0, idx).trim(),
        value: pair.slice(idx + 1).trim(),
        domain: '.modelscope.cn',
        path: '/',
        secure: true,
        sameSite: 'Lax',
      };
    })
    .filter(Boolean);
}

/** Cookie 注入登录（兜底） */
async function loginWithCookie(context, cookieString) {
  if (!cookieString || !cookieString.trim()) {
    throw new LoginError('未提供 MODELSCOPE_COOKIE', 'NO_COOKIE');
  }

  const cookies = parseCookieString(cookieString);
  if (!cookies.length) throw new LoginError('MODELSCOPE_COOKIE 解析结果为空', 'NO_COOKIE');

  // m_session_id 才是登录态本体，缺了基本不可能成功，提前给出明确提示
  if (!cookies.some((c) => c.name === 'm_session_id')) {
    log('警告：Cookie 里没有 m_session_id，大概率不是登录态，登录可能失败');
  }

  log(`注入 ${cookies.length} 条 Cookie`);
  await context.addCookies(cookies);

  const me = await waitForLogin(context, 30000);
  if (!me) {
    throw new LoginError('Cookie 注入后仍未登录成功，Cookie 可能已过期', 'COOKIE_INVALID');
  }
  log('Cookie 登录成功，用户：', me.Name || me.UserName || '(未知)');
  return me;
}

module.exports = {
  ORIGIN,
  LOGIN_URL,
  HOME_URL,
  ME_API,
  LoginError,
  getMe,
  loginWithPassword,
  loginWithCookie,
  waitForLogin,
  parseCookieString,
  // 以下导出供冒烟测试复用
  findFormFrame,
  firstVisible,
  ensureAgreement,
  waitSubmitEnabled,
  detectCaptcha,
  ID_SELECTORS,
  PWD_SELECTORS,
  SUBMIT_SELECTORS,
};

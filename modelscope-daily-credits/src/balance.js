/**
 * 魔粒（ModelScope 积分）余额读取
 *
 * 三条路并行，谁先拿到算谁：
 *   1) 带登录态直接请求余额接口
 *   2) 拦截页面自己发出的 XHR（最贴近真实页面行为，接口路径变了也能抓到）
 *   3) 解析「我的魔粒」页面 DOM 文本
 */

const { sleep, log, logError } = require('./utils');

const ORIGIN = 'https://www.modelscope.cn';
const MAGICUBE_PAGE = `${ORIGIN}/magicube/usage`;

// 从站点前端 bundle 里反查到的接口路径，另附几个历史/别名路径作为兜底
const CANDIDATE_APIS = [
  `${ORIGIN}/api/v1/magicubes/balance`,
  `${ORIGIN}/api/v1/magicube/balance`,
  `https://modelscope.cn/api/v1/magicubes/balance`,
];

/** 递归收集对象里所有「数字型」字段，key 拍平成 a.b.c 形式 */
function flattenNumbers(obj, out = {}, prefix = '') {
  if (obj === null || obj === undefined) return out;
  if (Array.isArray(obj)) {
    obj.forEach((item, i) => flattenNumbers(item, out, `${prefix}[${i}]`));
    return out;
  }
  if (typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (typeof v === 'number') out[key] = v;
      else if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) out[key] = Number(v);
      else flattenNumbers(v, out, key);
    }
  }
  return out;
}

/** 从拍平的字段里挑出余额相关的值 */
function extractBalance(data) {
  const flat = flattenNumbers(data);
  const entries = Object.entries(flat);
  const pick = (re) => {
    const hit = entries.find(([k]) => re.test(k));
    return hit ? { key: hit[0], value: hit[1] } : null;
  };

  return {
    available: pick(/available_?balance$/i) || pick(/^(data\.)?balance$/i) || pick(/total_?balance/i),
    shortTerm: pick(/short_?term/i),
    longTerm: pick(/long_?term/i),
    allNumbers: flat,
  };
}

/** 策略 1：直接调接口 */
async function readFromApi(context) {
  for (const url of CANDIDATE_APIS) {
    try {
      const res = await context.request.get(url, {
        headers: { Accept: 'application/json' },
        timeout: 20000,
        failOnStatusCode: false,
      });
      const status = res.status();
      if (status === 404) continue;
      const json = await res.json().catch(() => null);
      if (!json) continue;
      if (json.Code && json.Code !== 200) {
        log(`接口 ${url} 返回业务错误：${json.Code} ${json.Message || ''}`);
        continue;
      }
      const data = json.Data ?? json.data ?? json;
      const balance = extractBalance(data);
      if (balance.available || balance.shortTerm || balance.longTerm) {
        log(`接口命中：${url}`);
        return { ...balance, source: `api: ${url}`, raw: data };
      }
    } catch (err) {
      logError(`请求 ${url} 失败：`, err.message);
    }
  }
  return null;
}

/** 策略 2：从拦截到的响应体里找 */
function readFromCaptured(captured) {
  for (const item of captured) {
    const data = item.body?.Data ?? item.body?.data ?? item.body;
    if (!data || typeof data !== 'object') continue;
    const balance = extractBalance(data);
    if (balance.available || balance.shortTerm || balance.longTerm) {
      log(`拦截响应命中：${item.url}`);
      return { ...balance, source: `xhr: ${item.url}`, raw: data };
    }
  }
  return null;
}

/** 策略 3：DOM 文本解析「我的魔粒」页面 */
async function readFromDom(page) {
  log('打开魔粒页面：', MAGICUBE_PAGE);
  await page.goto(MAGICUBE_PAGE, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => {});
  await sleep(3000);

  // 3.1 页面上专门的余额节点
  const nodeText = await page
    .locator('[class*="balanceValue"], [class*="balance_value"]')
    .first()
    .textContent({ timeout: 5000 })
    .catch(() => null);

  if (nodeText && /\d/.test(nodeText)) {
    const value = Number(String(nodeText).replace(/[^\d.]/g, ''));
    if (!Number.isNaN(value)) {
      return { available: { key: 'dom.balanceValue', value }, source: 'dom: balanceValue' };
    }
  }

  // 3.2 「我的魔粒」附近的数字
  const bodyText = await page.evaluate(() => document.body.innerText).catch(() => '');
  const near = bodyText.match(/我的魔粒[\s\S]{0,60}?([\d][\d,]{0,11})/);
  if (near) {
    const value = Number(near[1].replace(/,/g, ''));
    if (!Number.isNaN(value)) {
      return { available: { key: 'dom:near-title', value }, source: 'dom: 我的魔粒标题附近' };
    }
  }

  // 3.3 页面上所有「数字 + 魔粒」的写法
  const inline = bodyText.match(/([\d]{1,9})\s*(?:魔粒|Magicube\s*Credits?)/i);
  if (inline) {
    return {
      available: { key: 'dom:inline', value: Number(inline[1]) },
      source: 'dom: 文本内联匹配',
    };
  }

  return null;
}

/**
 * 在页面上挂响应监听，捕获所有疑似魔粒/积分的接口返回
 */
function attachCapture(page) {
  const captured = [];
  page.on('response', async (response) => {
    try {
      const url = response.url();
      if (!/magicube|magic-cube|credit|balance/i.test(url)) return;
      const type = response.request().resourceType();
      if (!['xhr', 'fetch'].includes(type)) return;
      const body = await response.json().catch(() => null);
      if (body) captured.push({ url, status: response.status(), body });
    } catch {
      /* 忽略解析失败 */
    }
  });
  return captured;
}

/** 三条策略串起来，返回最完整的那个结果 */
async function readBalance(context, page, captured) {
  const fromApi = await readFromApi(context);
  if (fromApi) return fromApi;

  const fromXhr = readFromCaptured(captured);
  if (fromXhr) return fromXhr;

  const fromDom = await readFromDom(page).catch((err) => {
    logError('DOM 解析失败：', err.message);
    return null;
  });
  if (fromDom) return fromDom;

  return {
    source: 'none',
    note: '三种方式都没读到余额，请查看 artifacts 里的截图与 HTML，可能是页面结构改版',
  };
}

module.exports = { MAGICUBE_PAGE, readBalance, attachCapture, extractBalance };

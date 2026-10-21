/**
 * 通知：Telegram Bot 推送
 *
 * 必填：TG_BOT_TOKEN（@BotFather 创建的机器人 token）
 *       TG_CHAT_ID  （你的 user id、群组/频道 id，如 123456789、-1001234567890、@channelname）
 * 选填：TELEGRAM_API_BASE（默认 https://api.telegram.org，可填反代地址）
 *
 * 两个必填项缺任意一个就静默跳过，不影响主流程。
 */
const { log, logError } = require('./utils');

const MAX_LEN = 3800; // Telegram 单条上限 4096，留点余量

async function notify(text) {
  const token = (process.env.TG_BOT_TOKEN || '').trim();
  const chatId = (process.env.TG_CHAT_ID || '').trim();

  if (!token || !chatId) {
    log('未配置 TG_BOT_TOKEN / TG_CHAT_ID，跳过 Telegram 通知');
    return false;
  }

  const base = (process.env.TELEGRAM_API_BASE || 'https://api.telegram.org').replace(/\/+$/, '');
  const url = `${base}/bot${token}/sendMessage`;
  const content = text.length > MAX_LEN ? `${text.slice(0, MAX_LEN)}…` : text;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: content,
        disable_web_page_preview: true,
      }),
      signal: AbortSignal.timeout(15000),
    });

    const json = await res.json().catch(() => null);
    if (res.ok && json && json.ok) {
      log('Telegram 通知已发送');
      return true;
    }

    // token 错 / chat_id 错 / 机器人没被拉进群，都会走到这里
    logError(`Telegram 通知失败：HTTP ${res.status} ${json?.description || '(无返回描述)'}`);
    return false;
  } catch (err) {
    logError(
      `Telegram 通知异常：${err.message}（本机在国内网络时通常连不上 api.telegram.org，可配置 TELEGRAM_API_BASE 走反代）`
    );
    return false;
  }
}

module.exports = { notify };

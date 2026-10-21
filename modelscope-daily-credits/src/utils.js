/**
 * 通用小工具：日志、等待、截图、GitHub Actions 输出
 */
const fs = require('fs');
const path = require('path');

const ARTIFACT_DIR = path.resolve(process.cwd(), 'artifacts');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function log(...args) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${ts}]`, ...args);
}

function logError(...args) {
  const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.error(`[${ts}] [ERROR]`, ...args);
}

/** 写 GitHub Actions Step Summary（本地运行时会静默跳过） */
function appendSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    fs.appendFileSync(file, markdown + '\n', 'utf8');
  } catch (err) {
    logError('写入 Step Summary 失败：', err.message);
  }
}

/** 写 GitHub Actions output */
function setOutput(key, value) {
  const file = process.env.GITHUB_OUTPUT;
  if (!file) return;
  try {
    fs.appendFileSync(file, `${key}=${value}\n`, 'utf8');
  } catch (err) {
    logError('写入 GITHUB_OUTPUT 失败：', err.message);
  }
}

/** 截图，失败不抛错（页面崩了也要能报出原始错误） */
async function screenshot(page, name) {
  if (!page) return null;
  try {
    ensureDir(ARTIFACT_DIR);
    const file = path.join(ARTIFACT_DIR, `${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    log(`截图已保存：${file}`);
    return file;
  } catch (err) {
    logError(`截图失败（${name}）：`, err.message);
    return null;
  }
}

/** 保存页面 HTML，便于排查选择器失效 */
async function dumpHtml(page, name) {
  if (!page) return null;
  try {
    ensureDir(ARTIFACT_DIR);
    const html = await page.content();
    const file = path.join(ARTIFACT_DIR, `${name}.html`);
    fs.writeFileSync(file, html, 'utf8');
    log(`HTML 已保存：${file}`);
    return file;
  } catch (err) {
    logError(`保存 HTML 失败（${name}）：`, err.message);
    return null;
  }
}

module.exports = {
  ARTIFACT_DIR,
  sleep,
  ensureDir,
  log,
  logError,
  appendSummary,
  setOutput,
  screenshot,
  dumpHtml,
};

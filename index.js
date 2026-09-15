import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import { firefox } from 'playwright';
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';
import ProxyChain from 'proxy-chain';
import fs from 'fs';
import path from 'path';

dotenv.config();

const BOT_TOKEN = process.env.BOT_TOKEN;
if (!BOT_TOKEN) {
  console.error('ОШИБКА: Не задан BOT_TOKEN');
  process.exit(1);
}

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID ? Number(process.env.ADMIN_CHAT_ID) : null;

const DATA_DIR = process.env.DATA_DIR || '/app/data';
try { fs.mkdirSync(DATA_DIR, { recursive: true }); } catch {}
const PROXY_STATE_FILE = path.join(DATA_DIR, 'proxy.json');
const HTML_DUMP = path.join(DATA_DIR, 'last.html');

const DEFAULT_PROXY_PASS =
  'KbuTHCUaYBbDykhx2j4d_country-RU_city-chelyabinsk_lifetime-5_session-y3rvpjcb';

let CURRENT_PROXY = {
  server: process.env.PROXY_SERVER || 'http://mob.lteboost.com:3000',
  username: process.env.PROXY_USER || 'user_2ce64754',
  password: process.env.PROXY_PASS || DEFAULT_PROXY_PASS,
};

try {
  if (fs.existsSync(PROXY_STATE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(PROXY_STATE_FILE, 'utf8'));
    if (saved.password) CURRENT_PROXY.password = saved.password;
    if (saved.server) CURRENT_PROXY.server = saved.server;
    if (saved.username) CURRENT_PROXY.username = saved.username;
    console.log('[Proxy] Загружен сохранённый пароль');
  }
} catch (e) {
  console.warn('[Proxy] Не загрузить пароль:', e.message);
}

let lastIpChange = 0;

function buildProxyUrl(p) {
  if (!p.username || !p.password) return p.server;
  const u = new URL(p.server);
  u.username = p.username;
  u.password = p.password;
  return u.toString();
}

// ─── ЛОКАЛЬНЫЙ ПРОКСИ-МОСТ ──────────────────────────────────────────────────
let LOCAL_PROXY_URL = null;
let LOCAL_PROXY_SERVER = null;

async function startLocalBridge() {
  if (LOCAL_PROXY_SERVER) {
    try { await ProxyChain.closeAnonymizedProxy(LOCAL_PROXY_SERVER, true); } catch {}
    LOCAL_PROXY_SERVER = null;
    LOCAL_PROXY_URL = null;
  }

  const upstream = buildProxyUrl(CURRENT_PROXY);
  try {
    LOCAL_PROXY_URL = await ProxyChain.anonymizeProxy({
      url: upstream,
      port: 0,
    });
    LOCAL_PROXY_SERVER = LOCAL_PROXY_URL;
    console.log(`[Bridge] Локальный прокси: ${LOCAL_PROXY_URL} → ${upstream.split('@')[1] || upstream}`);
    return LOCAL_PROXY_URL;
  } catch (err) {
    console.error('[Bridge] Ошибка запуска:', err.message);
    return null;
  }
}

function generateSessionId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function buildStickyPassword(baseKey, sessionId) {
  return `${baseKey}_country-RU_city-chelyabinsk_lifetime-5_session-${sessionId}`;
}

function extractSessionId(pwd) {
  const m = pwd.match(/_session-([a-z0-9]+)/i);
  return m ? m[1] : '?';
}

function extractBaseKey(pwd) {
  return pwd.split('_')[0];
}

async function changeProxyIP(ctx = null, force = false) {
  const now = Date.now();
  if (!force && now - lastIpChange < 30000) {
    if (ctx) await ctx.reply('⏳ Подожди 30 сек.');
    return false;
  }
  const baseKey = extractBaseKey(CURRENT_PROXY.password);
  const newSession = generateSessionId();
  const newPass = buildStickyPassword(baseKey, newSession);
  CURRENT_PROXY.password = newPass;
  try {
    fs.writeFileSync(PROXY_STATE_FILE, JSON.stringify(CURRENT_PROXY), 'utf8');
    console.log('[Rotate] Новая сессия:', newSession);
  } catch (e) {
    console.warn('[Rotate] Ошибка:', e.message);
  }

  await startLocalBridge();

  lastIpChange = Date.now();
  if (ctx) await ctx.reply(`🔄 Новая sticky-сессия: ${newSession}`);
  await sleep(5000);
  return true;
}

let currentQuery = '';
let isRunning = false;

const DEFAULT_STOP_DOMAINS = ['sos74.ru', 'xn--74-dlcmol6bgl3g.xn--p1ai'];
let stopDomains = new Set(DEFAULT_STOP_DOMAINS);

const DEFAULT_QUERIES = [
  'вскрытие замка Челябинск',
  'вскрытие двери Челябинск',
  'аварийное вскрытие замков',
  'вызвать мастера по замкам',
  'вскрытие замка круглосуточно',
  'вскрытие замка ночью',
  'ребенок закрылся дома Челябинск',
  'ребенок один в квартире закрыт',
  'захлопнулась дверь с ребенком',
  'сломался замок в двери',
  'заклинило замок',
  'потерял ключи от квартиры',
  'захлопнулась дверь без ключей',
  'сломался ключ в замке',
  'не открывается замок входной двери',
  'вскрытие замка квартиры',
  'вскрытие замка машины Челябинск',
  'вскрытие гаража Челябинск',
  'вскрытие сейфа Челябинск',
  'вскрытие офиса Челябинск',
  'вскрытие замка цена Челябинск',
  'вскрытие замка недорого',
  'вскрытие замка без повреждений',
];

function normalizeDomain(h) {
  let d = h.toLowerCase().replace(/^www\./, '');
  try { d = new URL(`http://${d}`).hostname; } catch {}
  return d;
}

function isStopped(h, set) {
  const d = normalizeDomain(h);
  if (set.has(d)) return true;
  for (const stop of set) {
    if (d === stop || d.endsWith('.' + stop)) return true;
  }
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const AUTO_INTERVAL_HOURS = parseFloat(process.env.AUTO_INTERVAL_HOURS || '3');
const AUTO_ENABLED_DEFAULT = String(process.env.AUTO_ENABLED || 'false').toLowerCase() === 'true';

let autoTimer = null;
let autoEnabled = AUTO_ENABLED_DEFAULT;
let lastAutoRun = null;
let autoRunCount = 0;

function isAdmin(ctx) {
  if (!ADMIN_CHAT_ID) return true;
  return ctx.from?.id === ADMIN_CHAT_ID || ctx.chat?.id === ADMIN_CHAT_ID;
}

function startScheduler() {
  if (autoTimer) clearInterval(autoTimer);
  if (!ADMIN_CHAT_ID) return;
  const intervalMs = AUTO_INTERVAL_HOURS * 60 * 60 * 1000;
  console.log(`[scheduler] Интервал: ${AUTO_INTERVAL_HOURS} ч`);
  autoTimer = setInterval(async () => {
    if (!autoEnabled || isRunning) return;
    const query = DEFAULT_QUERIES[Math.floor(Math.random() * DEFAULT_QUERIES.length)];
    isRunning = true;
    autoRunCount++;
    try {
      await bot.telegram.sendMessage(ADMIN_CHAT_ID, `⏰ Автопрогон #${autoRunCount}\n«${query}»`);
      const report = await runSurf(query, stopDomains, {
        reply: (text, opts) => bot.telegram.sendMessage(ADMIN_CHAT_ID, text, opts),
      });
      await bot.telegram.sendMessage(ADMIN_CHAT_ID, report);
      lastAutoRun = new Date();
    } catch (err) {
      console.error('[scheduler]', err);
    } finally {
      isRunning = false;
    }
  }, intervalMs);
}

function stopScheduler() {
  if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
}

const bot = new Telegraf(BOT_TOKEN);

bot.catch((err, ctx) => {
  console.error('[Telegraf]', err);
  ctx.reply(`⚠️ ${err.message}`).catch(() => {});
});

bot.start((ctx) => {
  ctx.reply(
    `🤖 Бот серфинга (Firefox + Bridge)\n\n` +
    `• Текст = фраза, /run — старт, /stop_run — стоп.\n` +
    `• /queries, /setquery N — список фраз.\n` +
    `• /stop, /stop_reset — стоп-домены.\n` +
    `• /testproxy — диагностика прокси\n` +
    `• /changeip — новая sticky-сессия\n` +
    `• /dumphtml — HTML последнего поиска\n` +
    `• /auto_on, /auto_off, /auto_status\n\n` +
    `Прокси: ${CURRENT_PROXY.server}\n` +
    `Session: ${extractSessionId(CURRENT_PROXY.password)}\n` +
    `Bridge: ${LOCAL_PROXY_URL || '—'}\n` +
    `Фраза: ${currentQuery || '—'}`
  );
});

bot.command('changeip', async (ctx) => { await changeProxyIP(ctx, true); });

// ─── Маскировка для Firefox ─────────────────────────────────────────────────
const STEALTH_SCRIPT = () => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['ru-RU', 'ru', 'en-US', 'en'] });
  Object.defineProperty(navigator, 'platform', { get: () => 'Linux armv8l' });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
};

bot.command('testproxy', async (ctx) => {
  await ctx.reply('🧪 Диагностика (Firefox + мост)...');

  if (!LOCAL_PROXY_URL) await startLocalBridge();
  if (!LOCAL_PROXY_URL) return ctx.reply('❌ Не удалось поднять локальный мост.');

  const urls = [
    'https://api.ipify.org?format=json',
    'https://m.yandex.ru/',
    'https://mail.ru/',
  ];

  let browser;
  try {
    const bridgePort = parseInt(LOCAL_PROXY_URL.split(':').pop());

    browser = await firefox.launch({
      headless: true,
      proxy: { server: LOCAL_PROXY_URL },
      firefoxUserPrefs: {
        'network.proxy.type': 1,
        'network.proxy.http': '127.0.0.1',
        'network.proxy.http_port': bridgePort,
        'network.proxy.ssl': '127.0.0.1',
        'network.proxy.ssl_port': bridgePort,
        'network.proxy.share_proxy_settings': true,
        'network.http.http2.enabled': false,
        'network.http.http3.enabled': false,
      },
    });

    const context = await browser.newContext({
      viewport: { width: 412, height: 915 },
      userAgent: 'Mozilla/5.0 (Android 14; Mobile; rv:124.0) Gecko/124.0 Firefox/124.0',
      locale: 'ru-RU',
      timezoneId: 'Asia/Yekaterinburg',
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 2.625,
      extraHTTPHeaders: { 'Accept-Language': 'ru-RU,ru;q=0.9' },
    });

    await context.addInitScript(STEALTH_SCRIPT);

    const page = await context.newPage();
    const lines = [`Bridge: ${LOCAL_PROXY_URL}`, `Session: ${extractSessionId(CURRENT_PROXY.password)}`, ''];

    for (const url of urls) {
      const t0 = Date.now();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const title = await page.title().catch(() => '');
        lines.push(`✅ ${url} — OK (${Date.now() - t0}ms) ${title.slice(0, 40)}`);
      } catch (e) {
        lines.push(`❌ ${url} — ${e.message.split('\n')[0].slice(0, 70)}`);
      }
    }

    await ctx.reply(lines.join('\n'));
  } catch (e) {
    await ctx.reply(`❌ Ошибка Firefox: ${e.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
});

bot.command('dumphtml', async (ctx) => {
  if (!fs.existsSync(HTML_DUMP)) return ctx.reply('❌ Файл пуст. Сначала /run.');
  const html = fs.readFileSync(HTML_DUMP, 'utf8');
  await ctx.reply(`📄 HTML (первые 3500 из ${html.length}):\n\n${html.slice(0, 3500)}`);
});

bot.command('queries', (ctx) => {
  ctx.reply(DEFAULT_QUERIES.map((q, i) => `${i + 1}. ${q}`).join('\n'));
});

bot.command('setquery', (ctx) => {
  const n = parseInt(ctx.message.text.replace('/setquery', '').trim(), 10);
  if (!n || n < 1 || n > DEFAULT_QUERIES.length) return ctx.reply(`1–${DEFAULT_QUERIES.length}`);
  currentQuery = DEFAULT_QUERIES[n - 1];
  ctx.reply(`✅ «${currentQuery}»`);
});

bot.command('stop', (ctx) => {
  const text = ctx.message.text.replace('/stop', '').trim();
  if (!text) return ctx.reply(`Стоп-домены:\n${[...stopDomains].join('\n')}`);
  const added = text.split(',').map((d) => d.trim().toLowerCase()).filter(Boolean);
  added.forEach((d) => stopDomains.add(normalizeDomain(d)));
  ctx.reply(`✅ Всего: ${stopDomains.size}`);
});

bot.command('stop_reset', (ctx) => {
  stopDomains = new Set(DEFAULT_STOP_DOMAINS);
  ctx.reply('♻️ Сброшено.');
});

bot.command('run', async (ctx) => {
  if (isRunning) return ctx.reply('⚠️ Уже выполняется');
  if (!currentQuery) return ctx.reply('❌ Фраза не задана');
  isRunning = true;
  await ctx.reply(`🚀 Запуск: «${currentQuery}»`);
  try {
    const report = await runSurf(currentQuery, stopDomains, ctx);
    await ctx.reply(report);
  } catch (err) {
    await ctx.reply(`❌ ${err.message}`);
  } finally {
    isRunning = false;
  }
});

bot.command('stop_run', (ctx) => {
  isRunning = false;
  ctx.reply('🛑 Остановлено');
});

bot.command('auto_on', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('⛔ Только админ');
  autoEnabled = true;
  startScheduler();
  await ctx.reply(`✅ Автопрогон включён (каждые ${AUTO_INTERVAL_HOURS} ч)`);
});

bot.command('auto_off', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('⛔ Только админ');
  autoEnabled = false;
  stopScheduler();
  await ctx.reply('⏹ Автопрогон выключен');
});

bot.command('auto_status', async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply('⛔ Только админ');
  await ctx.reply(
    `Статус: ${autoEnabled ? '🟢 Включён' : '🔴 Выключен'}\n` +
    `Интервал: ${AUTO_INTERVAL_HOURS} ч\n` +
    `Запусков: ${autoRunCount}\n` +
    `Последний: ${lastAutoRun ? lastAutoRun.toLocaleString('ru-RU') : '—'}`
  );
});

// ─── СЕРФИНГ ────────────────────────────────────────────────────────────────
async function runSurf(query, stopSet, ctx) {
  const visited = [];
  const actions = [];

  if (ctx?.reply) await ctx.reply('🔄 Свежая sticky-сессия...');
  await changeProxyIP(ctx, true);

  let results = [];
  let lastError = '';

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      results = await searchYandexFirefox(query, ctx);
      break;
    } catch (err) {
      lastError = err.message;
      console.log(`[Search] Попытка ${attempt}: ${err.message}`);
      if (ctx?.reply) await ctx.reply(`🛑 Ошибка (${attempt}/3): ${err.message.slice(0, 100)}`);
      if (attempt < 3) {
        if (ctx?.reply) await ctx.reply('🔄 Меняю sticky-сессию...');
        await changeProxyIP(ctx, true);
      }
      await sleep(7000);
    }
  }

  if (!results.length) {
    return `⚠️ Не удалось получить выдачу.\nОшибка: ${lastError}\n\n/dumphtml`;
  }

  await ctx.reply(`📋 Найдено: ${results.length} сайтов. Обход (HTTP)...`);

  const agent = new HttpsProxyAgent(buildProxyUrl(CURRENT_PROXY));

  for (const item of results) {
    if (!isRunning) break;
    let domain;
    try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch { continue; }

    if (isStopped(domain, stopSet)) {
      actions.push(`⏭️ ${domain} — стоп`);
      continue;
    }

    try {
      await fetch(item.url, {
        agent,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Android 14; Mobile; rv:124.0) Gecko/124.0 Firefox/124.0',
          'Accept-Language': 'ru-RU,ru;q=0.9',
        },
        timeout: 15000,
        redirect: 'follow',
      }).catch(() => {});
      visited.push(domain);
      actions.push(`✅ ${domain} — просмотр`);
    } catch (err) {
      actions.push(`⚠️ ${domain} — сбой`);
    }
    await sleep(2000 + Math.random() * 2000);
  }

  return [
    `📊 Отчёт`,
    `Фраза: «${query}»`,
    `Session: ${extractSessionId(CURRENT_PROXY.password)}`,
    `Посещено: ${visited.length}`,
    ``,
    ...actions,
  ].join('\n');
}

// ─── ПОИСК ЧЕРЕЗ FIREFOX + МОСТ ─────────────────────────────────────────────
async function searchYandexFirefox(query, ctx) {
  if (!LOCAL_PROXY_URL) throw new Error('Локальный мост не поднят');

  const bridgePort = parseInt(LOCAL_PROXY_URL.split(':').pop());

  const browser = await firefox.launch({
    headless: true,
    proxy: { server: LOCAL_PROXY_URL },
    firefoxUserPrefs: {
      'network.proxy.type': 1,
      'network.proxy.http': '127.0.0.1',
      'network.proxy.http_port': bridgePort,
      'network.proxy.ssl': '127.0.0.1',
      'network.proxy.ssl_port': bridgePort,
      'network.proxy.share_proxy_settings': true,
      'network.proxy.no_proxies_on': '',
      'network.http.http2.enabled': false,
      'network.http.http3.enabled': false,
      'network.http.spdy.enabled': false,
      'network.http.spdy.enabled.http2': false,
      'network.http.spdy.enabled.v3-1': false,
      'security.ssl.enable_ocsp_stapling': false,
      'security.enterprise_roots.enabled': true,
    },
  });

  const context = await browser.newContext({
    viewport: { width: 412, height: 915 },
    userAgent: 'Mozilla/5.0 (Android 14; Mobile; rv:124.0) Gecko/124.0 Firefox/124.0',
    locale: 'ru-RU',
    timezoneId: 'Asia/Yekaterinburg',
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2.625,
    extraHTTPHeaders: { 'Accept-Language': 'ru-RU,ru;q=0.9' },
  });

  await context.addInitScript(STEALTH_SCRIPT);

  const page = await context.newPage();

  try {
    // Работаем ТОЛЬКО через m.yandex.ru — десктопная версия через Firefox не открывается
    console.log('[Firefox] Открываю https://m.yandex.ru');
    await page.goto('https://m.yandex.ru', { waitUntil: 'domcontentloaded', timeout: 45000 });
    console.log('[Firefox] OK: m.yandex.ru');

    await page.waitForTimeout(2000);
    let html = await page.content();
    if (html.includes('captcha_smart') || html.includes('Вы не робот')) {
      console.log('[Firefox] SmartCaptcha...');
      const solved = await trySolveCaptcha(page);
      if (!solved) throw new Error('SmartCaptcha не решена');
    }

    console.log('[Firefox] Ввожу запрос');
    const input = page.locator('input[name="text"], input#text, textarea[name="text"]').first();
    await input.waitFor({ timeout: 15000 });
    await input.fill(query);
    await page.waitForTimeout(500 + Math.random() * 500);

    const btn = page.locator('button[type="submit"], button:has-text("Найти")').first();
    if (await btn.isVisible({ timeout: 3000 }).catch(() => false)) await btn.click();
    else await input.press('Enter');

    await page.waitForLoadState('domcontentloaded', { timeout: 30000 });
    await page.waitForTimeout(3000);

    html = await page.content();
    try { fs.writeFileSync(HTML_DUMP, html, 'utf8'); } catch {}

    if (html.includes('captcha_smart') || html.includes('Вы не робот')) {
      throw new Error('SmartCaptcha после поиска');
    }

    const items = await page.evaluate(() => {
      const out = [];
      const seen = new Set();
      const links = document.querySelectorAll('a[href^="http"]');
      links.forEach((a) => {
        const href = a.href;
        if (!href) return;
        if (/yandex\.|ya\.ru|yastatic|yandexcloud/.test(href)) return;
        if (seen.has(href)) return;
        seen.add(href);
        const title = a.textContent.trim() || href;
        if (title.length < 3) return;
        out.push({ url: href, title: title.slice(0, 100) });
      });
      return out.slice(0, 10);
    });

    console.log(`[Firefox] Найдено: ${items.length}`);
    if (items.length === 0) throw new Error('Пустая выдача');
    return items;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function trySolveCaptcha(page) {
  for (let i = 0; i < 5; i++) {
    try {
      const cb = page.locator('.CheckboxCaptcha-Button, input[type="checkbox"]').first();
      if (await cb.isVisible({ timeout: 2000 }).catch(() => false)) {
        await cb.click({ timeout: 3000 });
        console.log('[Captcha] Клик');
        await page.waitForTimeout(3000);
        const html = await page.content();
        if (!html.includes('captcha_smart') && !html.includes('Вы не робот')) return true;
      }
    } catch {}
    await page.waitForTimeout(2000);
  }
  return false;
}

bot.on('text', async (ctx, next) => {
  const text = ctx.message.text.trim();
  if (text.startsWith('/')) return next();
  currentQuery = text;
  await ctx.reply(`✅ Фраза: «${currentQuery}»`);
});

// ─── СТАРТ ──────────────────────────────────────────────────────────────────
(async () => {
  console.log('🚀 Стартую...');
  await startLocalBridge();

  bot.launch()
    .then(() => {
      console.log('✅ Бот запущен (Firefox)');
      console.log(`[Proxy] ${CURRENT_PROXY.server}`);
      console.log(`[Proxy] Session: ${extractSessionId(CURRENT_PROXY.password)}`);
      console.log(`[Bridge] ${LOCAL_PROXY_URL}`);
      if (AUTO_ENABLED_DEFAULT && ADMIN_CHAT_ID) startScheduler();
    })
    .catch((err) => {
      console.error('❌ Ошибка запуска:', err);
      process.exit(1);
    });
})();

process.once('SIGINT', async () => {
  stopScheduler();
  if (LOCAL_PROXY_SERVER) {
    try { await ProxyChain.closeAnonymizedProxy(LOCAL_PROXY_SERVER, true); } catch {}
  }
  bot.stop('SIGINT');
});
process.once('SIGTERM', async () => {
  stopScheduler();
  if (LOCAL_PROXY_SERVER) {
    try { await ProxyChain.closeAnonymizedProxy(LOCAL_PROXY_SERVER, true); } catch {}
  }
  bot.stop('SIGTERM');
});
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));

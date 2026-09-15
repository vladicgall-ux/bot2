import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import { chromium, devices } from 'playwright';
import fetch from 'node-fetch';
import { HttpsProxyAgent } from 'https-proxy-agent';
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
    `🤖 Бот серфинга (Playwright + HTTP)\n\n` +
    `• Текст = фраза, /run — старт, /stop_run — стоп.\n` +
    `• /queries, /setquery N — список фраз.\n` +
    `• /stop, /stop_reset — стоп-домены.\n` +
    `• /testproxy — расширенная диагностика прокси\n` +
    `• /changeip — новая sticky-сессия\n` +
    `• /dumphtml — HTML последнего поиска\n` +
    `• /auto_on, /auto_off, /auto_status\n\n` +
    `Прокси: ${CURRENT_PROXY.server}\n` +
    `Session: ${extractSessionId(CURRENT_PROXY.password)}\n` +
    `Фраза: ${currentQuery || '—'}`
  );
});

bot.command('changeip', async (ctx) => { await changeProxyIP(ctx, true); });

// ─── РАСШИРЕННАЯ ДИАГНОСТИКА ────────────────────────────────────────────────
bot.command('testproxy', async (ctx) => {
  await ctx.reply('🧪 Расширенная диагностика прокси...');

  const urls = [
    'https://api.ipify.org?format=json',
    'https://yandex.ru/',
    'https://m.yandex.ru/',
    'https://mail.ru/',
    'https://vk.com/',
    'https://ozon.ru/',
  ];

  // ─── ТЕСТ 1: fetch + HttpsProxyAgent ─────────────────────────────────────
  const lines1 = ['━━━ ТЕСТ 1: fetch + HttpsProxyAgent ━━━'];
  const agent = new HttpsProxyAgent(buildProxyUrl(CURRENT_PROXY));
  for (const url of urls) {
    const t0 = Date.now();
    try {
      const res = await fetch(url, {
        agent,
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
          'Accept-Language': 'ru-RU,ru;q=0.9',
          'Accept-Encoding': 'identity',
        },
        timeout: 20000,
        redirect: 'follow',
      });
      const body = await res.text();
      lines1.push(`✅ ${url} — ${res.status} (${Date.now() - t0}ms), ${body.length}b`);
    } catch (e) {
      lines1.push(`❌ ${url} — ${e.message.slice(0, 60)}`);
    }
  }
  await ctx.reply(lines1.join('\n'));

  // ─── ТЕСТ 2: Playwright с отключением HTTP/2 и QUIC ─────────────────────
  await ctx.reply('━━━ ТЕСТ 2: Playwright (--disable-http2 --disable-quic) ━━━');

  const lines2 = [];
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      proxy: {
        server: CURRENT_PROXY.server,
        username: CURRENT_PROXY.username,
        password: CURRENT_PROXY.password,
      },
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-http2',
        '--disable-quic',
        '--disable-features=NetworkService,HTTP2',
        '--ignore-certificate-errors',
      ],
    });

    const page = await browser.newPage();

    for (const url of urls) {
      const t0 = Date.now();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const title = await page.title().catch(() => '');
        lines2.push(`✅ ${url} — OK (${Date.now() - t0}ms) ${title.slice(0, 30)}`);
      } catch (e) {
        lines2.push(`❌ ${url} — ${e.message.split('\n')[0].slice(0, 70)}`);
      }
    }
  } catch (e) {
    lines2.push(`❌ Ошибка Playwright: ${e.message}`);
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  await ctx.reply(lines2.join('\n'));

  await ctx.reply(
    '📋 Как читать результат:\n\n' +
    '• ТЕСТ 1 ✅ + ТЕСТ 2 ✅ — всё работает, запускай /run\n' +
    '• ТЕСТ 1 ✅ + ТЕСТ 2 ❌ — проблема в Chromium (HTTP/2/QUIC)\n' +
    '• ТЕСТ 1 ❌ + ТЕСТ 2 ❌ — прокси режет CONNECT или Яндекс банит IP\n' +
    '• yandex ❌, vk/mail ✅ — Яндекс банит IP, нужен новый провайдер'
  );
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

// ─── ЛОГИКА СЕРФИНГА ────────────────────────────────────────────────────────
async function runSurf(query, stopSet, ctx) {
  const visited = [];
  const actions = [];

  if (ctx?.reply) await ctx.reply('🔄 Свежая sticky-сессия...');
  await changeProxyIP(ctx, true);

  let results = [];
  let lastError = '';

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      results = await searchYandexPlaywright(query, CURRENT_PROXY, ctx);
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
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
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

async function searchYandexPlaywright(query, proxy, ctx) {
  const browser = await chromium.launch({
    headless: true,
    proxy: {
      server: proxy.server,
      username: proxy.username,
      password: proxy.password,
    },
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disable-blink-features=AutomationControlled',
      '--disable-http2',
      '--disable-quic',
      '--disable-features=NetworkService,HTTP2',
    ],
  });

  const device = devices['Pixel 7'];
  const context = await browser.newContext({
    ...device,
    locale: 'ru-RU',
    timezoneId: 'Asia/Yekaterinburg',
    geolocation: { latitude: 55.1644, longitude: 61.4368 },
    permissions: ['geolocation'],
    extraHTTPHeaders: { 'Accept-Language': 'ru-RU,ru;q=0.9' },
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  const page = await context.newPage();

  try {
    const targets = ['https://yandex.ru', 'https://m.yandex.ru'];
    let opened = false;
    for (const url of targets) {
      try {
        console.log('[Playwright] Открываю', url);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        console.log('[Playwright] OK:', url);
        opened = true;
        break;
      } catch (e) {
        console.warn('[Playwright] Не открылся', url, ':', e.message.split('\n')[0]);
      }
    }
    if (!opened) throw new Error('Ни yandex.ru, ни m.yandex.ru не открылись');

    await page.waitForTimeout(2000);
    let html = await page.content();
    if (html.includes('captcha_smart') || html.includes('Вы не робот')) {
      console.log('[Playwright] SmartCaptcha...');
      const solved = await trySolveCaptcha(page);
      if (!solved) throw new Error('SmartCaptcha не решена');
    }

    console.log('[Playwright] Ввожу запрос');
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

    console.log(`[Playwright] Найдено: ${items.length}`);
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

bot.launch()
  .then(() => {
    console.log('✅ Бот запущен');
    console.log(`[Proxy] ${CURRENT_PROXY.server}`);
    console.log(`[Proxy] Session: ${extractSessionId(CURRENT_PROXY.password)}`);
    if (AUTO_ENABLED_DEFAULT && ADMIN_CHAT_ID) startScheduler();
  })
  .catch((err) => {
    console.error('❌ Ошибка запуска:', err);
    process.exit(1);
  });

process.once('SIGINT', () => { stopScheduler(); bot.stop('SIGINT'); });
process.once('SIGTERM', () => { stopScheduler(); bot.stop('SIGTERM'); });
process.on('unhandledRejection', (r) => console.error('[unhandledRejection]', r));

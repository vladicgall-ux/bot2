import { Telegraf } from 'telegraf';
import dotenv from 'dotenv';
import { firefox } from 'playwright';
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
    LOCAL_PROXY_URL = await ProxyChain.anonymizeProxy({ url: upstream, port: 0 });
    LOCAL_PROXY_SERVER = LOCAL_PROXY_URL;
    console.log(`[Bridge] ${LOCAL_PROXY_URL} → ${upstream.split('@')[1] || upstream}`);
    return LOCAL_PROXY_URL;
  } catch (err) {
    console.error('[Bridge] Ошибка:', err.message);
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
    `🤖 Бот серфинга (Firefox, МАКСИМАЛЬНО человечный)\n\n` +
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

const STEALTH_SCRIPT = () => {
  Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  Object.defineProperty(navigator, 'plugins', { get: () => [1, 2, 3, 4, 5] });
  Object.defineProperty(navigator, 'languages', { get: () => ['ru-RU', 'ru', 'en-US', 'en'] });
  Object.defineProperty(navigator, 'platform', { get: () => 'Linux armv8l' });
  Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
  Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });
};

const BLOCKED_RESOURCE_TYPES = new Set(['image', 'media', 'font', 'other', 'ping', 'csp_report']);

const BLOCKED_URL_PATTERNS = [
  /google-analytics\.com/i, /googletagmanager\.com/i, /googleadservices\.com/i,
  /googlesyndication\.com/i, /mc\.yandex\.ru/i, /an\.yandex\.ru/i, /yandex\.ru\/metrika/i,
  /top-fwz1\.mail\.ru/i, /vk\.com\/rtrg/i, /vk\.com\/js\/api/i, /facebook\.com\/tr/i,
  /facebook\.net/i, /top\.mail\.ru/i, /counter\.yadro\.ru/i, /tns-counter\.ru/i,
  /adfox\.ru/i, /yieldmo\.com/i, /criteo\./i, /doubleclick\.net/i, /adservice\.google/i,
  /hotjar\.com/i, /sentry\.io/i, /newrelic\.com/i,
];

async function setupContext(context) {
  await context.addInitScript(STEALTH_SCRIPT);
  await context.route('**/*', (route) => {
    const req = route.request();
    if (BLOCKED_RESOURCE_TYPES.has(req.resourceType())) return route.abort();
    const url = req.url();
    for (const pattern of BLOCKED_URL_PATTERNS) {
      if (pattern.test(url)) return route.abort();
    }
    return route.continue();
  });
}

function firefoxPrefs(bridgePort) {
  return {
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
    'security.ssl.enable_ocsp_stapling': false,
    'security.enterprise_roots.enabled': true,
    'permissions.default.image': 2,
    'media.autoplay.default': 5,
    'media.autoplay.blocking_policy': 2,
    'media.volume_scale': '0.0',
    'browser.safebrowsing.malware.enabled': false,
    'browser.safebrowsing.phishing.enabled': false,
  };
}

const USER_AGENTS = [
  'Mozilla/5.0 (Android 14; Mobile; rv:124.0) Gecko/124.0 Firefox/124.0',
  'Mozilla/5.0 (Android 13; Mobile; rv:123.0) Gecko/123.0 Firefox/123.0',
  'Mozilla/5.0 (Android 14; Mobile; rv:125.0) Gecko/125.0 Firefox/125.0',
];

function randomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function buildContextOptions() {
  return {
    viewport: { width: 412, height: 915 },
    userAgent: randomUA(),
    locale: 'ru-RU',
    timezoneId: 'Asia/Yekaterinburg',
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 2.0,
    extraHTTPHeaders: { 'Accept-Language': 'ru-RU,ru;q=0.9' },
  };
}

async function humanScroll(page, totalMs) {
  const start = Date.now();
  while (Date.now() - start < totalMs) {
    const direction = Math.random() < 0.85 ? 1 : -1;
    const step = (200 + Math.random() * 300) * direction;
    await page.evaluate((y) => window.scrollBy({ top: y, behavior: 'smooth' }), step).catch(() => {});
    if (Math.random() < 0.2) {
      await page.waitForTimeout(1500 + Math.random() * 1500);
    } else {
      await page.waitForTimeout(400 + Math.random() * 700);
    }
  }
}

async function humanMouseMove(page) {
  const moves = 3 + Math.floor(Math.random() * 5);
  for (let i = 0; i < moves; i++) {
    const x = 50 + Math.random() * 300;
    const y = 100 + Math.random() * 600;
    await page.mouse.move(x, y, { steps: 5 + Math.floor(Math.random() * 10) }).catch(() => {});
    await page.waitForTimeout(200 + Math.random() * 400);
  }
}

async function tryCloseCookieBanner(page) {
  const texts = ['Принять', 'Согласен', 'Соглашаюсь', 'OK', 'Понятно', 'Хорошо', 'Принимаю', 'Разрешить'];
  for (const t of texts) {
    try {
      const btn = page.locator(`button:has-text("${t}"), a:has-text("${t}")`).first();
      if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
        await humanClick(page, btn);
        console.log(`[Cookie] Клик «${t}»`);
        await page.waitForTimeout(500);
        return true;
      }
    } catch {}
  }
  return false;
}

async function humanClick(page, locator) {
  try {
    await locator.scrollIntoViewIfNeeded({ timeout: 2000 }).catch(() => {});
    await locator.hover({ timeout: 2000 }).catch(() => {});
    await page.waitForTimeout(100 + Math.random() * 250);
    await locator.click({ delay: 80 + Math.random() * 150, timeout: 3000 });
    return true;
  } catch {
    return false;
  }
}

async function tryFillForms(page) {
  const NAME = 'Николай';
  const PHONE = '8908073211';
  const REASON = 'замок заклинил';

  let filled = false;

  const nameSelectors = [
    'input[name="name"]', 'input[name*="name" i]', 'input[id*="name" i]',
    'input[placeholder*="имя" i]', 'input[placeholder*="как вас" i]',
    'input[placeholder*="представ" i]', 'input[name="fio"]', 'input[name*="fio" i]',
    'input[autocomplete="name"]',
  ];
  for (const sel of nameSelectors) {
    try {
      const inp = page.locator(sel).first();
      if (await inp.isVisible({ timeout: 500 }).catch(() => false)) {
        await inp.scrollIntoViewIfNeeded().catch(() => {});
        await inp.click({ timeout: 1500 });
        await page.waitForTimeout(200 + Math.random() * 200);
        for (const ch of NAME) await inp.type(ch, { delay: 60 + Math.random() * 80 });
        console.log(`[Form] Имя: ${NAME}`);
        filled = true;
        await page.waitForTimeout(300 + Math.random() * 300);
        break;
      }
    } catch {}
  }

  const phoneSelectors = [
    'input[type="tel"]', 'input[name*="phone" i]', 'input[name*="tel" i]',
    'input[id*="phone" i]', 'input[id*="tel" i]', 'input[placeholder*="телефон" i]',
    'input[placeholder*="тел." i]', 'input[placeholder*="+7" i]', 'input[autocomplete="tel"]',
  ];
  for (const sel of phoneSelectors) {
    try {
      const inp = page.locator(sel).first();
      if (await inp.isVisible({ timeout: 500 }).catch(() => false)) {
        await inp.scrollIntoViewIfNeeded().catch(() => {});
        await inp.click({ timeout: 1500 });
        await page.waitForTimeout(200 + Math.random() * 200);
        await inp.fill('').catch(() => {});
        for (const ch of PHONE) await inp.type(ch, { delay: 80 + Math.random() * 100 });
        console.log(`[Form] Телефон: ${PHONE}`);
        filled = true;
        await page.waitForTimeout(300 + Math.random() * 300);
        break;
      }
    } catch {}
  }

  const reasonSelectors = [
    'textarea[name*="message" i]', 'textarea[name*="comment" i]', 'textarea[name*="text" i]',
    'textarea[name*="description" i]', 'textarea[placeholder*="сообщение" i]',
    'textarea[placeholder*="комментар" i]', 'textarea[placeholder*="опишите" i]',
    'textarea[placeholder*="проблем" i]', 'textarea[placeholder*="задач" i]',
    'input[name*="message" i]', 'input[name*="comment" i]',
    'input[placeholder*="сообщение" i]', 'input[placeholder*="опишите" i]',
    'textarea',
  ];
  for (const sel of reasonSelectors) {
    try {
      const inp = page.locator(sel).first();
      if (await inp.isVisible({ timeout: 500 }).catch(() => false)) {
        await inp.scrollIntoViewIfNeeded().catch(() => {});
        await inp.click({ timeout: 1500 });
        await page.waitForTimeout(200 + Math.random() * 200);
        await inp.fill('').catch(() => {});
        for (const ch of REASON) await inp.type(ch, { delay: 50 + Math.random() * 80 });
        console.log(`[Form] Причина: ${REASON}`);
        filled = true;
        await page.waitForTimeout(300 + Math.random() * 300);
        break;
      }
    } catch {}
  }

  return filled;
}

async function trySubmitForm(page) {
  const submitSelectors = [
    'form button[type="submit"]',
    'form input[type="submit"]',
    'button:has-text("Отправить")',
    'button:has-text("Отправить заявку")',
    'button:has-text("Заказать звонок")',
    'button:has-text("Жду звонка")',
    'button:has-text("Перезвоните")',
    'button:has-text("Перезвонить")',
    'button:has-text("Вызвать мастера")',
    'button:has-text("Оставить заявку")',
    'button:has-text("Отправить заявку")',
    'input[value*="Отправить" i]',
    'input[value*="Перезвон" i]',
    'input[value*="Заказать" i]',
    'form button:not([type="button"])',
  ];

  for (const sel of submitSelectors) {
    try {
      const btns = page.locator(sel);
      const count = await btns.count().catch(() => 0);
      for (let i = 0; i < count; i++) {
        const btn = btns.nth(i);
        if (!(await btn.isVisible({ timeout: 500 }).catch(() => false))) continue;
        if (!(await btn.isEnabled({ timeout: 500 }).catch(() => false))) continue;

        const txt = await btn.innerText().catch(() => '');
        if (/отмена|закрыть|close|cancel/i.test(txt)) continue;

        console.log(`[Form] Нажимаю «${txt.slice(0, 30)}»`);

        page.once('dialog', async (dialog) => {
          console.log(`[Form] Dialog: ${dialog.type()}`);
          await dialog.dismiss().catch(() => {});
        });

        await btn.scrollIntoViewIfNeeded().catch(() => {});
        await btn.hover({ timeout: 1500 }).catch(() => {});
        await page.waitForTimeout(100 + Math.random() * 200);
        await btn.click({ delay: 80 + Math.random() * 150, timeout: 3000 });

        await page.waitForTimeout(2000 + Math.random() * 1000);
        return txt.slice(0, 30) || 'кнопка';
      }
    } catch {}
  }
  return null;
}

async function tryClickInternalLink(page, hostname) {
  try {
    const links = await page.evaluate((host) => {
      const out = [];
      const as = document.querySelectorAll('a[href]');
      for (const a of as) {
        const href = a.getAttribute('href') || '';
        if (href.startsWith('#') || href.startsWith('tel:') || href.startsWith('mailto:')) continue;
        try {
          const abs = new URL(href, location.href);
          if (abs.hostname.replace(/^www\./, '') !== host) continue;
          if (abs.href === location.href) continue;
          const text = (a.textContent || '').trim();
          if (text.length < 3 || text.length > 60) continue;
          out.push({ href: abs.href, text });
        } catch {}
      }
      return out.slice(0, 20);
    }, hostname);

    if (!links.length) return null;
    const interesting = links.filter((l) => /услуг|цен|контакт|о нас|заказ|вызов|вскрыт|работ/i.test(l.text));
    const pool = interesting.length ? interesting : links;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    await page.goto(pick.href, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1000 + Math.random() * 1000);
    console.log(`[Link] Перешёл на «${pick.text}»`);
    return pick.text;
  } catch (e) {
    console.log('[Link] ошибка:', e.message);
    return null;
  }
}

bot.command('testproxy', async (ctx) => {
  await ctx.reply('🧪 Диагностика (Firefox + мост + блокировка)...');
  if (!LOCAL_PROXY_URL) await startLocalBridge();
  if (!LOCAL_PROXY_URL) return ctx.reply('❌ Не удалось поднять локальный мост.');

  const urls = ['https://api.ipify.org?format=json', 'https://m.yandex.ru/', 'https://mail.ru/'];
  let browser;
  try {
    const bridgePort = parseInt(LOCAL_PROXY_URL.split(':').pop());
    browser = await firefox.launch({
      headless: true,
      proxy: { server: LOCAL_PROXY_URL },
      firefoxUserPrefs: firefoxPrefs(bridgePort),
    });
    const context = await browser.newContext(buildContextOptions());
    await setupContext(context);
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

bot.command('stop_run', (ctx) => { isRunning = false; ctx.reply('🛑 Остановлено'); });

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

// ─── СЕРФИНГ (один browser + один context на весь обход) ────────────────────
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

  results.sort(() => Math.random() - 0.5);

  await ctx.reply(`📋 Найдено: ${results.length} сайтов. Обход через Firefox (человечно)...`);

  const bridgePort = parseInt(LOCAL_PROXY_URL.split(':').pop());

  // ОДИН browser и ОДИН context на весь обход
  let browser = await firefox.launch({
    headless: true,
    proxy: { server: LOCAL_PROXY_URL },
    firefoxUserPrefs: firefoxPrefs(bridgePort),
  });

  let context = await browser.newContext(buildContextOptions());
  await setupContext(context);

  try {
    for (const item of results) {
      if (!isRunning) break;

      // Проверяем, жив ли браузер. Если нет — пересоздаём.
      if (!browser.isConnected()) {
        console.log('[Firefox] Браузер упал, пересоздаю...');
        if (ctx?.reply) await ctx.reply('⚠️ Firefox упал, пересоздаю...');
        try { await browser.close().catch(() => {}); } catch {}
        browser = await firefox.launch({
          headless: true,
          proxy: { server: LOCAL_PROXY_URL },
          firefoxUserPrefs: firefoxPrefs(bridgePort),
        });
        context = await browser.newContext(buildContextOptions());
        await setupContext(context);
      }

      let domain, hostname;
      try {
        hostname = new URL(item.url).hostname.replace(/^www\./, '');
        domain = hostname;
      } catch { continue; }

      if (isStopped(domain, stopSet)) {
        actions.push(`⏭️ ${domain} — стоп`);
        continue;
      }

      const page = await context.newPage();

      try {
        console.log(`[Firefox] Открываю ${domain}`);

        let loaded = false;
        for (let tryNum = 1; tryNum <= 2; tryNum++) {
          try {
            await page.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 35000 });
            loaded = true;
            break;
          } catch (e) {
            console.log(`[Firefox] ${domain} попытка ${tryNum}: ${e.message.split('\n')[0]}`);
            if (tryNum === 2) throw e;
            await sleep(2000);
          }
        }
        if (!loaded) throw new Error('Не загрузилось');

        await page.waitForTimeout(1000 + Math.random() * 1000);
        await tryCloseCookieBanner(page);

        const totalTime = 8000 + Math.random() * 4000;
        const half = totalTime / 2;
        await humanScroll(page, half);
        await humanMouseMove(page);
        await humanScroll(page, half);

        let visitedInner = null;
        if (Math.random() < 0.3) {
          visitedInner = await tryClickInternalLink(page, hostname);
          if (visitedInner) {
            await humanScroll(page, 3000 + Math.random() * 2000);
          }
        }

        let action = 'просмотр';
        let clickedCTA = false;
        const tel = page.locator('a[href^="tel:"]').first();
        if (await tel.isVisible({ timeout: 2000 }).catch(() => false)) {
          if (await humanClick(page, tel)) {
            await page.waitForTimeout(1500);
            action = 'клик «Позвонить»';
            clickedCTA = true;
          }
        } else {
          const cta = page.locator(
            'button:has-text("Заказать"), a:has-text("Заказать"), ' +
            'button:has-text("Оставить заявку"), a:has-text("Оставить заявку"), ' +
            'button:has-text("Обратная связь"), a:has-text("Обратная связь"), ' +
            'button:has-text("Связаться"), a:has-text("Связаться"), ' +
            'button:has-text("Позвонить"), a:has-text("Позвонить"), ' +
            'button:has-text("Вызвать мастера"), a:has-text("Вызвать мастера")'
          );
          const cnt = await cta.count().catch(() => 0);
          for (let i = 0; i < cnt; i++) {
            const b = cta.nth(i);
            if (await b.isVisible({ timeout: 800 }).catch(() => false)) {
              try {
                const txt = await b.innerText().catch(() => 'кнопка');
                if (await humanClick(page, b)) {
                  await page.waitForTimeout(1500);
                  action = `клик «${txt.slice(0, 30)}»`;
                  clickedCTA = true;
                  break;
                }
              } catch {}
            }
          }
        }

        let filledForm = false;
        let submittedForm = null;
        if (clickedCTA || Math.random() < 0.2) {
          await page.waitForTimeout(1000);
          filledForm = await tryFillForms(page);

          if (filledForm && Math.random() < 0.8) {
            await page.waitForTimeout(500 + Math.random() * 500);
            submittedForm = await trySubmitForm(page);
          }
        }

        let line = `✅ ${domain} — ${action}`;
        const extras = [];
        if (visitedInner) extras.push(`+стр. «${visitedInner.slice(0, 20)}»`);
        if (filledForm) extras.push('+форма: Николай');
        if (submittedForm) extras.push(`+отправлено «${submittedForm}»`);
        if (extras.length) line += ' _(' + extras.join(', ') + ')_';

        visited.push(domain);
        actions.push(line);
      } catch (err) {
        const shortErr = err.message.split('\n')[0].slice(0, 60);
        console.log(`[Visit] ${domain}: ${shortErr}`);
        actions.push(`⚠️ ${domain} — ${shortErr}`);
      } finally {
        await page.close().catch(() => {});
      }

      await sleep(2000 + Math.random() * 3000);
    }
  } finally {
    try { await context.close().catch(() => {}); } catch {}
    try { await browser.close().catch(() => {}); } catch {}
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

// ─── ПОИСК ЧЕРЕЗ FIREFOX ────────────────────────────────────────────────────
async function searchYandexFirefox(query, ctx) {
  if (!LOCAL_PROXY_URL) throw new Error('Локальный мост не поднят');

  const bridgePort = parseInt(LOCAL_PROXY_URL.split(':').pop());

  const browser = await firefox.launch({
    headless: true,
    proxy: { server: LOCAL_PROXY_URL },
    firefoxUserPrefs: firefoxPrefs(bridgePort),
  });

  const context = await browser.newContext(buildContextOptions());
  await setupContext(context);
  const page = await context.newPage();

  try {
    console.log('[Firefox] Прогрев m.yandex.ru');
    await page.goto('https://m.yandex.ru', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000 + Math.random() * 1500);

    let html = await page.content();
    if (html.includes('captcha_smart') || html.includes('Вы не робот')) {
      console.log('[Firefox] SmartCaptcha на главной...');
      const solved = await trySolveCaptcha(page);
      if (!solved) throw new Error('SmartCaptcha на главной');
      await page.waitForTimeout(2000);
    }

    const searchUrl = `https://m.yandex.ru/search/?text=${encodeURIComponent(query)}&lr=74`;
    console.log('[Firefox] Открываю выдачу:', searchUrl);

    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(3000 + Math.random() * 2000);

    html = await page.content();
    try { fs.writeFileSync(HTML_DUMP, html, 'utf8'); } catch {}

    if (html.includes('captcha_smart') || html.includes('Вы не робот')) {
      console.log('[Firefox] SmartCaptcha на выдаче...');
      const solved = await trySolveCaptcha(page);
      if (!solved) throw new Error('SmartCaptcha после поиска');
      await page.waitForTimeout(3000);
      html = await page.content();
      try { fs.writeFileSync(HTML_DUMP, html, 'utf8'); } catch {}
    }

    const items = await page.evaluate(() => {
      const out = [];
      const seenDomains = new Set();
      const links = document.querySelectorAll('a[href^="http"]');
      links.forEach((a) => {
        const href = a.href;
        if (!href) return;
        if (/yandex\.|ya\.ru|yastatic|yandexcloud/.test(href)) return;
        let hostname = '';
        try { hostname = new URL(href).hostname.replace(/^www\./, ''); } catch { return; }
        if (!hostname || seenDomains.has(hostname)) return;
        seenDomains.add(hostname);
        const title = a.textContent.trim() || href;
        if (title.length < 3) return;
        out.push({ url: href, title: title.slice(0, 100) });
      });
      return out.slice(0, 10);
    });

    console.log(`[Firefox] Найдено уникальных доменов: ${items.length}`);
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

(async () => {
  console.log('🚀 Стартую...');
  await startLocalBridge();

  bot.launch()
    .then(() => {
      console.log('✅ Бот запущен (Firefox, один context)');
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

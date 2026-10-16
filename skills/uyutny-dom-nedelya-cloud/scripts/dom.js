#!/usr/bin/env node
// «Уютный дом» в облаке: headless Chromium (Playwright), вход по cookies. Только чтение VK (статистика, очередь) и Gemini.
//   VK     - VK_COOKIES (строка заголовка Cookie, JSON Cookie-Editor или cookies.txt);
//   Gemini - GOOGLE_COOKIES (или любая переменная с GOOGLE/GEMINI в имени), cookies .google.com.
// Часовой пояс браузера - Europe/Moscow, поэтому все даты и время в командах - по МСК.
//
// Команды (вывод короткий, для чтения агентом; рабочие файлы - в $VK_DIR):
//   node dom.js check                                   - вход в VK и в Gemini
//   node dom.js postponed                               - отложенные посты: «дата время | первая строка»
//   node dom.js clips-postponed                         - отложенные клипы: даты
//   node dom.js stats                                   - статистика за 7 дней -> $VK_DIR/stats_<дата>.txt
//   node dom.js gemini <промпт.txt> <out.png> [url_чата] - картинка в Gemini
//   node dom.js inspect <url>                           - скриншот + data-testid (для починки)
//

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function loadPlaywright() {
  try { return require('playwright'); } catch (_) {}
  return require(path.join(execSync('npm root -g').toString().trim(), 'playwright'));
}
const pw = loadPlaywright();

const DIR = process.env.VK_DIR || path.join(process.cwd(), 'vk-run');
fs.mkdirSync(DIR, { recursive: true });
const BASE = 'https://vk.ru';
const GROUP = 55440514;
const SCREEN = 'creativsss';
const GEMINI_CHAT = 'https://gemini.google.com/app/df83e17656670416';
const CHROME = process.env.CHROME_PATH || '/opt/pw-browsers/chromium';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cut = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);
const proxy = () => process.env.HTTPS_PROXY || process.env.https_proxy;
const file = n => path.join(DIR, n);
const readJson = (p, d) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return d; } };
const log = s => fs.appendFileSync(file('dom.log'), `${new Date().toISOString()} ${s}\n`);
// VK не принимает файлы с кириллицей в имени (форма остаётся пустой) - загружаем копию с латинским именем.
const asciiCopy = src => { const dst = file('upload' + path.extname(src).toLowerCase()); fs.copyFileSync(path.resolve(src), dst); return dst; };

const MON_NOM = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
const MON_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MON_SHORT = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

// ---------- cookies ----------
function parseCookies(raw, domains, varName) {
  raw = (raw || '').trim();
  if (!raw) throw new Error(`${varName} пустая: добавьте cookies в переменные окружения и начните новую сессию`);
  const okDomain = d => domains.some(x => (d || '').replace(/^\./, '').endsWith(x));
  let list = [];
  if (raw.startsWith('[') || raw.startsWith('{')) {
    const j = JSON.parse(raw);
    list = (Array.isArray(j) ? j : j.cookies || []).map(c => ({
      name: c.name, value: String(c.value), domain: c.domain, path: c.path || '/',
      secure: !!c.secure, httpOnly: !!c.httpOnly, expires: c.expirationDate || c.expires || -1,
    }));
  } else if (!raw.includes('\t')) {
    // Поддомены уже перечисленных доменов пропускаем: дубли cookies на .google.com и .gemini.google.com дают CookieMismatch.
    const roots = domains.filter(d => !domains.some(o => o !== d && d.endsWith('.' + o)));
    for (const part of raw.replace(/^cookie:\s*/i, '').split(/;\s*/)) {
      const i = part.indexOf('=');
      if (i > 0) for (const d of roots) list.push({ name: part.slice(0, i).trim(), value: part.slice(i + 1).trim(), domain: '.' + d, path: '/', secure: true, expires: -1 });
    }
  } else {
    for (let l of raw.split(/\r?\n/)) {
      const httpOnly = l.startsWith('#HttpOnly_');
      if (httpOnly) l = l.slice(10);
      if (!l || l.startsWith('#')) continue;
      const p = l.split('\t');
      if (p.length >= 7) list.push({ domain: p[0], path: p[2], secure: p[3] === 'TRUE', expires: Number(p[4]) || -1, name: p[5], value: p[6], httpOnly });
    }
  }
  return list.filter(c => c.name && okDomain(c.domain)).map(c => {
    const o = { ...c, expires: c.expires > 0 ? Math.floor(c.expires) : -1, sameSite: 'Lax' };
    // Cookies с префиксом __Host- нельзя ставить на домен с точкой.
    if (o.name.startsWith('__Host-')) { o.domain = o.domain.replace(/^\./, ''); o.path = '/'; o.secure = true; }
    if (o.name.startsWith('__Secure-')) o.secure = true;
    return o;
  });
}
function googleVar() {
  if (process.env.GOOGLE_COOKIES) return 'GOOGLE_COOKIES';
  return Object.keys(process.env).find(k => /GEMINI|GOOGLE/i.test(k) && /COOK/i.test(k))
    || Object.keys(process.env).find(k => /GEMINI/i.test(k)) || null;
}

async function open({ vk = true, google = false } = {}) {
  // Полный Chromium, а не headless_shell: в headless_shell Gemini отдаёт урезанную страницу без поля ввода.
  const opts = proxy() ? { proxy: { server: proxy() } } : {};
  if (fs.existsSync(CHROME)) opts.executablePath = CHROME;
  const browser = await pw.chromium.launch(opts);
  const ctx = await browser.newContext({
    locale: 'ru-RU', timezoneId: 'Europe/Moscow', userAgent: UA,
    viewport: { width: 1366, height: 1000 }, acceptDownloads: true,
  });
  if (vk) await ctx.addCookies(parseCookies(process.env.VK_COOKIES, ['vk.ru', 'vk.com'], 'VK_COOKIES'));
  if (google) {
    const v = googleVar();
    if (!v) throw new Error('нет переменной с cookies Gemini (GOOGLE_COOKIES): добавьте её и начните новую сессию');
    await ctx.addCookies(parseCookies(process.env[v], ['google.com', 'gemini.google.com'], v));
  }
  const page = await ctx.newPage();
  return { browser, ctx, page };
}

async function go(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(3500);
}
// Прямой goto на многие страницы VK отдаёт пустую main.php - переходим внутри SPA через временную ссылку.
async function spaGo(page, p) {
  if (!/vk\.(ru|com)\/(feed|im|id\d)/.test(page.url())) await go(page, `${BASE}/feed`);
  await page.evaluate(h => { const a = document.createElement('a'); a.href = h; a.id = '__spa_go'; a.textContent = '.'; a.style.cssText = 'position:fixed;left:0;top:0;z-index:99999'; document.body.appendChild(a); }, p);
  await page.click('#__spa_go');
  await page.waitForTimeout(6000);
}
const bodyText = page => page.locator('body').innerText().catch(() => '');
const shot = (page, n = 'last.png') => page.screenshot({ path: file(n) }).catch(() => {});

async function isLoggedOut(page) {
  if (/\/(login|join)|id\.vk\.(ru|com)\/auth/.test(page.url())) return true;
  const t = await bodyText(page);
  return /Вход ВКонтакте|Войти другим способом/.test(t) && !/Мессенджер|Профиль/.test(t);
}
async function isCaptcha(page) {
  return (await page.locator('img[src*="captcha"], iframe[src*="captcha"], [class*="Captcha"]').count()) > 0
    || /Введите код с картинки|подтвердите, что вы не робот|Я не робот/i.test(await bodyText(page));
}

// ---------- дата и время ----------
function parseWhen(date, time) {
  const m = String(date).match(/^(\d{4})-(\d{2})-(\d{2})$/), t = String(time).match(/^(\d{1,2}):(\d{2})$/);
  if (!m || !t) throw new Error('дата ГГГГ-ММ-ДД и время ЧЧ:ММ (МСК)');
  const w = { y: +m[1], mo: +m[2] - 1, d: +m[3], h: +t[1], mi: +t[2] };
  // Сейчас по МСК (UTC+3, без перехода на летнее время).
  const now = new Date(Date.now() + 3 * 3600e3);
  const target = Date.UTC(w.y, w.mo, w.d, w.h, w.mi);
  if (target <= +now + 10 * 60e3) throw new Error(`время ${date} ${time} МСК уже прошло или ближе 10 минут`);
  return w;
}
// Текст кнопки даты VK: «20 окт в 9:00», «Сегодня в 10:15», «Завтра в 9:00».
function whenMatches(btn, w) {
  btn = (btn || '').replace(/ /g, ' ').toLowerCase();
  const hm = `${w.h}:${String(w.mi).padStart(2, '0')}`;
  const tm = btn.match(/в\s+0?(\d{1,2}:\d{2})/);
  if (!tm || tm[1] !== hm) return false;
  const now = new Date(Date.now() + 3 * 3600e3);
  const dayDiff = Math.round((Date.UTC(w.y, w.mo, w.d) - Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) / 864e5);
  if (/сегодня/.test(btn)) return dayDiff === 0;
  if (/завтра/.test(btn)) return dayDiff === 1;
  return new RegExp(`(^|\\D)${w.d}\\s+${MON_SHORT[w.mo]}`).test(btn);
}

// Календарь VK (одинаковый у постов и клипов, отличается префикс data-testid).
async function pickInDropdown(page, input, val) {
  for (let k = 0; k < 3; k++) {
    await input.click();
    await page.waitForTimeout(700);
    const re = new RegExp(`^0?${Number(val)}$`);
    const opt = page.locator('[role=option]').filter({ hasText: re }).first();
    if (await opt.count()) { await opt.scrollIntoViewIfNeeded().catch(() => {}); await opt.click(); await page.waitForTimeout(500); return true; }
    await page.keyboard.press('Escape'); await page.waitForTimeout(400);
  }
  return false;
}
async function setCalendar(page, pfx, w) {
  // pfx: 'posting_postponed_calendar' или 'clips-upload-calendar'
  const sep = pfx.includes('_') ? '_' : '-';
  const monthIn = page.locator(`[data-testid="${pfx}${sep}month${pfx.includes('_') ? '_dropdown' : ''}"]`).first();
  const next = page.locator(`[data-testid="${pfx}${sep}next${sep}month"]`).first();
  for (let i = 0; i < 13; i++) {
    const v = (await monthIn.inputValue().catch(() => '')).toLowerCase();
    if (v === MON_NOM[w.mo]) break;
    if (!(await next.count())) break;
    await next.click(); await page.waitForTimeout(500);
  }
  const day = page.locator(`[data-testid="${pfx}${sep}day"]`).filter({ hasText: new RegExp(`, ${w.d} ${MON_GEN[w.mo]}`) }).first();
  if (!(await day.count())) return 'нет дня в календаре';
  await day.click(); await page.waitForTimeout(500);
  const hours = page.locator('input[aria-label="Изменить час"]').first();
  const mins = page.locator('input[aria-label="Изменить минуту"]').first();
  if (!(await pickInDropdown(page, hours, w.h))) return 'не выбран час';
  if (!(await pickInDropdown(page, mins, w.mi))) return 'не выбраны минуты';
  return 'ok';
}

// ---------- статус пакетов ----------
const statusPath = () => file('status.json');
function setStatus(kind, code, status, extra = '') {
  const s = readJson(statusPath(), {});
  s[`${kind}:${code}`] = { status, extra: cut(extra, 200), at: new Date().toISOString() };
  fs.writeFileSync(statusPath(), JSON.stringify(s, null, 1));
}
const getStatus = (kind, code) => (readJson(statusPath(), {})[`${kind}:${code}`] || {}).status;

// ---------- пост в отложенные ----------
async function postponedCount(page) {
  const t = await page.locator('[data-testid="right-menu-filter-postponed"]').first().innerText().catch(() => '');
  return parseInt((t.match(/\d+/) || ['0'])[0], 10);
}
// Список отложенных постов. Лента виртуальная: при прокрутке верхние посты пропадают из DOM,
// поэтому собираем на каждом шаге.
async function listPostponed(page) {
  const seen = new Map();
  const total = await postponedCount(page);
  for (let i = 0; i < 25; i++) {
    const rows = await page.evaluate(() => [...document.querySelectorAll('[data-testid="post"]')].map(p => {
      const d = ((p.querySelector('[data-testid="post-header-subtitle-date"]') || {}).innerText || '?').replace(/ /g, ' ');
      const t = ((p.querySelector('[data-testid="post_text"]') || {}).innerText || '').split('\n').map(x => x.trim()).find(Boolean) || '';
      return [d + '|' + t.slice(0, 60), d, t];
    }));
    rows.forEach(([k, d, t]) => seen.set(k, { date: d, first: t }));
    if (seen.size >= total) break;
    await page.mouse.wheel(0, 1500); await page.waitForTimeout(1200);
  }
  await page.mouse.wheel(0, -100000); await page.waitForTimeout(800);
  return { total, items: [...seen.values()] };
}

async function postOne(page, img, textFile, date, time, dry) {
  const w = parseWhen(date, time);
  const text = fs.readFileSync(textFile, 'utf8').replace(/\r/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (!fs.existsSync(img)) return ['UNKNOWN', 'нет файла ' + img];
  await spaGo(page, `/wall-${GROUP}?postponed=1`);
  if (await isLoggedOut(page)) return ['NOT_LOGGED_IN'];
  if (await isCaptcha(page)) return ['CAPTCHA'];
  const before = await postponedCount(page);
  const firstLine = cut(text.split('\n')[0], 60);
  const queued = await listPostponed(page);
  if (queued.items.some(p => cut(p.first, 60) === firstLine)) return ['QUEUED', 'уже в отложенных (по первой строке), повторно не ставлю'];

  await page.getByText('Создать пост', { exact: true }).first().click();
  // После пробного прогона VK предлагает открыть сохранённый черновик - начинаем заново.
  const restart = page.getByText('Начать заново', { exact: true });
  for (let i = 0; i < 6; i++) {
    if (await restart.isVisible().catch(() => false)) { await restart.click(); await page.waitForTimeout(1500); break; }
    if (await page.locator('[aria-label="Форма постинга"]').isVisible().catch(() => false)) break;
    await page.waitForTimeout(500);
  }
  const form = page.locator('[aria-label="Форма постинга"]');
  await form.waitFor({ timeout: 15000 });
  await page.waitForTimeout(1500);
  // VK может восстановить черновик: убираем старые вложения.
  for (let i = 0; i < 10 && (await form.locator('[data-testid="posting_attachment_photo_item_remove"]').count()); i++) {
    await form.locator('[data-testid="posting_attachment_photo_item_remove"]').first().click(); await page.waitForTimeout(500);
  }
  await form.locator('[data-testid="posting_base_screen_download_from_device"]').setInputFiles(asciiCopy(img));
  for (let i = 0; i < 20 && !(await form.locator('[data-testid="posting_attachment_item"]').count()); i++) await page.waitForTimeout(1000);
  await page.waitForTimeout(3000);
  let n = await form.locator('[data-testid="posting_attachment_item"]').count();
  // Сбой загрузки иногда прикрепляет фото дважды - лишнее удаляем.
  for (let i = 0; n > 1 && i < 5; i++) {
    await form.locator('[data-testid="posting_attachment_photo_item_remove"]').last().click(); await page.waitForTimeout(800);
    n = await form.locator('[data-testid="posting_attachment_item"]').count();
  }
  if (n !== 1) return ['DUP_PHOTO', `фото в форме: ${n}`];

  const ed = form.locator('[contenteditable=true]').first();
  await ed.click();
  await page.keyboard.press('Control+A'); await page.keyboard.press('Delete');
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) await page.keyboard.insertText(lines[i]);
    if (i < lines.length - 1) { await page.keyboard.press('Shift+Enter'); await page.waitForTimeout(30); }
  }
  await page.waitForTimeout(800);
  const typed = (await ed.innerText().catch(() => '')).replace(/\s+/g, ' ');
  const probe = cut(lines.filter(Boolean).pop(), 30);
  const times = typed.split(firstLine).length - 1;
  if (times !== 1 || !typed.includes(probe)) return ['TEXT_FAIL', `первая строка в поле ${times} раз, конец найден: ${typed.includes(probe)}`];

  await form.locator('[data-testid="posting_base_screen_next"]').click();
  await page.waitForTimeout(2500);
  await page.locator('[data-testid="posting_postponed_button"]').click();
  await page.locator('[data-testid="posting_postponed_calendar"]').waitFor({ timeout: 10000 }).catch(() => {});
  const cal = await setCalendar(page, 'posting_postponed_calendar', w);
  const btn = await page.locator('[data-testid="posting_postponed_button"]').innerText().catch(() => '');
  if (cal !== 'ok' || !whenMatches(btn, w)) return ['DATE_FAIL', `${cal}, кнопка «${cut(btn, 40)}»`];
  if (dry) return ['DRY_OK', `«${cut(btn, 30)}», фото 1, текст ок`];

  const add = page.locator('[data-testid="posting_postponed_publish_button"]');
  // Первый клик иногда только закрывает календарь.
  for (let k = 0; k < 3 && (await form.count()); k++) {
    if (!(await add.count())) break;
    await add.scrollIntoViewIfNeeded().catch(() => {});
    await add.click().catch(() => {});
    await page.waitForTimeout(4000);
    if (/Неизвестная ошибка|Повторите попытку позже/i.test(await bodyText(page))) return ['VK_ERROR', 'Неизвестная ошибка VK'];
  }
  if (await form.count()) return ['UNKNOWN', 'форма не закрылась'];
  await page.waitForTimeout(2000);
  const after = await postponedCount(page);
  return after > before ? ['QUEUED', `«${cut(btn, 30)}», отложенных ${before}→${after}`] : ['UNKNOWN', `счётчик отложенных не вырос (${before}→${after})`];
}

// ---------- клип ----------
async function deleteUploadForm(page, form) {
  const del = form.locator('[data-testid="clips-uploadForm-delete-button"]').first();
  if (!(await del.count())) return false;
  await del.click(); await page.waitForTimeout(1200);
  const yes = page.locator('[data-testid="delete-upload-modal-button-delete"]').first();
  if (await yes.count()) { await yes.click(); await page.waitForTimeout(2500); return true; }
  return false;
}
// Музыка из библиотеки VK: поиск по настроению, первый доступный трек
// (строки «Звук клипа недоступен» пропускаем). Возвращает «Название - Исполнитель» или null.
async function closeModals(page) {
  for (let i = 0; i < 3; i++) {
    const x = page.locator('[role=dialog] [data-testid="modal-close-button"], [role=dialog] [aria-label="Закрыть"]').filter({ visible: true }).first();
    if (!(await x.count())) break;
    await x.click().catch(() => {}); await page.waitForTimeout(800);
  }
}
async function attachMusic(page, form, query) {
  await form.locator('[data-testid="clips-upload-audio"]').click();
  const dlg = page.locator('[role=dialog]').filter({ hasText: 'Прикрепление аудиозаписи' }).last();
  await dlg.waitFor({ timeout: 15000 });
  for (const q of [query, query.split(/\s+/)[0]]) {
    const s = dlg.locator('[data-testid="clips-upload-audio-search"], input').first();
    await s.fill(''); await s.fill(q);
    await page.waitForTimeout(4500);
    const idx = await dlg.evaluate(d => {
      const btns = [...d.querySelectorAll('button')].filter(b => b.innerText.trim() === 'Прикрепить');
      for (let i = 0; i < btns.length; i++) {
        let r = btns[i];
        for (let k = 0; k < 8 && r.parentElement; k++) { r = r.parentElement; if (r.innerText.split('\n').filter(Boolean).length >= 3) break; }
        const t = r.innerText.split('\n').map(x => x.trim()).filter(Boolean);
        if (!/недоступен/i.test(t.join(' '))) return { i, title: `${t[0]} - ${t[1]}` };
      }
      return null;
    });
    if (!idx) continue;
    await dlg.locator('button').filter({ hasText: /^Прикрепить$/ }).nth(idx.i).click();
    await page.waitForTimeout(3000);
    const cell = await form.locator('[data-testid="clips-upload-audio"]').innerText().catch(() => '');
    if (cell.includes(idx.title.split(' - ')[0])) return idx.title;
    break;
  }
  await closeModals(page);
  return null;
}

async function clipOne(page, video, descFile, date, time, dry, music) {
  const w = parseWhen(date, time);
  const desc = fs.readFileSync(descFile, 'utf8').replace(/\r/g, '').trim();
  if (!fs.existsSync(video)) return ['UNKNOWN', 'нет файла ' + video];
  if (!/clips\/upload/.test(page.url())) await spaGo(page, `/clips/upload-${GROUP}`);
  if (await isLoggedOut(page)) return ['NOT_LOGGED_IN'];
  if (await isCaptcha(page)) return ['CAPTCHA'];
  await page.locator('[data-testid="clips-publish-button"]').first().click();
  await page.locator('[data-testid="video_upload_select_file"]').waitFor({ state: 'attached', timeout: 15000 });
  await page.locator('[data-testid="video_upload_select_file"]').setInputFiles(asciiCopy(video));
  const form = page.locator('section').filter({ has: page.locator('[data-testid="clips-upload-description"]') }).first();
  await form.waitFor({ timeout: 60000 });
  // Пока клип не обработан, расписание недоступно.
  await form.locator('[data-testid="clips-upload-status"]').filter({ hasText: /обработан/ }).first().waitFor({ timeout: 240000 }).catch(() => {});
  const link = await form.locator('[data-testid="clips-upload-clip-link"]').first().innerText().catch(() => '');
  const fail = async (st, ex) => { await shot(page); await closeModals(page); const d = await deleteUploadForm(page, form); return [st, `${ex}; клип ${d ? 'удалён' : 'НЕ удалён: ' + link}`]; };

  const ta = form.locator('[data-testid="clips-upload-description"]');
  await ta.fill(desc);
  if ((await ta.inputValue()) !== desc) return fail('TEXT_FAIL', 'описание не вставилось');
  // Трек не нашёлся - клип всё равно планируем, без музыки, и пишем об этом в статусе.
  let track = '';
  if (music) {
    const t = await attachMusic(page, form, music).catch(() => null);
    track = t ? `, музыка: ${t}` : `, музыка НЕ найдена по «${music}»`;
    await closeModals(page);
  }
  await form.locator('[data-testid="clips-upload-publish-date"]').click();
  await page.locator('[data-testid="clips-upload-calendar-day"]').first().waitFor({ timeout: 10000 }).catch(() => {});
  const cal = await setCalendar(page, 'clips-upload-calendar', w);
  // Закрываем календарь кликом по заголовку формы.
  await page.locator('[data-testid="clips-upload-header"]').click().catch(() => {});
  await page.waitForTimeout(800);
  const when = await form.locator('[data-testid="clips-upload-publish-date-date"]').innerText().catch(() => '');
  const sched = form.locator('button').filter({ hasText: /^Запланировать публикацию$/ });
  if (cal !== 'ok' || !whenMatches(when, w)) return fail('DATE_FAIL', `${cal}, «Когда опубликовать: ${cut(when, 30)}»`);
  if (!(await sched.count())) return fail('DATE_FAIL', 'нет кнопки «Запланировать публикацию»');
  if (dry) return fail('DRY_OK', `«${cut(when, 30)}», описание ок${track}`);
  for (let k = 0; k < 3 && (await sched.count()); k++) { await sched.first().click().catch(() => {}); await page.waitForTimeout(4000); }
  if (await isCaptcha(page)) return ['CAPTCHA', link];
  const still = await page.locator('[data-testid="clips-upload-clip-link"]').filter({ hasText: link }).count();
  return still ? ['UNKNOWN', `форма осталась: ${link}`] : ['QUEUED', `«${cut(when, 30)}» ${link}${track}`];
}

// ---------- Gemini ----------
// Анонимный Gemini тоже показывает поле ввода, поэтому вход проверяем по кнопке «Войти».
async function geminiSignedOut(page) {
  if (/accounts\.google\.com/.test(page.url())) return true;
  return (await page.locator('a, button').filter({ hasText: /^\s*(Войти|Sign in)\s*$/ }).locator('visible=true').count()) > 0;
}

async function geminiImage(prompt, out, url) {
  const { browser, ctx, page } = await open({ vk: false, google: true });
  try {
    await page.goto(url || GEMINI_CHAT, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForTimeout(6000);
    if (await geminiSignedOut(page)) {
      await shot(page); return 'NOT_LOGGED_IN (обновите cookies Gemini)';
    }
    const imgSel = 'model-response img[src^="http"], generated-image img, single-image img';
    const before = await page.locator(imgSel).count();
    const input = page.locator('rich-textarea [contenteditable="true"], div.ql-editor[contenteditable="true"], [contenteditable="true"][role="textbox"]').first();
    await input.waitFor({ timeout: 20000 });
    await input.click();
    await page.keyboard.insertText(prompt);
    await page.waitForTimeout(800);
    const send = page.locator('button[aria-label*="Отправить" i], button[aria-label*="Send" i], button.send-button').first();
    if (await send.count()) await send.click(); else await page.keyboard.press('Enter');
    // Картинка генерируется до ~2 минут.
    let n = before;
    for (let i = 0; i < 60 && n <= before; i++) { await page.waitForTimeout(3000); n = await page.locator(imgSel).count(); }
    if (n <= before) {
      await shot(page);
      const last = await page.locator('model-response').last().innerText().catch(() => '');
      return 'NO_IMAGE ' + cut(last, 300);
    }
    await page.waitForTimeout(5000);
    const img = page.locator(imgSel).last();
    // 1) кнопка скачивания в полном размере; 2) прямой запрос по src; 3) скриншот элемента.
    try {
      await img.hover();
      const dl = page.locator('button[aria-label*="Скачать" i], button[aria-label*="Download" i], download-generated-image-button button').last();
      if (await dl.count()) {
        const [d] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), dl.click()]);
        await d.saveAs(out); return 'SAVED ' + out + ' (полный размер)';
      }
    } catch (_) {}
    const src = await img.getAttribute('src');
    try {
      const r = await ctx.request.get(src.replace(/=s\d+[^/]*$/, '=s0'));
      if (r.ok()) { fs.writeFileSync(out, await r.body()); return 'SAVED ' + out + ' (по ссылке)'; }
    } catch (_) {}
    await img.screenshot({ path: out });
    return 'SAVED ' + out + ' (скриншот, качество ниже)';
  } finally { await browser.close(); }
}

// ---------- команды ----------
async function runBatch(kind, planFile, dry) {
  const plan = readJson(planFile, null);
  if (!Array.isArray(plan)) throw new Error('plan.json - массив');
  const { browser, page } = await open();
  let stop = false;
  try {
    for (const it of plan) {
      if (stop) break;
      if (getStatus(kind, it.code) === 'QUEUED') { console.log(`${it.code} уже QUEUED - пропуск`); continue; }
      let res;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          res = kind === 'post'
            ? await postOne(page, it.image, it.text, it.date, it.time, dry)
            : await clipOne(page, it.video, it.desc, it.date, it.time, dry, it.music);
        } catch (e) { res = ['UNKNOWN', e.message]; }
        if (['QUEUED', 'DRY_OK', 'NOT_LOGGED_IN', 'CAPTCHA'].includes(res[0])) break;
        log(`${kind} ${it.code} попытка ${attempt}: ${res.join(' ')}`);
        if (kind === 'post' && attempt < 3) { await page.keyboard.press('Escape').catch(() => {}); await sleep(5000); await go(page, `${BASE}/feed`); }
        if (kind === 'clip' && attempt < 3) { await sleep(5000); await spaGo(page, `/clips/upload-${GROUP}`); }
      }
      if (!dry) setStatus(kind, it.code, res[0], res[1]);
      log(`${kind} ${it.code} ${it.date} ${it.time}: ${res.join(' ')}`);
      console.log(`${it.code} ${it.date} ${it.time} МСК: ${res[0]}${res[1] ? ' - ' + res[1] : ''}`);
      if (!['QUEUED', 'DRY_OK'].includes(res[0])) { stop = true; await shot(page); console.log('СТОП: пакет остановлен на ' + it.code + ' (скриншот last.png)'); }
      if (kind === 'post' && !stop) await sleep(4000 + Math.random() * 3000);
    }
  } finally { await browser.close(); }
}

const cmds = {
  async check() {
    const { browser, page } = await open();
    await go(page, `${BASE}/feed`);
    console.log('VK: ' + ((await isLoggedOut(page)) ? 'NOT_LOGGED_IN' : 'LOGGED_IN') + ((await isCaptcha(page)) ? ' CAPTCHA' : ''));
    await browser.close();
    const v = googleVar();
    if (!v) { console.log('Gemini: нет переменной с cookies (GOOGLE_COOKIES)'); return; }
    const g = await open({ vk: false, google: true });
    await g.page.goto(GEMINI_CHAT, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
    await g.page.locator('rich-textarea, [contenteditable="true"]').first().waitFor({ timeout: 30000 }).catch(() => {});
    const ok = (await g.page.locator('rich-textarea, [contenteditable="true"]').count()) > 0 && !(await geminiSignedOut(g.page));
    console.log(`Gemini (${v}): ${ok ? 'LOGGED_IN' : 'NOT_LOGGED_IN ' + g.page.url()}`);
    await shot(g.page, 'gemini.png');
    await g.browser.close();
  },

  async postponed() {
    const { browser, page } = await open();
    await spaGo(page, `/wall-${GROUP}?postponed=1`);
    const { total, items } = await listPostponed(page);
    console.log(`отложенных: ${total}, собрано: ${items.length}`);
    items.forEach(p => console.log(`${p.date} | ${cut(p.first, 90)}`));
    await browser.close();
  },

  async 'clips-postponed'() {
    const { browser, page } = await open();
    await spaGo(page, `/clips/postponed/club${GROUP}`);
    for (let i = 0; i < 6; i++) { await page.mouse.wheel(0, 5000); await page.waitForTimeout(1500); }
    const t = (await bodyText(page)).replace(/ /g, ' ');
    const d = [...t.matchAll(/(\d{1,2} [а-я]{3}(?: \d{4})? в \d{1,2}:\d\d)/g)].map(x => x[1]);
    console.log(`дат на странице: ${d.length}`);
    console.log(d.join('\n'));
    await shot(page);
    await browser.close();
  },

  async stats() {
    const { browser, page } = await open();
    await spaGo(page, `/groups/dashboard/@${SCREEN}`);
    await page.waitForTimeout(5000);
    const grab = async () => { const t = await bodyText(page); const i = t.indexOf('Открыть страницу'); return t.slice(i >= 0 ? i + 16 : 0).replace(/\n\t\n/g, '\t').replace(/\n{2,}/g, '\n').trim(); };
    const summary = s => s.split(/Охват и просмотры/)[0];
    let out = '=== Общее\n' + summary(await grab());
    for (const tab of ['Посты', 'Клипы']) {
      await page.getByText(tab, { exact: true }).locator('visible=true').first().click({ timeout: 60000 }); await page.waitForTimeout(8000);
      out += `\n\n=== ${tab}: итоги\n` + summary(await grab());
      await page.getByText('Контент', { exact: true }).locator('visible=true').first().click({ timeout: 60000 }); await page.waitForTimeout(9000);
      for (let i = 0; i < 4; i++) { await page.mouse.wheel(0, 5000); await page.waitForTimeout(1500); }
      const t = await grab();
      out += `\n\n=== ${tab}: по публикациям (охват, просмотры, лайки, комментарии, поделились, закладки)\n` + t.slice(t.indexOf('Дата'));
    }
    const f = file(`stats_${new Date().toISOString().slice(0, 10)}.txt`);
    fs.writeFileSync(f, out);
    console.log(out.slice(0, 6000));
    console.log('\nполностью: ' + f);
    await browser.close();
  },

  // Постинг в VK из облака отключён: VK блокирует аккаунт за автоматические загрузки. Публикует пользователь через Claude in Chrome.


  async gemini(promptFile, out, url) {
    if (!promptFile || !out) throw new Error('gemini <промпт.txt> <out.png> [url_чата]');
    console.log(await geminiImage(fs.readFileSync(promptFile, 'utf8').trim(), out, url));
  },

  async inspect(url) {
    const g = /google\.com/.test(url);
    const { browser, page } = await open({ vk: !g, google: g });
    if (g || /^https?:/.test(url)) await go(page, url); else await spaGo(page, url);
    await shot(page, 'inspect.png');
    const info = await page.evaluate(() => {
      const dq = {};
      document.querySelectorAll('[data-testid]').forEach(e => { const k = e.getAttribute('data-testid'); dq[k] = (dq[k] || 0) + 1; });
      return { url: location.href, testids: Object.entries(dq).slice(0, 80), editable: document.querySelectorAll('[contenteditable="true"]').length, files: document.querySelectorAll('input[type=file]').length };
    });
    console.log(JSON.stringify(info));
    console.log('скриншот: ' + file('inspect.png'));
    await browser.close();
  },
};

(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmds[cmd]) { console.log('команды: ' + Object.keys(cmds).join(', ')); process.exit(1); }
  await cmds[cmd](...args);
})().catch(e => { console.error('ERR ' + e.message); process.exit(1); });

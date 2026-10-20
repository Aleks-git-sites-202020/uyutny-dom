#!/usr/bin/env node
// Помощник для откликов на hh.ru из облачной сессии Claude Code (headless Chromium + Playwright).
// Вход в аккаунт - cookies из переменной окружения HH_COOKIES: строка заголовка Cookie из DevTools,
// JSON-массив из расширения
// «Get cookies.txt LOCALLY» или формат Netscape cookies.txt).
//
// Команды (вывод короткий, рассчитан на чтение агентом):
//   node hh.js check                          - проверить вход (имя в шапке / ссылка на резюме)
//   node hh.js negotiations [страниц=2]       - список откликов -> $HH_DIR/apl.json, печать «название|компания»
//   node hh.js serp <url> <ключ>              - выдача -> $HH_DIR/serp_<ключ>.json, печать «id|название|компания|откликнулся?»
//   node hh.js vacancy <id>                   - формат работы, зарплата, признак отклика, описание (до 1000 симв.)
//   node hh.js company <id>                   - работодатель вакансии: ссылка на hh, сайт, соцсети, описание (до 1500 симв.)
//   node hh.js site <url> [ключ]              - сайт или группа ВК/канал ТГ компании без cookies hh: заголовок,
//                                               описание, разделы, текст до 2500 симв., ссылки на соцсети
//   node hh.js respond <id> "<название резюме>" <файл_письма> [--dry]
//                                             - отклик; --dry: дойти до формы, ничего не отправлять
// Статусы respond: SENT, ALREADY, CAPTCHA, NEED_QUESTIONS, NO_BUTTON, RESUME_NOT_FOUND, LETTER_FAIL, UNKNOWN.
// Капча после отправки: картинка в $HH_DIR/captcha.png, в captcha.log строка WAIT_ANSWER <id> <попытка>;
// скрипт ждёт ответ в $HH_DIR/answer.txt (до 30 мин, до 3 попыток), затем пишет GOT / PASSED / STILL.
// Итог каждого отклика дописывается в $HH_DIR/status.log.
// На CAPTCHA/UNKNOWN/NEED_QUESTIONS сохраняется скриншот $HH_DIR/last.png.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function loadPlaywright() {
  try { return require('playwright'); } catch (_) {}
  const root = execSync('npm root -g').toString().trim();
  return require(path.join(root, 'playwright'));
}
const { chromium } = loadPlaywright();

const DIR = process.env.HH_DIR || path.join(process.cwd(), 'hh-run');
fs.mkdirSync(DIR, { recursive: true });
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const cut = (s, n) => (s || '').replace(/\s+/g, ' ').trim().slice(0, n);

function parseCookies(raw) {
  raw = (raw || '').trim();
  if (!raw) throw new Error('HH_COOKIES пустая: добавьте cookies hh.ru в переменные окружения и начните новую сессию');
  let list = [];
  if (raw.startsWith('[') || raw.startsWith('{')) {
    const j = JSON.parse(raw);
    list = (Array.isArray(j) ? j : j.cookies || []).map(c => ({
      name: c.name, value: String(c.value), domain: c.domain, path: c.path || '/',
      secure: !!c.secure, httpOnly: !!c.httpOnly,
      expires: c.expirationDate || c.expires || -1,
    }));
  } else if (!raw.includes('\t')) {
    // Строка заголовка Cookie из DevTools: «name1=value1; name2=value2»
    for (const part of raw.replace(/^cookie:\s*/i, '').split(/;\s*/)) {
      const i = part.indexOf('=');
      if (i > 0) list.push({ name: part.slice(0, i).trim(), value: part.slice(i + 1).trim(), domain: '.hh.ru', path: '/', secure: true, expires: -1 });
    }
  } else {
    for (const line of raw.split(/\r?\n/)) {
      let l = line;
      const httpOnly = l.startsWith('#HttpOnly_');
      if (httpOnly) l = l.slice('#HttpOnly_'.length);
      if (!l || l.startsWith('#')) continue;
      const p = l.split('\t');
      if (p.length < 7) continue;
      list.push({ domain: p[0], path: p[2], secure: p[3] === 'TRUE', expires: Number(p[4]) || -1,
        name: p[5], value: p[6], httpOnly });
    }
  }
  return list.filter(c => c.name && /hh\.ru$/.test((c.domain || '').replace(/^\./, '')))
    .map(c => ({ ...c, expires: c.expires > 0 ? Math.floor(c.expires) : -1, sameSite: 'Lax' }));
}

async function open() {
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
  const browser = await chromium.launch(proxy ? { proxy: { server: proxy } } : {});
  const ctx = await browser.newContext({ locale: 'ru-RU', userAgent: UA, viewport: { width: 1366, height: 900 } });
  await ctx.addCookies(parseCookies(process.env.HH_COOKIES));
  const page = await ctx.newPage();
  return { browser, page };
}

async function go(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForTimeout(2500);
}

async function isCaptcha(page) {
  // Слово «captcha» есть в словаре переводов на любой странице, поэтому смотрим на элементы, а не на HTML.
  return (await page.locator('[data-qa*="captcha"] input, img[src*="captcha"], iframe[src*="captcha"]').count()) > 0
    || /Пройдите капчу|подтвердите, что вы не робот/i.test(await page.locator('body').innerText().catch(() => ''));
}

async function shot(page) { await page.screenshot({ path: path.join(DIR, 'last.png') }).catch(() => {}); }

const norm = s => (s || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
function loadApl() { try { return JSON.parse(fs.readFileSync(path.join(DIR, 'apl.json'), 'utf8')); } catch (_) { return []; } }
function applied(apl, title, company) {
  const t = norm(title).slice(0, 30), c = norm(company).slice(0, 15);
  return apl.some(a => norm(a.title).slice(0, 30) === t && norm(a.company).slice(0, 15) === c);
}

const cmds = {
  async check() {
    const { browser, page } = await open();
    await go(page, 'https://hh.ru/applicant/resumes');
    const url = page.url();
    const titles = await page.locator('[data-qa="resume-title"], [data-qa="resume-card-title"]').allInnerTexts().catch(() => []);
    // Без входа hh отдаёт по этому же адресу форму входа, поэтому признак входа - наличие резюме.
    const loginForm = await page.locator('[data-qa="account-login-form"], form[action*="login"], [data-qa="login"]').count();
    console.log(titles.length && !loginForm ? 'LOGGED_IN' : 'NOT_LOGGED_IN ' + url);
    if (await isCaptcha(page)) console.log('CAPTCHA');
    titles.slice(0, 10).forEach(t => console.log('резюме: ' + cut(t, 80)));
    await browser.close();
  },

  async negotiations(pages = '2') {
    const { browser, page } = await open();
    const out = [];
    for (let i = 0; i < Number(pages); i++) {
      await go(page, 'https://hh.ru/applicant/negotiations' + (i ? `?page=${i}` : ''));
      if (await isCaptcha(page)) { await shot(page); console.log('CAPTCHA'); break; }
      const items = await page.$$eval('[data-qa="negotiations-item"]', els => els.map(e => ({
        title: (e.querySelector('[data-qa="negotiations-item-vacancy"]') || {}).innerText || '',
        company: (e.querySelector('[data-qa="negotiations-item-company"]') || {}).innerText || '',
      })));
      if (!items.length) break;
      out.push(...items);
      if (i + 1 < Number(pages)) await sleep(6000 + Math.random() * 3000);
    }
    fs.writeFileSync(path.join(DIR, 'apl.json'), JSON.stringify(out));
    console.log(`откликов: ${out.length}`);
    out.forEach(a => console.log(`${cut(a.title, 45)}|${cut(a.company, 15)}`));
    await browser.close();
  },

  async serp(url, key) {
    if (!url || !key) throw new Error('serp <url> <ключ>');
    const file = path.join(DIR, `serp_${key}.json`);
    let cards;
    if (fs.existsSync(file)) cards = JSON.parse(fs.readFileSync(file, 'utf8'));
    else {
      const { browser, page } = await open();
      await go(page, url);
      cards = await page.$$eval('[data-qa="serp-item__title"]', els => els.map(a => {
        const card = a.closest('[data-qa^="vacancy-serp__vacancy"]') || a.closest('div[class*="vacancy-card"]') || a.parentElement;
        const comp = card && card.querySelector('[data-qa="vacancy-serp__vacancy-employer"], [data-qa="vacancy-serp__vacancy-employer-text"]');
        // У рекламных карточек ссылка ведёт на adsrv.hh.ru, ID вакансии - в атрибуте id контейнера.
        const m = (a.href || '').match(/vacancy\/(\d+)/);
        let id = m ? m[1] : '';
        for (let e = a; !id && e && e !== document.body; e = e.parentElement) if (/^\d{6,}$/.test(e.id)) id = e.id;
        return { id, title: a.innerText, company: comp ? comp.innerText : '' };
      }));
      if (!cards.length && await isCaptcha(page)) { await shot(page); console.log('CAPTCHA'); await browser.close(); return; }
      fs.writeFileSync(file, JSON.stringify(cards));
      await browser.close();
    }
    const apl = loadApl();
    console.log(`карточек: ${cards.length}`);
    cards.forEach(c => console.log(`${c.id}|${cut(c.title, 45)}|${cut(c.company, 15)}${applied(apl, c.title, c.company) ? '|ОТКЛИК' : ''}`));
  },

  async vacancy(id) {
    const file = path.join(DIR, `vac_${id}.txt`);
    if (fs.existsSync(file)) { console.log(fs.readFileSync(file, 'utf8')); return; }
    const { browser, page } = await open();
    await go(page, `https://hh.ru/vacancy/${id}`);
    if (await isCaptcha(page)) { await shot(page); console.log('CAPTCHA'); await browser.close(); return; }
    const t = sel => page.locator(sel).first().innerText().catch(() => '');
    const body = await page.locator('body').innerText().catch(() => '');
    const fmt = (body.match(/Формат работы:?\s*([^\n]+)/) || [])[1] || '';
    const res = [
      `title: ${cut(await t('[data-qa="vacancy-title"]'), 120)}`,
      `company: ${cut(await t('[data-qa="vacancy-company-name"]'), 60)}`,
      `salary: ${cut(await t('[data-qa="vacancy-salary"]'), 80)}`,
      `format: ${cut(fmt, 80)}`,
      `applied: ${(await page.locator('[data-qa="vacancy-response-link-view-topic"]').count()) > 0}`,
      `button: ${(await page.locator('[data-qa="vacancy-response-link-top"]').count()) > 0}`,
      `desc: ${cut(await t('[data-qa="vacancy-description"]'), 1000)}`,
    ].join('\n');
    fs.writeFileSync(file, res);
    console.log(res);
    await browser.close();
  },

  async company(id) {
    const file = path.join(DIR, `company_${id}.txt`);
    if (fs.existsSync(file)) { console.log(fs.readFileSync(file, 'utf8')); return; }
    const { browser, page } = await open();
    await go(page, `https://hh.ru/vacancy/${id}`);
    if (await isCaptcha(page)) { await shot(page); console.log('CAPTCHA'); await browser.close(); return; }
    const links = async () => page.$$eval('a[href]', as => as.map(a => a.href));
    const social = arr => [...new Set(arr.filter(h => /(vk\.com|vk\.ru|t\.me|ok\.ru|dzen\.ru|youtube\.com|rutube\.ru)\//i.test(h)
      && !/hh\.ru|hhru|headhunter/i.test(h)))].slice(0, 8);
    const vacLinks = (await links()).filter(h => !/hh\.ru|hhcdn|headhunter/i.test(h) && /^https?:/.test(h));
    const descLinks = await page.$$eval('[data-qa="vacancy-description"] a[href]', as => as.map(a => a.href)).catch(() => []);
    const emp = await page.locator('[data-qa="vacancy-company-name"]').first().getAttribute('href').catch(() => '');
    const out = [`company: ${cut(await page.locator('[data-qa="vacancy-company-name"]').first().innerText().catch(() => ''), 80)}`,
      `hh: ${emp ? new URL(emp, 'https://hh.ru').href : '-'}`, `desc_links: ${descLinks.join(' ') || '-'}`];
    let site = '', about = '', empLinks = [];
    if (emp) {
      await page.waitForTimeout(6000 + Math.random() * 3000);
      await go(page, new URL(emp, 'https://hh.ru').href);
      site = await page.locator('[data-qa="sidebar-company-site"], a[data-qa*="company-site"]').first().getAttribute('href').catch(() => '') || '';
      about = await page.locator('[data-qa="company-description-text"], [data-qa*="company-description"]').first().innerText().catch(() => '');
      empLinks = (await links()).filter(h => !/hh\.ru|hhcdn|headhunter/i.test(h) && /^https?:/.test(h));
      if (!about) about = (await page.locator('body').innerText().catch(() => '')).slice(0, 1500);
    }
    out.push(`site: ${site || '-'}`, `social: ${social([...descLinks, ...vacLinks, ...empLinks]).join(' ') || '-'}`,
      `about: ${cut(about, 1500)}`);
    const res = out.join('\n');
    fs.writeFileSync(file, res);
    console.log(res);
    await browser.close();
  },

  async site(url, key) {
    if (!url) throw new Error('site <url> [ключ]');
    // Прокси облака принимает только HTTPS, поэтому http:// меняем на https://.
    url = url.replace(/^http:\/\//i, 'https://');
    if (!/^https:\/\//i.test(url)) url = 'https://' + url;
    const file = path.join(DIR, `site_${key || url.replace(/[^a-z0-9]+/gi, '_').slice(0, 60)}.txt`);
    if (fs.existsSync(file)) { console.log(fs.readFileSync(file, 'utf8')); return; }
    const proxy = process.env.HTTPS_PROXY || process.env.https_proxy;
    const browser = await chromium.launch(proxy ? { proxy: { server: proxy } } : {});
    const page = await (await browser.newContext({ locale: 'ru-RU', userAgent: UA, viewport: { width: 1366, height: 900 } })).newPage();
    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(3500);
    } catch (e) { console.log(`FAIL ${cut(e.message, 150)}`); await browser.close(); return; }
    const res = await page.evaluate(() => {
      const q = s => [...document.querySelectorAll(s)].map(e => e.innerText.replace(/\s+/g, ' ').trim()).filter(Boolean);
      const meta = (document.querySelector('meta[name="description"], meta[property="og:description"]') || {}).content || '';
      const hrefs = [...document.querySelectorAll('a[href]')].map(a => a.href);
      return { title: document.title, meta, heads: [...new Set(q('h1, h2, h3'))].slice(0, 25).join(' | '),
        forms: document.querySelectorAll('form, input[type="tel"]').length,
        quiz: /квиз|quiz|marquiz/i.test(document.documentElement.innerHTML),
        widgets: ['metrika', 'top-fwz1', 'calltouch', 'roistat', 'jivo', 'bitrix24', 'amocrm', 'senler', 'vk.com/js/api']
          .filter(w => document.documentElement.innerHTML.includes(w)).join(','),
        social: [...new Set(hrefs.filter(h => /(vk\.com|vk\.ru|t\.me|wa\.me|youtube|rutube|dzen)\//i.test(h)))].slice(0, 8).join(' '),
        text: document.body ? document.body.innerText.replace(/\s+/g, ' ').trim() : '' };
    });
    if (/agent-proxy relay|__agentproxy/i.test(res.text)) { console.log('FAIL прокси не пустил'); await browser.close(); return; }
    const out = [`url: ${page.url()}`, `title: ${cut(res.title, 150)}`, `meta: ${cut(res.meta, 300)}`,
      `heads: ${cut(res.heads, 900)}`, `forms: ${res.forms}, quiz: ${res.quiz}, widgets: ${res.widgets || '-'}`,
      `social: ${res.social || '-'}`, `text: ${cut(res.text, 2500)}`].join('\n');
    await page.screenshot({ path: path.join(DIR, 'site.png') }).catch(() => {});
    fs.writeFileSync(file, out);
    console.log(out);
    await browser.close();
  },

  async respond(id, resumeTitle, letterFile, flag) {
    if (!id || !resumeTitle || !letterFile) throw new Error('respond <id> "<резюме>" <файл_письма> [--dry]');
    const letter = fs.readFileSync(letterFile, 'utf8').trim();
    const dry = flag === '--dry';
    const { browser, page } = await open();
    const done = async (status, extra = '') => { if (status !== 'SENT') await shot(page); fs.appendFileSync(path.join(DIR, 'status.log'), `${id}|${status} ${cut(extra, 200)}\n`); console.log(status + (extra ? ' ' + extra : '')); await browser.close(); };
    const bodyText = () => page.locator('body').innerText().catch(() => '');

    await go(page, `https://hh.ru/vacancy/${id}`);
    if (await isCaptcha(page)) return done('CAPTCHA');
    if (await page.locator('[data-qa="vacancy-response-link-view-topic"]').count()) return done('ALREADY');
    const btn = page.locator('[data-qa="vacancy-response-link-top"]').first();
    if (!(await btn.count())) return done('NO_BUTTON');
    await btn.click();
    await page.waitForTimeout(3000);
    // Предупреждение о вакансии в другой стране / регионе.
    const reloc = page.locator('[data-qa="relocation-warning-confirm"]');
    if (await reloc.count()) { await reloc.first().click(); await page.waitForTimeout(2500); }
    if (await isCaptcha(page)) return done('CAPTCHA');
    if (/Откликнуться повторно|Вы откликнулись/.test(await bodyText())
        && !(await page.locator('[data-qa="vacancy-response-submit-popup"]').count())) return done('ALREADY');

    const dialog = page.locator('[role="dialog"]').last();
    const scope = (await dialog.count()) ? dialog : page.locator('body');

    // Выбор резюме: радиокнопка с нужным названием (в модальном окне или на /applicant/vacancy_response).
    const want = norm(resumeTitle).slice(0, 25);
    const pickRadio = async () => {
      const labels = scope.locator('label');
      const n = await labels.count();
      for (let i = 0; i < n; i++) {
        const l = labels.nth(i);
        if (norm(await l.innerText().catch(() => '')).includes(want) && (await l.locator('input[type="radio"]').count())) {
          await l.click(); await page.waitForTimeout(800); return true;
        }
      }
      return false;
    };
    let picked = await pickRadio();
    if (!picked) {
      // Свёрнутый селектор: кликаем по текущему резюме, чтобы раскрыть список (первый клик иногда не срабатывает).
      for (let k = 0; k < 2 && !picked; k++) {
        const cur = scope.locator('[data-qa="resume-title"]').first();
        if (await cur.count()) {
          const cell = cur.locator('xpath=ancestor::*[@data-qa="cell"][1]');
          await ((await cell.count()) ? cell : cur).click().catch(() => {});
          await page.waitForTimeout(1200);
        }
        picked = await pickRadio();
      }
    }
    const selected = norm(await scope.locator('[data-qa="resume-title"]').first().innerText().catch(() => ''));
    if (!picked && !selected.includes(want)) return done('RESUME_NOT_FOUND', `сейчас: ${cut(selected, 60)}`);

    // Сопроводительное письмо.
    let ta = scope.locator('textarea[data-qa="vacancy-response-popup-form-letter-input"], textarea[name="letter"]').first();
    if (!(await ta.count())) {
      const toggle = scope.locator('[data-qa="vacancy-response-letter-toggle"], button:has-text("Добавить сопроводительное"), button:has-text("Сопроводительное письмо"), button:has-text("Добавить")').first();
      // Список резюме мог остаться раскрытым и перекрыть кнопку: сворачиваем и кликаем через DOM.
      if (picked && (await scope.locator('[data-qa="resume-title"]').count()) > 1) {
        await page.keyboard.press('Escape'); await page.waitForTimeout(1000);
      }
      if (await toggle.count()) { await toggle.evaluate(el => el.click()).catch(() => {}); await page.waitForTimeout(1500); }
      ta = scope.locator('textarea[data-qa="vacancy-response-popup-form-letter-input"], textarea[name="letter"], textarea').first();
    }
    if (!(await ta.count())) return done('LETTER_FAIL', 'нет поля письма');
    await ta.click();
    await ta.fill('');
    await ta.pressSequentially(letter.slice(0, 20), { delay: 20 });
    await ta.fill(letter); // fill шлёт настоящие input-события, React их принимает
    if ((await ta.inputValue()).trim() !== letter) return done('LETTER_FAIL', 'текст не вставился');

    // Вопросы работодателя: другие пустые обязательные поля.
    const others = scope.locator('textarea:not([data-qa="vacancy-response-popup-form-letter-input"]):not([name="letter"]), input[type="text"]');
    const empty = [];
    for (let i = 0; i < await others.count(); i++) {
      const el = others.nth(i);
      if (await el.isVisible().catch(() => false) && !(await el.inputValue().catch(() => 'x'))) empty.push(i);
    }
    const qText = /ответьте на вопросы|вопросы работодателя/i.test(await scope.innerText().catch(() => ''));
    if (empty.length || (qText && (await scope.locator('input[type="radio"]').count()) > 2)) {
      return done('NEED_QUESTIONS', `пустых полей: ${empty.length}; форма: ${cut(await scope.innerText().catch(() => ''), 1500)}`);
    }
    const titles = scope.locator('[data-qa="resume-title"]');
    const finalSel = (await titles.count()) === 1 ? norm(await titles.first().innerText().catch(() => '')) : '';
    if (!finalSel.includes(want)) return done('RESUME_NOT_FOUND', `перед отправкой: ${cut(finalSel || 'список раскрыт', 60)}`);
    if (dry) return done('DRY_OK', `резюме: ${cut(finalSel, 60)}`);

    const submit = scope.locator('[data-qa="vacancy-response-submit-popup"], [data-qa="vacancy-response-letter-submit"], button:has-text("Откликнуться"):not(:has-text("повторно"))').first();
    if (!(await submit.count())) return done('UNKNOWN', 'нет кнопки отправки');
    await submit.evaluate(el => el.click());
    await page.waitForTimeout(4000);
    // Капча после отправки: картинку - пользователю, ответ ждём в answer.txt.
    for (let round = 0; round < 3 && (await isCaptcha(page)); round++) {
      const capImg = page.locator('img[src*="captcha"], [data-qa*="captcha"] img').first();
      await ((await capImg.count()) ? capImg : page).screenshot({ path: path.join(DIR, 'captcha.png') }).catch(() => {});
      const ans = path.join(DIR, 'answer.txt');
      try { fs.unlinkSync(ans); } catch (_) {}
      const inputs = await page.locator('input').evaluateAll(els => els.map(e => [e.type, e.name, e.placeholder, e.getAttribute('data-qa'), e.offsetParent ? 'vis' : 'hid'].join(':')).join(' ; ')).catch(() => '');
      fs.appendFileSync(path.join(DIR, 'inputs.log'), `${id} ${inputs}\n`);
      fs.appendFileSync(path.join(DIR, 'captcha.log'), `WAIT_ANSWER ${id} ${round}\n`);
      let t = 0;
      while (!fs.existsSync(ans) && t < 1800) { await sleep(2000); t += 2; }
      if (!fs.existsSync(ans)) { fs.appendFileSync(path.join(DIR, 'captcha.log'), 'TIMEOUT\n'); return done('CAPTCHA'); }
      const text = fs.readFileSync(ans, 'utf8').trim();
      fs.unlinkSync(ans);
      const capBox = page.locator('[role="dialog"]:has-text("Пройдите капчу"), [data-qa*="captcha"]').last();
      let inp = capBox.locator('input:not([type="hidden"])').first();
      if (!(await inp.count())) inp = page.locator('input[name*="captcha" i], input[placeholder*="картинки"], input[aria-label*="картинки"]').first();
      if (!(await inp.count())) inp = page.locator('input[type="text"]:visible').last();
      fs.appendFileSync(path.join(DIR, 'captcha.log'), `GOT ${id}\n`);
      await inp.fill(text);
      const sendBtn = capBox.locator('button:has-text("Отправить")').first();
      if (await sendBtn.count()) await sendBtn.evaluate(el => el.click()); else await inp.press('Enter');
      await page.waitForTimeout(5000);
      await page.screenshot({ path: path.join(DIR, `after_cap_${id}.png`) }).catch(() => {});
      fs.appendFileSync(path.join(DIR, 'captcha.log'), ((await isCaptcha(page)) ? 'STILL' : 'PASSED') + '\n');
    }
    if (await isCaptcha(page)) return done('CAPTCHA');
    // После капчи форма может остаться открытой - нажать отправку ещё раз.
    const again = page.locator('[data-qa="vacancy-response-submit-popup"], button:has-text("Откликнуться"):not(:has-text("повторно"))').last();
    if (!/Резюме доставлено|Отклик отправлен|Вы откликнулись/i.test(await bodyText()) && await again.isVisible().catch(() => false)) {
      await again.evaluate(el => el.click()).catch(() => {}); await page.waitForTimeout(4000);
    }
    const after = await bodyText();
    if (/Сопроводительное письмо обязательное/i.test(after)) return done('LETTER_FAIL', 'hh не принял письмо');
    if (/Резюме доставлено|Отклик другим резюме|Вы откликнулись|Отклик отправлен/i.test(after)
        || (await page.locator('[data-qa="vacancy-response-link-view-topic"]').count())) return done('SENT');
    return done('UNKNOWN', cut(after, 400));
  },
};

(async () => {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmds[cmd]) { console.log('команды: ' + Object.keys(cmds).join(', ')); process.exit(1); }
  await cmds[cmd](...args);
})().catch(e => { console.error('ERR ' + e.message); process.exit(1); });

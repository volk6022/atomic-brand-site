// Прогон экрана без браузера: подставляем ответы API и проверяем, что логика
// возвращает всё, что просит разметка.
//
// Зачем: в этом фреймворке дырка `{{ foo }}`, которой нет в результате
// `renderVals()`, не даёт никакой ошибки — ячейка просто остаётся пустой, а если
// не хватило `rows` или `cols`, пустой остаётся вся таблица. Синтаксис при этом
// в порядке, и `check-dc.js` такое не ловит. Здесь ловится.
//
//     node smoke-dc.js RadarStream.dc.html
//     node smoke-dc.js .            # все экраны
//
// ── Откуда берутся ответы ────────────────────────────────────────────────────
//
// Из `api-fixtures.json`, снятого прогоном настоящего приложения
// (`Atomic-Radar/scripts/dump_gui_fixtures.py`). Руками этот файл не пишется.
//
// Раньше ответы лежали прямо здесь — три десятка объектов, набранных по памяти.
// Так проверка подтверждала согласованность экрана с выдумкой, а не с сервером, и
// один раз это уже стоило дорого: `/channels` получил пагинацию, в заглушке остался
// массив, и ворота пропускали экран, падавший на `.filter is not a function`.
//
// Поэтому неизвестный путь теперь — **ошибка**, а не «отдадим что-нибудь похожее».
// Появилась ручка — она обязана появиться в дампере; иначе экран получал бы чужой
// ответ и проверка снова стала бы обрядом.

'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ── разбор разметки ───────────────────────────────────────────────────────────

function markupOf(src) {
  const i = src.indexOf('<script type="text/x-dc"');
  return i === -1 ? src : src.slice(0, i);
}

function logicOf(src) {
  const m = src.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/);
  return m ? m[1] : null;
}

// Пропсы, объявленные экраном. Нужны, чтобы понять, шаблон это или обычный экран:
// объявленный `workflow` означает, что экран умеет работать в двух видах, и
// проверять его надо в обоих.
function declaredProps(src) {
  const m = src.match(/data-props="([^"]*)"/);
  if (!m) return {};
  const raw = m[1].replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  try { return JSON.parse(raw); } catch (e) { return {}; }
}

// Имена, которые разметка ждёт от логики. Переменные циклов (`sc-for as="c"`)
// приходят не из renderVals, поэтому их корни исключаются.
function requestedNames(markup) {
  const loopVars = new Set();
  for (const m of markup.matchAll(/\bas="([^"]+)"/g)) loopVars.add(m[1]);

  const names = new Set();
  for (const m of markup.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
    const expr = m[1].trim();
    if (/^(true|false|\d+)$/.test(expr)) continue;   // {{ true }} — не имя
    const root = expr.split('.')[0].trim();
    if (!loopVars.has(root)) names.add(root);
  }
  return {names, loopVars};
}

// ── ответы API ────────────────────────────────────────────────────────────────

const FIXTURES_FILE = 'api-fixtures.json';

function loadFixtures(dir) {
  const file = path.join(dir, FIXTURES_FILE);
  if (!fs.existsSync(file)) {
    console.error('нет ' + file + '\n' +
      'Снимается так (из каталога Atomic-Radar):\n' +
      '  $env:RADAR_FIXTURES_DATABASE_URL=\'postgresql+asyncpg://…/radar_fixtures_test\'\n' +
      '  uv run python -m scripts.dump_gui_fixtures ../brand-site/radar/' + FIXTURES_FILE);
    process.exit(2);
  }
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// Путь запроса → ключ образца. Подставные сегменты сворачиваются: экран просит
// `/drafts/41`, образец лежит под `/drafts/{id}` — форма ответа от номера не
// зависит, а заводить образец на каждый id бессмысленно.
function fixtureKey(rawPath) {
  const base = rawPath.split('?')[0].replace(/\/+$/, '');
  const parts = base.split('/');           // ['', 'workflows', 'cold_dm', 'drafts', '41']
  const out = parts.map((p, i) => {
    if (i === 0) return p;
    if (/^\d+$/.test(p)) return '{id}';
    // Второй сегмент после `workflows` — ключ сценария, а не имя раздела.
    if (parts[i - 1] === 'workflows' && i === 2) return '{key}';
    return p;
  });
  return out.join('/');
}

function makeApi(fixtures, misses) {
  return {
    get: async (p) => {
      const key = fixtureKey(p);
      if (key in fixtures) return JSON.parse(JSON.stringify(fixtures[key]));
      misses.push(key + '   (запрошен как ' + p + ')');
      throw new Error('нет образца ответа для ' + key);
    },
    // Экраны под этой проверкой ничего не отправляют: `smoke` доводит их до
    // первой отрисовки и на кнопки не нажимает. Ответ-заглушка здесь именно
    // поэтому и остаётся заглушкой — как только появится проверка, доходящая до
    // действий, ей понадобятся снятые ответы, а не эта строка.
    post: async () => ({ok: true}),
    patch: async () => ({ok: true}),
    describe: (e) => 'ошибка: ' + e,
    downloadCsv: () => 0,
    isUnauthorized: () => false,
    isForbidden: () => false,
  };
}

// ── исполнение логики ─────────────────────────────────────────────────────────

async function once(file, src, fixtures, props) {
  const logic = logicOf(src);
  const tableSrc = fs.readFileSync(path.join(path.dirname(file), 'radar-table.js'), 'utf8')
    .replace(/^export /gm, '');

  const misses = [];
  const updates = [];
  // Панели, открытые через api.drill. Сами прогон кнопок не жмёт — их открывает
  // целевая проверка ниже (checkFleetLimits), остальным экранам пусто не мешает.
  const drills = [];
  const api = makeApi(fixtures, misses);
  const ctx = {
    console, setTimeout, clearTimeout, URLSearchParams, Date, Math, JSON, RegExp,
    Blob: class {}, URL: {createObjectURL: () => '', revokeObjectURL: () => {}},
    document: {createElement: () => ({click() {}, remove() {}}),
               body: {appendChild() {}}},
    localStorage: {getItem: () => null, setItem: () => {}},
    location: {hash: ''},
    history: {replaceState: () => {}},
    // Оболочка и очередь вешают горячие клавиши на window.
    window: {addEventListener() {}, removeEventListener() {}, open() {}},
    __imp: async (p) => p.includes('radar-table') ? {Table: ctx.__Table} : api,
    __drills: drills,
  };
  vm.createContext(ctx);
  vm.runInContext(tableSrc + '\n;this.__Table = Table;', ctx);

  // Заглушка базового класса: копим setState, как это делал бы рантайм.
  const base = `
    class DCLogic {
      constructor(){ this.props = Object.assign(
        {api:{toast(){}, drill(p){ __drills.push(p); }, trace(){}, go(){}, modal(){}}, mobile:false},
        __props); }
      setState(patch, cb){
        const next = typeof patch === 'function' ? patch(this.state) : patch;
        this.state = Object.assign({}, this.state, next);
        __updates.push(Object.keys(next));
        if (cb) cb();
      }
    }`;
  ctx.__updates = updates;
  ctx.__props = props || {};
  const prepared = logic.replace(/await import\(/g, 'await __imp(');
  vm.runInContext(base + '\n' + prepared + '\n;this.__C = Component;', ctx);

  const c = new ctx.__C();
  const problems = [];

  try {
    const first = c.renderVals();          // до загрузки данных
    if (!first || typeof first !== 'object') problems.push('renderVals() до загрузки не вернул объект');
  } catch (e) {
    problems.push('renderVals() падает до загрузки: ' + e.message);
  }

  if (typeof c.componentDidMount === 'function') {
    try { await c.componentDidMount(); } catch (e) {
      problems.push('componentDidMount падает: ' + e.message);
    }
  }
  await new Promise(r => setTimeout(r, 30));

  let vals = {};
  try { vals = c.renderVals() || {}; } catch (e) {
    problems.push('renderVals() падает после загрузки: ' + e.message);
  }

  const {names} = requestedNames(markupOf(src));
  const missing = [...names].filter(n => !(n in vals));
  if (missing.length) problems.push('разметка просит, логика не даёт: ' + missing.join(', '));

  for (const m of [...new Set(misses)]) {
    problems.push('нет образца ответа: ' + m + ' — добавь путь в scripts/dump_gui_fixtures.py');
  }

  return {problems, keys: Object.keys(vals).length,
          rows: Array.isArray(vals.rows) ? vals.rows.length : null,
          drills, vals};
}

// Экран-шаблон проверяется дважды. Первый вид — общий раздел, второй — раздел
// сценария: там другие ручки, другая форма ответа и другие подписи. Проверь
// только первый — и половина шаблона остаётся вне ворот, а именно она и новая.
const MODES = [
  {suffix: '', props: {}},
  {suffix: ' · сценарий', props: {workflow: 'public_reply',
                                  workflowTitle: 'Публичные ответы'}},
];

// Целевая проверка остатков Engage на Fleet (PLAN 12.2): у одного аккаунта
// фикстуры все поля лимитов null — панель обязана показать «—», у остальных
// числа обязаны отрендериться числами, а не прочерками или пустотой.
// Ожидания выводятся из фикстур /accounts, не зашиваются: дампер при следующем
// прогоне снимет живые значения, и проверка не должна разъехаться с ними.
function checkFleetLimits(fixtures, drills, vals, problems) {
  const K_ACCT = 'Вступлений осталось (аккаунт)';
  const K_FLEET = 'Вступлений осталось (флот)';
  const K_MSG = 'Сообщений осталось';
  const val = (d, k) => {
    const r = (d.rows || []).find(x => x.k === k);
    return r ? r.v : undefined;
  };
  const panels = (drills || []).filter(d =>
    val(d, K_ACCT) !== undefined && val(d, K_FLEET) !== undefined
    && val(d, K_MSG) !== undefined);
  const accs = Array.isArray(fixtures['/accounts']) ? fixtures['/accounts'] : [];
  if (!panels.length || panels.length !== accs.length) {
    problems.push('fleet: панелей с тремя строками остатков ' + panels.length +
                  ', аккаунтов в фикстуре ' + accs.length);
    return;
  }
  // Прочерки: сколько в фикстуре аккаунтов с null во всех остатках —
  // столько панелей, где все три строки показывают «—».
  const dashAccs = accs.filter(a => a.joins_remaining == null
    && a.joins_aggregate_remaining == null && a.messages_remaining == null).length;
  const dashPanels = panels.filter(d =>
    val(d, K_ACCT) === '—' && val(d, K_FLEET) === '—' && val(d, K_MSG) === '—');
  if (dashPanels.length !== dashAccs)
    problems.push('fleet: аккаунтов со сплошным null в фикстуре ' + dashAccs +
                  ', а панелей со «—» во всех трёх остатках — ' + dashPanels.length);
  // Числа: каждый аккаунт с joins_remaining обязан показать своё значение
  // и приписку про сброс, если окно конечное.
  for (const a of accs) {
    if (a.joins_remaining == null) continue;
    const h = Math.floor(a.joins_resets_in_seconds / 3600);
    const m = Math.floor((a.joins_resets_in_seconds % 3600) / 60);
    const reset = [h > 0 ? h + 'ч' : '', m > 0 ? m + 'м' : ''].filter(Boolean).join(' ');
    const want = String(a.joins_remaining) + (reset ? ' · сброс через ' + reset : '');
    const panel = panels.find(d => val(d, K_ACCT) === want);
    if (!panel) {
      problems.push('fleet: не найдена панель с «' + want + '» (число отрендерилось не числом?)');
      continue;
    }
    if (val(panel, K_FLEET) !== String(a.joins_aggregate_remaining))
      problems.push('fleet: флотский остаток «' + val(panel, K_FLEET) +
                    '» ≠ фикстурного ' + a.joins_aggregate_remaining);
    if (val(panel, K_MSG) !== String(a.messages_remaining))
      problems.push('fleet: остаток сообщений «' + val(panel, K_MSG) +
                    '» ≠ фикстурного ' + a.messages_remaining);
  }
  // Сводка флота в заголовке: совокупный остаток из любой строки.
  const agg = accs.map(a => a.joins_aggregate_remaining).find(v => v != null);
  if (agg != null
      && String((vals || {}).fleetLabel || '').indexOf('флоту осталось вступлений: ' + agg) === -1)
    problems.push('fleet: в сводке флота нет «флоту осталось вступлений: ' + agg + '»');
}

async function run(file, fixtures) {
  const src = fs.readFileSync(file, 'utf8');
  if (!logicOf(src)) return {file: path.basename(file), skipped: 'нет блока логики'};

  const templated = 'workflow' in declaredProps(src);
  const modes = templated ? MODES : [MODES[0]];

  const runs = [];
  for (const m of modes) {
    const r = await once(file, src, fixtures, m.props);
    // Fleet: открываем панель каждой строки и сверяем рендер остатков с фикстурой.
    if (path.basename(file) === 'RadarFleet.dc.html') {
      for (const row of ((r.vals && r.vals.rows) || [])) {
        try { if (row.open) row.open(); }
        catch (e) { r.problems.push('fleet: открытие панели падает: ' + e.message); }
      }
      checkFleetLimits(fixtures, r.drills, r.vals, r.problems);
    }
    runs.push({...r, label: path.basename(file) + m.suffix});
  }
  return {file: path.basename(file), runs};
}

// ── запуск ────────────────────────────────────────────────────────────────────

(async () => {
  const target = process.argv[2] || '.';
  const dir = fs.statSync(target).isDirectory() ? target : path.dirname(target);
  const fixtures = loadFixtures(dir);

  const files = fs.statSync(target).isDirectory()
    ? fs.readdirSync(target).filter(f => f.endsWith('.dc.html'))
        .map(f => path.join(target, f))
    : [target];

  let bad = 0;
  for (const f of files) {
    let r;
    try { r = await run(f, fixtures); } catch (e) {
      r = {file: path.basename(f), runs: [{label: path.basename(f),
                                           problems: ['сорвался прогон: ' + e.message]}]};
    }
    if (r.skipped) { console.log('   ' + r.file + ' — ' + r.skipped); continue; }
    for (const one of r.runs) {
      if (one.problems.length) {
        bad++;
        console.log('!! ' + one.label);
        for (const p of one.problems) console.log('     ' + p);
      } else {
        console.log('ok ' + one.label + '  (значений: ' + one.keys +
                    (one.rows === null ? '' : ', строк: ' + one.rows) + ')');
      }
    }
  }
  process.exit(bad ? 1 : 0);
})();

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
  };
  vm.createContext(ctx);
  vm.runInContext(tableSrc + '\n;this.__Table = Table;', ctx);

  // Заглушка базового класса: копим setState, как это делал бы рантайм.
  const base = `
    class DCLogic {
      constructor(){ this.props = Object.assign(
        {api:{toast(){}, drill(){}, trace(){}, go(){}, modal(){}}, mobile:false},
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
          rows: Array.isArray(vals.rows) ? vals.rows.length : null};
}

// Экран-шаблон проверяется дважды. Первый вид — общий раздел, второй — раздел
// сценария: там другие ручки, другая форма ответа и другие подписи. Проверь
// только первый — и половина шаблона остаётся вне ворот, а именно она и новая.
const MODES = [
  {suffix: '', props: {}},
  {suffix: ' · сценарий', props: {workflow: 'public_reply',
                                  workflowTitle: 'Публичные ответы'}},
];

async function run(file, fixtures) {
  const src = fs.readFileSync(file, 'utf8');
  if (!logicOf(src)) return {file: path.basename(file), skipped: 'нет блока логики'};

  const templated = 'workflow' in declaredProps(src);
  const modes = templated ? MODES : [MODES[0]];

  const runs = [];
  for (const m of modes) {
    const r = await once(file, src, fixtures, m.props);
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

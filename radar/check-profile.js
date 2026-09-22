// Поведенческая проверка экрана «Profile & Prompts», вкладка «Каскад»:
// строка «Набор (config)» в таблице cfg и раздел «Под капотом»
// (задача cascade-under-hood-gui).
//
// `check-dc.js` ловит синтаксис, `smoke-dc.js` — расхождение разметки и логики
// (но не нажимает кнопки). Здесь проверяется именно новое поведение:
//   • с ключом `cascade.under_the_hood` — раздел есть, блоки по умолчанию
//     свёрнуты, клик раскрывает и закрывает, у промпта три <pre> (системный,
//     шаблон пользовательского сообщения, грамматика), у ступени — таблица
//     параметров, в шаблонах черновиков — подписи групп и `_fallback`;
//   • без ключа (старый сервер, фикстура «/profile [без under_the_hood]») —
//     раздела нет вовсе, экран жив, дырок в разметке не появляется.
// Значения — дословно из `api-fixtures.json`: правится экран под фикстуру,
// а не фикстура под экран.
//
//   node check-profile.js
'use strict';
const fs = require('fs');
const vm = require('vm');

const DIR = __dirname;
const fixtures = JSON.parse(fs.readFileSync(DIR + '/api-fixtures.json', 'utf8'));
const screenSrc = fs.readFileSync(DIR + '/RadarProfile.dc.html', 'utf8');
const markup = screenSrc.slice(0, screenSrc.indexOf('<script type="text/x-dc"'));
const logic = screenSrc.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];

const results = [];
function check(name, cond, extra) {
  results.push([cond ? 'ok  ' : 'FAIL', extra ? name + ' — ' + extra : name]);
}

const PROFILE = fixtures['/profile'];
const PROFILE_OLD = fixtures['/profile [без under_the_hood]'];
const VERSIONS = fixtures['/profile/versions'];
const FILES = fixtures['/profile/config/files'];
const HOOD = PROFILE.cascade.under_the_hood;
if (!PROFILE || !PROFILE.cascade || !HOOD || !PROFILE_OLD || !VERSIONS || !FILES) {
  console.error('нет образцов профиля в api-fixtures.json: /profile (с under_the_hood), /profile [без under_the_hood], /profile/versions, /profile/config/files');
  process.exit(2);
}

const clone = (x) => JSON.parse(JSON.stringify(x));

// ── стенд: экран с подставленными ответами ручек профиля ──────────────────────
function build(opts) {
  opts = opts || {};
  const calls = {get: [], toasts: []};
  const st = {profile: clone(opts.profile || PROFILE)};
  const api = {
    get: async (p) => {
      calls.get.push(p);
      if (p === '/profile') return clone(st.profile);
      if (p === '/profile/versions') return clone(VERSIONS);
      if (p === '/profile/config/files') return clone(FILES);
      throw new Error('нет образца ответа для ' + p);
    },
    post: async (p) => ({ok: true, activated: true}),
    describe: (e) => (e && e.message) ? String(e.message) : String(e),
    isUnauthorized: () => false,
    isForbidden: () => false,
  };
  const ctx = {
    console, setTimeout, clearTimeout, URLSearchParams, Date, Math, JSON, RegExp,
    Blob: class {}, URL: {createObjectURL: () => '', revokeObjectURL: () => {}},
    document: {createElement: () => ({click() {}, remove() {}}),
               body: {appendChild() {}}},
    localStorage: {getItem: () => null, setItem: () => {}},
    location: {hash: ''},
    history: {replaceState: () => {}},
    window: {addEventListener() {}, removeEventListener() {}, open() {}},
    __imp: async () => api,
  };
  vm.createContext(ctx);
  // Заглушка базового класса — как в smoke-dc.js: копим setState по-настоящему.
  const base = `
    class DCLogic {
      constructor(){ this.props = {api: {toast: (t, c) => __toasts.push({t, c})},
                                   mobile: __mobile}; }
      setState(patch, cb){
        const next = typeof patch === 'function' ? patch(this.state) : patch;
        this.state = Object.assign({}, this.state, next);
        if (cb) cb();
      }
    }`;
  ctx.__toasts = calls.toasts;
  ctx.__mobile = !!opts.mobile;
  vm.runInContext(base + '\n' + logic.replace(/await import\(/g, 'await __imp(')
                  + '\n;this.__C = Component;', ctx);
  return {c: new ctx.__C(), calls, st};
}

const sleep = () => new Promise((r) => setTimeout(r, 30));
const vals = (c) => { try { return c.renderVals() || {}; } catch (e) { return {__err: e}; } };
const cfgRow = (v, k) => (v.cfg || []).find((r) => r.k === k);

// Имена, которых просит разметка (как в smoke-dc.js): корни дырок минус
// переменные циклов. Раздел жив, только если все имена логика отдаёт.
function requestedNames(src) {
  const loopVars = new Set();
  for (const m of src.matchAll(/\bas="([^"]+)"/g)) loopVars.add(m[1]);
  const names = new Set();
  for (const m of src.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)) {
    const expr = m[1].trim();
    if (/^(true|false|\d+)$/.test(expr)) continue;
    const root = expr.split('.')[0].trim();
    if (!loopVars.has(root)) names.add(root);
  }
  return names;
}
const NAMES = requestedNames(markup);

// Срез разметки раздела: от комментария «под капотом» до следующей вкладки.
const hoodSlice = markup.slice(markup.indexOf('<!-- под капотом'),
                               markup.indexOf('{{ isFiles }}'));

async function main() {

  // ── H1. С ключом: раздел есть, свёрнут, раскрывается ────────────────────────
  {
    const {c, calls} = build();
    const v0 = vals(c);
    check('H1 renderVals() до загрузки не падает', !v0.__err,
          v0.__err && v0.__err.message);

    await c.componentDidMount(); await sleep();
    const v = vals(c);
    check('H1 GET /profile при монтаже ровно 1',
          calls.get.filter((p) => p === '/profile').length === 1,
          JSON.stringify(calls.get));

    check('H1 с ключом hoodReady === true', v.hoodReady === true,
          JSON.stringify(v.hoodReady));
    const blocks = v.hoodBlocks || [];
    check('H1 блоков 5: ' + HOOD.stages.length + ' ступени + ' +
          HOOD.prompts.length + ' промпта + шаблоны',
          blocks.length === HOOD.stages.length + HOOD.prompts.length + 1,
          'в логике ' + blocks.length);
    check('H1 ключи блоков уникальны',
          new Set(blocks.map((b) => b.key)).size === blocks.length,
          JSON.stringify(blocks.map((b) => b.key)));
    check('H1 все блоки по умолчанию свёрнуты (▾), hoodOpen пуст',
          blocks.every((b) => b.open === false && b.arrow === '▾') &&
          Object.keys(c.state.hoodOpen).length === 0,
          JSON.stringify([blocks.map((b) => b.arrow), c.state.hoodOpen]));

    // Клик: раскрытие и сворачивание ступени L0.
    const l0 = blocks.find((b) => b.key === 'stage:l0');
    check('H1 у блока ступени есть onClick-обработчик', !!l0 && typeof l0.toggle === 'function');
    l0.toggle(); await sleep();
    let v2 = vals(c);
    check('H1 клик раскрыл ступень L0 (▴, hoodOpen запомнен)',
          v2.hoodBlocks.find((b) => b.key === 'stage:l0').open === true &&
          v2.hoodBlocks.find((b) => b.key === 'stage:l0').arrow === '▴' &&
          c.state.hoodOpen['stage:l0'] === true,
          JSON.stringify(c.state.hoodOpen));
    check('H1 остальные блоки после клика всё ещё свёрнуты',
          v2.hoodBlocks.filter((b) => b.key !== 'stage:l0').every((b) => b.open === false));
    v2.hoodBlocks.find((b) => b.key === 'stage:l0').toggle(); await sleep();
    v2 = vals(c);
    check('H1 повторный клик свернул ступень L0 обратно',
          v2.hoodBlocks.find((b) => b.key === 'stage:l0').open === false &&
          Object.keys(c.state.hoodOpen['stage:l0'] ? {x: 1} : {}).length === 0,
          JSON.stringify(c.state.hoodOpen));

    // Ступени: текст, where справа серым, таблица параметров у l0, нет у l1.
    const st0 = HOOD.stages.find((s) => s.key === 'l0');
    const b0 = blocks.find((b) => b.key === 'stage:l0');
    check('H1 ступень L0: заголовок «' + st0.title + '», справа серым where',
          b0.title === st0.title && b0.hint === st0.where && b0.isStage === true,
          JSON.stringify([b0.title, b0.hint]));
    check('H1 ступень L0: таблица параметров «параметр · значение» из фикстуры',
          b0.hasParams === true && b0.paramCols.join('|') === 'Параметр|Значение' &&
          JSON.stringify(b0.paramRows) === JSON.stringify(
            Object.entries(st0.params).map(([k, val]) => ({k, v: String(val)}))),
          JSON.stringify(b0.paramRows));
    const b1 = blocks.find((b) => b.key === 'stage:l1');
    check('H1 ступень L1 без params: таблицы параметров нет',
          b1.hasParams === false && Array.isArray(b1.paramRows) && b1.paramRows.length === 0);

    // Промпты: заголовок «Промпт key · version», серым used_for, три <pre>
    // (системный, шаблон, грамматика) у dm_v1; у public_v1 грамматики нет.
    const pDm = HOOD.prompts.find((p) => p.key === 'dm_v1');
    const bDm = blocks.find((b) => b.key === 'prompt:dm_v1');
    check('H1 промпт dm_v1: «Промпт dm_v1 · ' + pDm.version + '», серым used_for',
          bDm.title === 'Промпт dm_v1 · ' + pDm.version && bDm.hint === pDm.used_for &&
          bDm.isPrompt === true,
          JSON.stringify([bDm.title, bDm.hint]));
    check('H1 промпт dm_v1: три <pre> — системный, шаблон, грамматика (GBNF)',
          bDm.hasGrammar === true && bDm.noGrammar === false &&
          bDm.system === pDm.system && bDm.userTemplate === pDm.user_template &&
          bDm.grammar === pDm.grammar && bDm.grammar.length > 0,
          JSON.stringify([bDm.hasGrammar, bDm.noGrammar,
                          bDm.system.length, bDm.userTemplate.length, bDm.grammar.length]));
    const pPub = HOOD.prompts.find((p) => p.key === 'public_v1');
    const bPub = blocks.find((b) => b.key === 'prompt:public_v1');
    check('H1 промпт public_v1: grammar null → строка «грамматики нет…»',
          bPub.hasGrammar === false && bPub.noGrammar === true &&
          bPub.grammar === null && bPub.title === 'Промпт public_v1 · ' + pPub.version);

    // Шаблоны черновиков: подпись note, контакт, подсписки с _fallback.
    const tpl = HOOD.draft_templates;
    const bTpl = blocks.find((b) => b.key === 'drafts');
    check('H1 блок шаблонов: «Шаблоны черновиков · ' + tpl.prompt_version + '»',
          bTpl.isDrafts === true &&
          bTpl.title === 'Шаблоны черновиков · ' + tpl.prompt_version, bTpl.title);
    check('H1 блок шаблонов: подпись note и «контакт в шаблонах: ' + tpl.contact + '»',
          bTpl.note === tpl.note && bTpl.contactLine === 'контакт в шаблонах: ' + tpl.contact,
          JSON.stringify([bTpl.note, bTpl.contactLine]));
    const dmLabels = bTpl.dmGroups.map((g) => g.label);
    check('H1 «Личка»: боли своими ключами, _fallback → «без распознанной боли», тексты дословно',
          dmLabels.length === Object.keys(tpl.dm).length &&
          dmLabels.includes('без распознанной боли') &&
          !dmLabels.includes('_fallback') &&
          bTpl.dmGroups.every((g) => {
            const src = g.label === 'без распознанной боли'
              ? tpl.dm._fallback : tpl.dm[g.label];
            return JSON.stringify(g.texts) === JSON.stringify(src);
          }),
          JSON.stringify(dmLabels));
    check('H1 «Публичный ответ»: ключи public из фикстуры',
          JSON.stringify(bTpl.publicGroups.map((g) => g.label)) ===
          JSON.stringify(Object.keys(tpl.public)) &&
          bTpl.publicGroups.every((g) => JSON.stringify(g.texts) === JSON.stringify(tpl.public[g.label])),
          JSON.stringify(bTpl.publicGroups.map((g) => g.label)));

    // cfg: «Набор (config)» над «L3 · версия промпта», дата дд.мм чч:мм.
    const bun = HOOD.bundle;
    const iso = String(bun.applied_at);
    const wantBundle = bun.name + ' · ' + iso.slice(8, 10) + '.' + iso.slice(5, 7) +
                       ' ' + iso.slice(11, 16);
    const iBundle = (v.cfg || []).findIndex((r) => r.k === 'Набор (config)');
    const iL3 = (v.cfg || []).findIndex((r) => r.k === 'L3 · версия промпта');
    check('H1 cfg: «Набор (config)» = «' + wantBundle + '», строкой выше «L3 · версия промпта»',
          iBundle >= 0 && iL3 === iBundle + 1 && cfgRow(v, 'Набор (config)').v === wantBundle,
          JSON.stringify(v.cfg && v.cfg.slice(Math.max(0, iBundle - 1), iL3 + 1)));
    check('H1 cfg: у «L3 · версия промпта» подпись про свою нумерацию',
          cfgRow(v, 'L3 · версия промпта').v === PROFILE.cascade.l3_prompt_version +
          ' · нумерация промпта своя: растёт при каждом сохранении текста, к имени набора не привязана',
          cfgRow(v, 'L3 · версия промпта').v);

    // Мутация: bundle = null (набор не применялся) — раздел жив, прочерк в cfg.
    const noBundle = build({profile: Object.assign(clone(PROFILE), {
      cascade: Object.assign(clone(PROFILE.cascade),
                             {under_the_hood: Object.assign(clone(HOOD), {bundle: null})})})});
    await noBundle.c.componentDidMount(); await sleep();
    const vb = vals(noBundle.c);
    check('H1 bundle:null — раздел на месте, в cfg «— (набор не применялся)»',
          vb.hoodReady === true && (vb.hoodBlocks || []).length === blocks.length &&
          cfgRow(vb, 'Набор (config)').v === '— (набор не применялся)',
          cfgRow(vb, 'Набор (config)').v);

    // Разметка раздела: три <pre> у промпта, подписи, мобильный перенос строк.
    check('H1 разметка: в промпт-блоке ровно 3 <pre> с pre-wrap и overflow-wrap',
          (hoodSlice.match(/<pre/g) || []).length === 3 &&
          (hoodSlice.match(/white-space:pre-wrap;overflow-wrap:anywhere/g) || []).length >= 3,
          'pre: ' + (hoodSlice.match(/<pre/g) || []).length);
    for (const frag of ['>Под капотом<',
        'только чтение: так каскад исполняется на сервере сейчас; править — через набор (экспорт/импорт) или код',
        '>системный<', '>шаблон пользовательского сообщения<', '>грамматика (GBNF)<',
        'грамматики нет — модель отвечает свободным текстом',
        '>Личка<', '>Публичный ответ<']) {
      check('H1 разметка: «' + frag.slice(0, 40) + '» на месте',
            hoodSlice.indexOf(frag) !== -1);
    }
    // «без распознанной боли» подставляет логика (ключ _fallback), в разметке
    // её быть не должно — проверено выше по dmGroups.
    check('H1 разметка: раздел целиком под sc-if hoodReady (без ключа — ничего не рисуется)',
          /<sc-if value="\{\{ hoodReady \}\}"/.test(hoodSlice));
    // Мобильная ширина: шапки блоков переносятся (блоки в столбик).
    check('H1 мобильная ширина: у шапки блока flex-wrap:wrap, тело в столбик',
          hoodSlice.indexOf('flex-wrap:wrap') !== -1 &&
          hoodSlice.indexOf('flex-direction:column;gap:10px') !== -1);
    check('H1 дырок нет: все имена разметки логика отдаёт',
          [...NAMES].every((n) => n in v),
          JSON.stringify([...NAMES].filter((n) => !(n in v))));
    // Мобильная ширина: экран жив, блоки остаются в столбце (разметка —
    // flex-direction:column), у <pre> перенос длинных строк не отваливается.
    const mob = build({mobile: true});
    await mob.c.componentDidMount(); await sleep();
    const vmob = vals(mob.c);
    check('H1 mobile:true — раздел на месте, блоки те же, паддинг мобильный',
          vmob.hoodReady === true && (vmob.hoodBlocks || []).length === blocks.length &&
          vmob.pad === '12px',
          JSON.stringify([vmob.hoodReady, vmob.pad]));
    check('H1 mobile:true — клик по блоку работает',
          (vmob.hoodBlocks[0].toggle(), await sleep(), vals(mob.c).hoodBlocks[0].open === true));
  }

  // ── H2. Без ключа (старый сервер): раздела нет, ошибок нет ─────────────────
  {
    const {c} = build({profile: PROFILE_OLD});
    const v0 = vals(c);
    check('H2 renderVals() до загрузки не падает', !v0.__err, v0.__err && v0.__err.message);

    await c.componentDidMount(); await sleep();
    const v = vals(c);
    check('H2 без ключа: hoodReady false, hoodBlocks пуст — раздела нет',
          v.hoodReady === false && Array.isArray(v.hoodBlocks) && v.hoodBlocks.length === 0,
          JSON.stringify([v.hoodReady, v.hoodBlocks && v.hoodBlocks.length]));
    check('H2 без ключа: renderVals() после загрузки не падает', !v.__err,
          v.__err && v.__err.message);
    check('H2 без ключа: в cfg «Набор (config)» = «— (набор не применялся)»',
          cfgRow(v, 'Набор (config)') &&
          cfgRow(v, 'Набор (config)').v === '— (набор не применялся)',
          cfgRow(v, 'Набор (config)') && cfgRow(v, 'Набор (config)').v);
    check('H2 без ключа: у «L3 · версия промпта» та же подпись — она про нумерацию, не про раздел',
          cfgRow(v, 'L3 · версия промпта').v === PROFILE_OLD.cascade.l3_prompt_version +
          ' · нумерация промпта своя: растёт при каждом сохранении текста, к имени набора не привязана',
          cfgRow(v, 'L3 · версия промпта').v);
    check('H2 без ключа: дырок нет (все имена разметки логика отдаёт)',
          [...NAMES].every((n) => n in v),
          JSON.stringify([...NAMES].filter((n) => !(n in v))));
    // Экран жив: вкладка каскада переключается туда и обратно без ошибок.
    vals(c).tabs[2].pick(); await sleep();
    check('H2 без ключа: вкладка «Каскад» открывается, экран жив',
          c.state.tab === 'cascade' && !vals(c).__err);
  }

  // ── отчёт ───────────────────────────────────────────────────────────────────
  let bad = 0;
  for (const [mark, name] of results) {
    if (mark === 'FAIL') bad++;
    console.log(mark + '  ' + name);
  }
  console.log(bad ? '!! check-profile: ' + bad + ' провалено' :
                    'ok check-profile: ' + results.length + ' проверок');
  process.exit(bad ? 1 : 0);
}

main().catch((e) => { console.error('сорвался прогон: ' + (e && e.stack || e)); process.exit(1); });

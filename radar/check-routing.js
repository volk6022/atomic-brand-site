// Скретч-проверка поведенческих свойств правки глубоких ссылок.
// Не часть проекта: исполняет реальные блоки логики оболочки и radar-table.js
// под стабами и прогоняет сценарии, которых не касаются check-dc/smoke-dc.
'use strict';
const fs = require('fs');
const vm = require('vm');

const DIR = __dirname;
const shellSrc = fs.readFileSync(DIR + '/Atomic Radar.dc.html', 'utf8');
const shellLogic = shellSrc.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
const tableSrc = fs.readFileSync(DIR + '/radar-table.js', 'utf8').replace(/^export /gm, '');

const results = [];
function check(name, cond, why){ results.push([cond ? 'ok  ' : 'FAIL', name + (cond || !why ? '' : ' | ' + why)]); }

// ── оболочка ──────────────────────────────────────────────────────────────────
function makeShell(hash, me, workflows){
  const api = {
    get: async (p)=>{
      if(p === '/auth/me') { if(!me) throw new Error('нет сессии'); return JSON.parse(JSON.stringify(me)); }
      if(p === '/workflows') return {rows: workflows || []};
      throw new Error('нет образца: ' + p);
    },
    post: async ()=>({ok:true}),
    describe: (e)=>'ошибка: ' + e.message,
    isUnauthorized: ()=>false,
  };
  const listeners = {};
  const ctx = {
    console, setTimeout:(f)=>0, clearTimeout(){}, URLSearchParams, Date, Math, JSON, RegExp,
    localStorage: {getItem:()=>null, setItem(){}},
    location: {hash},
    history: {replaceState(){}},
    window: {addEventListener:(n,f)=>{(listeners[n] = listeners[n] || []).push(f);},
             removeEventListener(){}},
    __imp: async ()=>api,
  };
  vm.createContext(ctx);
  const base = `
    class DCLogic {
      constructor(){ this.props = Object.assign({}, __props); }
      setState(patch, cb){
        const next = typeof patch === 'function' ? patch(this.state) : patch;
        this.state = Object.assign({}, this.state, next);
      }
    }`;
  ctx.__props = {};
  const prepared = shellLogic.replace(/await import\(/g, 'await __imp(');
  vm.runInContext(base + '\n' + prepared + '\n;this.__C = Component;', ctx);
  // api возвращается наружу: сценариям входа нужно подменять post/isUnauthorized
  // под шаг TOTP (оболочка импортирует модуль через __imp, то есть этот же объект).
  return {ctx, listeners, C: ctx.__C, api};
}

async function mountShell(hash, me, workflows){
  const env = makeShell(hash, me, workflows);
  const c = new env.C();
  await c.componentDidMount();
  return {c, ...env};
}

// То же с мобильным viewport: флаги m.* в renderVals читают this.props.viewport.
async function mountShellM(hash, me, workflows){
  const env = makeShell(hash, me, workflows);
  env.ctx.__props = {viewport:'mobile'};
  const c = new env.C();
  await c.componentDidMount();
  return {c, ...env};
}

(async () => {
  // Список разделов — ДОСЛОВНО тот, что отдаёт `/auth/me` (проверено на проде 03.09).
  // Здесь стоял лишний `draftsTable`, и это ровно та ошибка, из-за которой харнесс
  // пропустил отказ прав у табличного вида сценария: заглушка описывала мир, которого
  // нет. Имя экрана в этот список попадать не должно — сервер знает только разделы.
  const owner = {role:'owner', sections:['dashboard','fleet','channels','stream','leads','drafts',
    'conversations','activity','manual_sends','profile','runs','evals',
    'attribution','observability','safety','admin']};

  // 1. Пустой хеш — дашборд.
  {
    const {c} = await mountShell('', owner);
    check('пустой хеш -> dashboard', c.state.route === 'dashboard');
  }

  // 2. Неразобранный хеш — дашборд.
  {
    const {c} = await mountShell('#nonsense', owner);
    check('#nonsense -> dashboard', c.state.route === 'dashboard');
  }

  // 3. Обычный раздел из хеша.
  {
    const {c} = await mountShell('#safety', owner);
    const v = c.renderVals();
    check('#safety -> route safety', c.state.route === 'safety' && v.v.safety === true);
  }

  // 4. wf-маршрут с параметрами среза.
  {
    const {c} = await mountShell('#wf:cold_dm:targets?size=25&page=3', owner,
      [{key:'cold_dm', title:'Cold DM', sections:[{key:'targets', title:'Цели'}]}]);
    const v = c.renderVals();
    check('#wf:cold_dm:targets?size=25&page=3 -> маршрут и экран leads',
          c.state.route === 'wf:cold_dm:targets' && v.v.leads === true && v.workflowKey === 'cold_dm');
    check('параметры среза разобраны в routeParams',
          c.state.routeParams && c.state.routeParams.size === '25' && c.state.routeParams.page === '3');
  }

  // 4b. Табличный вид очереди внутри сценария. До этого маршрута не было вовсе, и
  //     кнопка «Таблица» уводила из сценария в общую очередь — то есть в числа
  //     чужого конвейера, молча и правдоподобно.
  {
    const {c} = await mountShell('#wf:cold_dm:draftsTable?account=12', owner,
      [{key:'cold_dm', title:'Cold DM', sections:[{key:'drafts', title:'Черновики'}]}]);
    // Реестр сценариев приезжает отдельным запросом, а `setState` в этом стенде не
    // зовёт продолжение: без паузы блок сценария в меню ещё не построен, и проверка
    // про подсветку меряла бы скорость стенда, а не поведение оболочки.
    await new Promise(r=>setTimeout(r, 10));
    const v = c.renderVals();
    check('#wf:cold_dm:draftsTable -> смонтирована таблица, а не очередь',
          v.v.draftsTable === true && v.v.drafts !== true);
    check('таблице сценария передан ключ сценария', v.workflowKey === 'cold_dm');
    const wfItems = [].concat(...(v.nav || []).map(g=>g.items || []));
    check('в меню подсвечен пункт очереди сценария, а не ничего',
          wfItems.some(i=>i.key === 'wf:cold_dm:drafts' && i.mark !== 'transparent'),
          JSON.stringify(wfItems.map(i=>[i.key, i.mark])));
    check('переход из таблицы сценария несёт номер черновика',
          'focusDraft' in v);
  }

  // 5. wf-форма с незнакомым разделом — отказ, а не дашборд и не обход.
  {
    const {c} = await mountShell('#wf:x:bogus', owner);
    const v = c.renderVals();
    check('#wf:x:bogus -> отказ (denied)', c.state.route === 'wf:x:bogus' && v.denied === true);
  }

  // 6. Ключ таблицы, не совпавший с маршрутом: алиас и старая форма.
  {
    const {c} = await mountShell('#audit?size=100', owner);
    check('#audit -> admin', c.state.route === 'admin');
  }
  {
    const {c} = await mountShell('#targets:cold_dm?page=2', owner,
      [{key:'cold_dm', title:'Cold DM', sections:[{key:'targets', title:'Цели'}]}]);
    check('#targets:cold_dm -> wf:cold_dm:targets', c.state.route === 'wf:cold_dm:targets');
  }

  // 7. ПРАВА: ссылка на чужой раздел даёт отказ, а не обход. Роль из сервера.
  {
    const viewer = {role:'viewer', sections:['dashboard','attribution']};
    const {c} = await mountShell('#admin', viewer);
    const v = c.renderVals();
    check('viewer + #admin -> отказ, экран не смонтирован',
          v.denied === true && v.v.admin === false);
  }
  {
    const customer = {role:'customer', sections:['dashboard','channels','stream','leads','drafts','conversations','manual_sends','activity','profile','runs','evals','attribution','safety']};
    const {c} = await mountShell('#wf:secret:drafts', customer,
      [{key:'secret', title:'Секретный', sections:[{key:'drafts', title:'Черновики'}]}]);
    const v = c.renderVals();
    check('customer + #wf:secret:drafts (drafts разрешён) -> экран смонтирован',
          v.denied === false && v.v.drafts === true && v.workflowKey === 'secret');
  }

  // 8. go() пишет хеш; эхо hashchange не применяется повторно.
  //    С 14.09 программный go('drafts') без сценария переадресуется в очередь
  //    черновиков cold_dm, НО переход С focusDraft остаётся в СТАРОЙ очереди:
  //    id в нём из старого пространства (`/drafts/list`, клик по строке
  //    #draftsTable), и в cold_dm тот же номер значит другой черновик
  //    (14.8.14, стенд 14.09: #452 → чужая цель 579).
  {
    const {c, ctx} = await mountShell('#dashboard', owner);
    c.go('drafts', {focusDraft:41});
    check("go('drafts',{focusDraft:41}) без сценария остаётся в старой очереди: '#drafts?focusDraft=41'",
          ctx.location.hash === '#drafts?focusDraft=41' &&
          c.state.route === 'drafts',
          ctx.location.hash);
    check('routeParams сохранены как переданы (число)', c.state.routeParams.focusDraft === 41);
    const v = c.renderVals();
    check('смонтирован СТАРЫЙ экран очереди (v.drafts, workflowKey пуст)',
          v.v.drafts === true && v.workflowKey === '' && v.denied === false,
          'workflowKey=' + v.workflowKey);
    c.applyHash();  // эхо собственного присваивания
    check('эхо hashchange пропущено', c.state.routeParams.focusDraft === 41);
  }

  // 9. Кнопка «назад»: адрес изменился извне — применился. Переход с focusDraft
  //    из старого пространства остаётся в старой очереди; вперёд — на прямой
  //    хеш #drafts: тот по-прежнему открывает СТАРЫЙ экран (архив), программа
  //    с фокусом уходит туда же, голая — переадресуется (см. 25).
  {
    const {c, ctx} = await mountShell('#leads', owner);
    c.go('drafts', {focusDraft:7});
    check("go('drafts',{focusDraft:7}) остаётся в старой очереди",
          ctx.location.hash === '#drafts?focusDraft=7', ctx.location.hash);
    ctx.location.hash = '#channels';       // браузер вернулся назад
    c.applyHash();
    check('назад на #channels применился', c.state.route === 'channels');
    ctx.location.hash = '#drafts?focusDraft=7';
    c.applyHash();
    check('вперёд на прямой #drafts?focusDraft=7 открыл старый экран (без переадресации)',
          c.state.route === 'drafts' && c.state.routeParams.focusDraft === '7');
  }

  // 10. Слушатель hashchange повешен на монтировании; хеш применён до /auth/me.
  {
    const env = makeShell('#runs', null);   // /auth/me бросит — сессии нет
    const c = new env.C();
    await c.componentDidMount();
    check('hashchange listener повешен', !!(env.listeners.hashchange && env.listeners.hashchange.length));
    check('без сессии маршрут из хеша всё равно применён',
          c.state.route === 'runs' && c.state.authed === false);
  }

  // 11. Примерка роли уводит на дашборд через go(): адрес поспевает.
  {
    const {c, ctx} = await mountShell('#safety', owner);
    const v = c.renderVals();
    const pick = v.roleOptions.find(r=>r.label === 'viewer');
    pick.pick();
    check('примерка viewer: маршрут и адрес стали дашбордом',
          c.state.route === 'dashboard' && ctx.location.hash === '#dashboard');
  }

  // 12. Таблица: чтение wf-формы и обратная запись в ней же.
  {
    const writes = [];
    const ctx = {console, setTimeout:(f)=>0, clearTimeout(){}, URLSearchParams,
                 localStorage:{getItem:()=>null, setItem(){}},
                 location:{hash:'#wf:cold_dm:targets?page=3&size=25&sort=author&order=asc&q=%D0%B8%D0%B2%D0%B0%D0%BD&status=new'},
                 history:{replaceState:(a,b,url)=>writes.push(url)}};
    vm.createContext(ctx);
    vm.runInContext(tableSrc + '\n;this.__T = Table;', ctx);
    const t = new ctx.__T({key:'targets:cold_dm', size:50, sort:'score', order:'desc',
                           sorts:[{key:'author'},{key:'score'}], filters:{status:'', channel_id:''}});
    check('таблица читает срез из wf-формы',
          t.page === 3 && t.size === 25 && t.sort === 'author' && t.order === 'asc'
          && t.q === 'иван' && t.filters.status === 'new');
    t.attach(()=>{});
    check('таблица пишет адрес в wf-форме (routeOf)',
          writes[0] === '#wf:cold_dm:targets?page=3&size=25&sort=author&order=asc&q=%D0%B8%D0%B2%D0%B0%D0%BD&status=new');
  }

  // 13. Таблица: старая форма «раздел:сценарий» тоже читается.
  {
    const ctx = {console, setTimeout:(f)=>0, clearTimeout(){}, URLSearchParams,
                 localStorage:{getItem:()=>null, setItem(){}},
                 location:{hash:'#targets:cold_dm?page=2'}, history:{replaceState(){}}};
    vm.createContext(ctx);
    vm.runInContext(tableSrc + '\n;this.__T = Table;', ctx);
    const t = new ctx.__T({key:'targets:cold_dm', size:50, sorts:[], filters:{}});
    check('таблица читает старую форму раздел:сценарий', t.page === 2);
  }

  // 14. Таблица общего раздела: адрес по-прежнему без wf.
  {
    const writes = [];
    const ctx = {console, setTimeout:(f)=>0, clearTimeout(){}, URLSearchParams,
                 localStorage:{getItem:()=>null, setItem(){}},
                 location:{hash:'#channels'}, history:{replaceState:(a,b,url)=>writes.push(url)}};
    vm.createContext(ctx);
    vm.runInContext(tableSrc + '\n;this.__T = Table;', ctx);
    const t = new ctx.__T({key:'channels', size:50, sort:'title', order:'desc',
                           sorts:[{key:'title'}], filters:{}});
    t.attach(()=>{});
    check('таблица общего раздела пишет "#channels?..."',
          writes[0] === '#channels?size=50&sort=title&order=desc');
  }

  // 15. DraftsTable: чтение фильтров из хеша и обратная запись. С 14.9 (правка
  //     таблицы черновиков, параллельная задача) срез живёт в radar-table.js:
  //     экран строит this.table, имена фильтров в адресе — имена параметров
  //     сервера (`state`, не старый `filter`), min_score — строка.
  {
    const dtSrc = fs.readFileSync(DIR + '/RadarDraftsTable.dc.html', 'utf8')
      .match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
    const writes = [];
    const got = [];
    const dtApi = {get: async (p, params)=>{got.push({p, params});
                        if(p === '/channels/options') return [];
                        return {rows:[], total:0, states:{}};}};
    const ctx = {console, setTimeout:(f)=>0, clearTimeout(){}, URLSearchParams, Date, Math, JSON,
                 localStorage:{getItem:()=>null, setItem(){}},
                 location:{hash:'#draftsTable?state=approved&channel=VPS%20Talk&min_score=40&q=%D0%B1%D0%BE%D0%BB%D1%8C'},
                 history:{replaceState:(a,b,url)=>writes.push(url)},
                 window:{addEventListener(){}, removeEventListener(){}},
                 __imp: async ()=>dtApi};
    vm.createContext(ctx);
    // RadarDraftsTable с 14.9 держит срез в radar-table.js: `const { Table } =
    // await import('./radar-table.js')`. Голый стенд динамические модули не
    // исполняет — кладём в контекст настоящий Table под теми же стабами
    // (как в 12–14), иначе `this.Table` в экране undefined.
    vm.runInContext(tableSrc + '\n;this.__Table = Table;', ctx);
    dtApi.Table = ctx.__Table;
    const base = `class DCLogic { constructor(){ this.props = {}; }
      setState(p, cb){ const n = typeof p === 'function' ? p(this.state) : p;
        this.state = Object.assign({}, this.state, n); if(cb) cb(); } }`;
    ctx.__props = {};
    vm.runInContext(base + '\n' + dtSrc.replace(/await import\(/g, 'await __imp(') + '\n;this.__D = Component;', ctx);
    const d = new ctx.__D();
    await d.componentDidMount();
    // Экран перед списком тянет /channels/options: без паузы проверка ниже
    // меряла бы скорость стенда, а не поведение.
    await new Promise(r=>setTimeout(r, 5));
    check('draftsTable читает фильтры из хеша (в this.table)',
          !!d.table && d.table.q === 'боль' && d.table.filters.state === 'approved'
          && d.table.filters.channel === 'VPS Talk' && d.table.filters.min_score === '40');
    check('draftsTable шлёт фильтры на сервер', got.some(x=>x.p === '/drafts/list' && x.params
          && x.params.state === 'approved' && x.params.channel === 'VPS Talk'
          && x.params.min_score === '40' && x.params.q === 'боль'));
    check('draftsTable пишет свой срез в адрес',
          writes.some(w=>w.indexOf('#draftsTable?') === 0 &&
            w.indexOf('state=approved') !== -1 &&
            w.indexOf('q=%D0%B1%D0%BE%D0%BB%D1%8C') !== -1));
  }

  // ── Волна Ж: маршруты «Автоматики» и «Подбора каналов» (G-50…G-55) ──────────
  // Экраны automation/discovery серверных разделов не имеют: /auth/me отдаёт
  // runs и channels, право проходит через SECTION_OF. Имена automation,
  // discovery, backfill в стаб `/auth/me` попадать не должны — G-53 ниже читает
  // литерал стоба и держит прецедент draftsTable (сценарий 4b) на замке.

  // 16. G-50: #automation у владельца монтируется, пункт меню подсвечен сам.
  {
    const {c} = await mountShell('#automation', owner);
    const v = c.renderVals();
    check('G-50 #automation -> route automation, экран смонтирован',
          c.state.route === 'automation' && v.v.automation === true && v.denied === false);
    const navItems = [].concat(...(v.nav || []).map(g=>g.items || []));
    const item = navItems.find(i=>i.key === 'automation');
    check('G-50 пункт меню «Автоматика» подсвечен',
          !!item && item.mark === '#DA501C' && item.bg !== 'transparent',
          JSON.stringify(navItems.map(i=>[i.key, i.mark])));
    const {c: cm} = await mountShellM('#automation', owner);
    check('G-50 мобильный viewport: m.automation === true',
          cm.renderVals().m.automation === true);
  }

  // 17. G-51: #discovery — то же, что G-50.
  {
    const {c} = await mountShell('#discovery', owner);
    const v = c.renderVals();
    check('G-51 #discovery -> route discovery, экран смонтирован',
          c.state.route === 'discovery' && v.v.discovery === true && v.denied === false);
    const navItems = [].concat(...(v.nav || []).map(g=>g.items || []));
    const item = navItems.find(i=>i.key === 'discovery');
    check('G-51 пункт меню «Подбор каналов» подсвечен',
          !!item && item.mark === '#DA501C' && item.bg !== 'transparent',
          JSON.stringify(navItems.map(i=>[i.key, i.mark])));
    const {c: cm} = await mountShellM('#discovery', owner);
    check('G-51 мобильный viewport: m.discovery === true',
          cm.renderVals().m.discovery === true);
  }

  // 18. G-52: долг №3 закрыт — «Дочитывание» открывается у владельца, хотя
  //     имени backfill в /auth/me.sections нет: право идёт через алиас channels.
  {
    const {c} = await mountShell('#backfill', owner);
    const v = c.renderVals();
    check('G-52 #backfill -> v.backfill === true (без SECTION_OF раздел скрыт у всех)',
          c.state.route === 'backfill' && v.v.backfill === true && v.denied === false);
  }

  // 19. G-53: стаб /auth/me не выдумывает разделы. Читается литерал стоба выше:
  //     серверных имён automation/discovery/backfill там нет, как и имени экрана
  //     draftsTable (прецедент: заглушка описывала мир, которого нет, и пропустила
  //     реальный отказ прав).
  {
    check('G-53 в стабе /auth/me нет automation/discovery/backfill/draftsTable',
          ['automation', 'discovery', 'backfill', 'draftsTable']
            .every(k=>owner.sections.indexOf(k) === -1),
          JSON.stringify(owner.sections));
  }

  // 20. G-54: отказ без права и право через алиас, не через собственное имя.
  {
    const viewer = {role:'viewer', sections:['dashboard','attribution']};
    const {c} = await mountShell('#automation', viewer);
    let v = c.renderVals();
    check('G-54 viewer + #automation -> отказ, экран не смонтирован',
          v.denied === true && v.v.automation === false);
    const {c: c2} = await mountShell('#discovery', viewer);
    v = c2.renderVals();
    check('G-54 viewer + #discovery -> отказ',
          v.denied === true && v.v.discovery === false);
    const customer = {role:'customer', sections:['dashboard','channels','stream','leads','drafts','conversations','manual_sends','activity','profile','runs','evals','attribution','safety']};
    const {c: c3} = await mountShell('#automation', customer);
    v = c3.renderVals();
    check('G-54 customer (есть runs) + #automation -> смонтирован через алиас',
          v.denied === false && v.v.automation === true);
    const {c: c4} = await mountShell('#discovery', customer);
    v = c4.renderVals();
    check('G-54 customer (есть channels) + #discovery -> смонтирован через алиас',
          v.denied === false && v.v.discovery === true);
  }

  // 21. G-55: маршруты пишутся в адрес, «назад» отрабатывает (как в 8–9).
  {
    const {c, ctx} = await mountShell('#dashboard', owner);
    c.go('automation');
    check("G-55 go('automation') пишет '#automation'", ctx.location.hash === '#automation');
    c.go('discovery');
    check("G-55 go('discovery') пишет '#discovery'", ctx.location.hash === '#discovery');
    ctx.location.hash = '#channels';       // браузер вернулся назад
    c.applyHash();
    check('G-55 назад на #channels применился', c.state.route === 'channels');
  }

  // G-56 — мутация, в файл не кодируется: убрать `automation:'runs'` из
  // SECTION_OF в обеих копиях оболочки -> краснеют G-50 и G-54 (customer);
  // вернуть. G-57 — существующие сценарии 1–15 зелёные без правки.

  // ── Скрытие общего «Drafts» из панели, переадресация go('drafts') (14.09) ───
  // План 14.1а: пункт убран (HIDDEN_NAV), маршрут #drafts жив по прямой ссылке
  // как архив, программный переход без сценария переадресуется в cold_dm.

  // 22. Прямой хеш #drafts открывает СТАРЫЙ экран — переадресация его не задевает.
  {
    const {c} = await mountShell('#drafts?focusDraft=41', owner);
    const v = c.renderVals();
    check('прямой #drafts?focusDraft=41 -> старый экран смонтирован',
          c.state.route === 'drafts' && v.v.drafts === true && v.denied === false,
          'route=' + c.state.route);
    check('прямой #drafts: параметр фокуса разобран',
          !!c.state.routeParams && c.state.routeParams.focusDraft === '41');
  }

  // 23. Пункта drafts в отрендеренной панели нет; сценарный «Черновики» на месте.
  {
    const {c} = await mountShell('#dashboard', owner,
      [{key:'cold_dm', title:'Личные сообщения', sections:[{key:'drafts', title:'Черновики'}]}]);
    await new Promise(r=>setTimeout(r, 10));
    const v = c.renderVals();
    const items = [].concat(...(v.nav || []).map(g=>g.items || []));
    check('пункта «Drafts» (общего) в панели нет',
          items.every(i=>i.key !== 'drafts'), JSON.stringify(items.map(i=>i.key)));
    check('сценарный пункт «Черновики» cold_dm в панели есть',
          items.some(i=>i.key === 'wf:cold_dm:drafts' && i.label === 'Черновики'));
  }

  // 24. Палитра «→ Драфты на ревью» и мобильный таб «Drafts» ведут в сценарную
  //     очередь, а не в старый экран.
  {
    const {c, ctx} = await mountShell('#dashboard', owner);
    const v = c.renderVals();
    const pal = (v.cmdItems || []).find(i=>/Драфты/.test(i.label));
    pal.go();
    check('палитра «→ Драфты на ревью» открывает wf:cold_dm:drafts',
          c.state.route === 'wf:cold_dm:drafts' && ctx.location.hash === '#wf:cold_dm:drafts',
          ctx.location.hash);
    const tab = (v.tabs || []).find(t=>t.label === 'Drafts');
    tab.go();
    check('мобильный таб «Drafts» открывает wf:cold_dm:drafts',
          c.state.route === 'wf:cold_dm:drafts' && ctx.location.hash === '#wf:cold_dm:drafts',
          ctx.location.hash);
    // Подсветка считается при рендере: снимок v сделан до перехода, нужен новый.
    const tab2 = c.renderVals().tabs.find(t=>t.label === 'Drafts');
    check('таб «Drafts» подсвечен на сценарном маршруте',
          tab2.fg === '#F8F3E0' && tab2.mark === '#DA501C');
  }

  // 25. ГОЛЫЙ переход из экрана монтирует очередь сценария: те же v.drafts и
  //     workflowKey, что у прямого клика по пункту блока cold_dm. Сюда попадают
  //     дашборд (плитка и очередь с go:'drafts' из payload), кнопка «Открыть
  //     очередь черновиков» в Leads и goQueue общей таблицы — все зовут
  //     api.go('drafts') оболочки. Переход С focusDraft сюда больше не попадает:
  //     он остаётся в старой очереди (см. 8–9, 14.8.14).
  {
    const {c, ctx} = await mountShell('#dashboard', owner,
      [{key:'cold_dm', title:'Личные сообщения', sections:[{key:'drafts', title:'Черновики'}]}]);
    c.go('drafts');
    check("голый go('drafts') без сценария пишет '#wf:cold_dm:drafts'",
          ctx.location.hash === '#wf:cold_dm:drafts' && c.state.route === 'wf:cold_dm:drafts',
          ctx.location.hash);
    const v = c.renderVals();
    check("go('drafts') монтирует экран очереди с ключом сценария cold_dm",
          v.v.drafts === true && v.workflowKey === 'cold_dm' && v.denied === false,
          'workflowKey=' + v.workflowKey);
  }

  // 26. Блоки сценариев стоят сразу после «Флот и данные» (Иван, 14.09: очереди
  //     личных и публичных сообщений — самые нужные экраны, а были в хвосте панели).
  //     У заказчика группы «Флот и данные» нет вовсе (fleet закрыт, channels/stream
  //     есть) — тогда блоки идут после неё же; у роли без обеих — после Dashboard.
  {
    const wfs = [{key:'cold_dm', title:'Cold DM', sections:[{key:'drafts', title:'Черновики'}]},
                 {key:'public_reply', title:'Public reply', sections:[{key:'drafts', title:'Черновики'}]}];
    const {c} = await mountShell('#dashboard', owner, wfs);
    await new Promise(r=>setTimeout(r, 10));
    const titles = (c.renderVals().nav || []).map(g=>g.title);
    const i = titles.indexOf('Флот и данные');
    check('owner: блоки сценариев сразу после «Флот и данные»',
          i !== -1 && titles[i + 1] === 'Cold DM' && titles[i + 2] === 'Public reply',
          JSON.stringify(titles));
    check('owner: «Конвейер лидов» идёт после блоков сценариев',
          titles.indexOf('Конвейер лидов') > titles.indexOf('Public reply'), JSON.stringify(titles));

    const customer = {role:'customer', sections:['dashboard','channels','stream','leads','drafts','conversations','manual_sends','activity','profile','runs','evals','attribution','safety']};
    const m = await mountShell('#dashboard', customer, wfs);
    await new Promise(r=>setTimeout(r, 10));
    const t2 = (m.c.renderVals().nav || []).map(g=>g.title);
    const j = t2.indexOf('Флот и данные');
    check('customer: блоки сценариев сразу после «Флот и данные»',
          j !== -1 && t2[j + 1] === 'Cold DM' && t2[j + 2] === 'Public reply', JSON.stringify(t2));

    const bare = {role:'viewer', sections:['dashboard','leads','drafts']};
    const b = await mountShell('#dashboard', bare, wfs);
    await new Promise(r=>setTimeout(r, 10));
    const t3 = (b.c.renderVals().nav || []).map(g=>g.title);
    check('роль без «Флот и данные»: блоки сценариев после Dashboard',
          t3[0] === 'Dashboard' && t3[1] === 'Cold DM', JSON.stringify(t3));
  }

  // ── Старый контур «Leads» спрятан, общий go('leads') ведёт в цели cold_dm ───
  // План 14.9 п.2 (14.8.16): статусы `/api/v1/leads` разошлись со сценарными
  // (`/workflows/cold_dm/targets`), и второй «правильный на вид» путь решения
  // по устаревшим данным закрыт — так же, как «Drafts» 13.09.

  // 27. Пункта leads в отрендеренной панели нет (drafts — тоже), сценарные
  //     пункты «Цели» на месте; go('leads') переадресуется в цели cold_dm и
  //     монтирует экран целей; мобильный таб заменён; прямой хеш #leads
  //     открывает СТАРЫЙ экран Leads (applyHash() идёт мимо go()).
  {
    const {c, ctx} = await mountShell('#dashboard', owner,
      [{key:'cold_dm', title:'Личные сообщения',
        sections:[{key:'targets', title:'Цели'}, {key:'drafts', title:'Черновики'}]}]);
    await new Promise(r=>setTimeout(r, 10));
    const v = c.renderVals();
    const items = [].concat(...(v.nav || []).map(g=>g.items || []));
    check('пункта «Leads» (общего) в панели нет',
          items.every(i=>i.key !== 'leads'), JSON.stringify(items.map(i=>i.key)));
    check('пункта «Drafts» (общего) в панели по-прежнему нет',
          items.every(i=>i.key !== 'drafts'));
    check('сценарный пункт «Цели» cold_dm в панели есть (скрытие leads его не задевает)',
          items.some(i=>i.key === 'wf:cold_dm:targets' && i.label === 'Цели'));
    c.go('leads');
    check("go('leads') без сценария пишет '#wf:cold_dm:targets'",
          c.state.route === 'wf:cold_dm:targets' && ctx.location.hash === '#wf:cold_dm:targets',
          ctx.location.hash);
    const v2 = c.renderVals();
    check('смонтирован экран целей с ключом сценария cold_dm',
          v2.v.leads === true && v2.workflowKey === 'cold_dm' && v2.denied === false,
          'workflowKey=' + v2.workflowKey);
    ctx.location.hash = '#dashboard';      // чтобы клик по табу был честным
    c.applyHash();
    const tab = (c.renderVals().tabs || []).find(t=>t.label === 'Цели');
    tab.go();
    check('мобильный таб «Цели» открывает wf:cold_dm:targets',
          c.state.route === 'wf:cold_dm:targets' && ctx.location.hash === '#wf:cold_dm:targets',
          ctx.location.hash);
    const tabHot = c.renderVals().tabs.find(t=>t.label === 'Цели');
    check('таб «Цели» подсвечен на сценарном маршруте',
          tabHot.fg === '#F8F3E0' && tabHot.mark === '#DA501C');
    const {c: c3} = await mountShell('#leads', owner);
    const v3 = c3.renderVals();
    check('прямой хеш #leads монтирует старый экран Leads (без переадресации)',
          c3.state.route === 'leads' && v3.v.leads === true &&
          v3.workflowKey === '' && v3.denied === false,
          'route=' + c3.state.route);
  }

  // 28. Сценарный переход с focusDraft не изменился: там id из пространства
  //     сценария, и он обязан попадать в сценарную очередь. Правка 14.8.14 —
  //     только про ГОЛЫЙ переход общего контура.
  {
    const {c, ctx} = await mountShell('#dashboard', owner,
      [{key:'cold_dm', title:'Личные сообщения', sections:[{key:'drafts', title:'Черновики'}]}]);
    c.go('wf:cold_dm:drafts', {focusDraft:452});
    check("go('wf:cold_dm:drafts',{focusDraft:452}) пишет '#wf:cold_dm:drafts?focusDraft=452'",
          ctx.location.hash === '#wf:cold_dm:drafts?focusDraft=452' &&
          c.state.routeParams.focusDraft === 452,
          ctx.location.hash);
  }

  // 29. Прямой хеш #draftsTable по-прежнему открывает СТАРУЮ таблицу
  //     (applyHash() идёт мимо go(), подмены маршрутов её не задевают).
  {
    const {c} = await mountShell('#draftsTable?filter=approved', owner);
    const v = c.renderVals();
    check('прямой #draftsTable -> старая таблица смонтирована',
          c.state.route === 'draftsTable' && v.v.draftsTable === true &&
          v.workflowKey === '' && v.denied === false,
          'route=' + c.state.route);
  }

  // ── Вход: шаг TOTP — сообщение при неверном коде и кнопка «Подтвердить» ──────
  // План 14.9 шаг 3 (14.8.1 + 14.8.2). Оболочка исполняется под стабами api из
  // makeShell: в каждом сценарии подменяются post/isUnauthorized — так же, как
  // их ведёт себя radar-api.js в браузере (401 = неверный код, остальное —
  // describe(e)). На шаг TOTP через хеш не попасть: state ставится руками,
  // ровно так, как его оставляет успешный /auth/login.
  const flush = ()=>new Promise(r=>setTimeout(r, 5));
  async function mountTotp(totp){
    const env = await mountShell('#dashboard', null);   // /auth/me бросит — на форме входа
    env.c.setState({step:'totp', totp: totp || '', authed:false});
    return env;
  }

  // 30. 14.8.1: 401 от /auth/totp -> сообщение на шаге TOTP, поле очищено,
  //     authed:false, шаг остаётся totp; loginError не тронут — он про шаг логина.
  {
    const {c, api} = await mountTotp('000000');
    api.post = async (p)=>{
      if(p === '/auth/totp'){ const e = new Error('/auth/totp → 401'); e.status = 401; throw e; }
      return {ok:true};
    };
    api.isUnauthorized = (e)=>!!e && e.status === 401;
    const v = c.renderVals();
    await v.setTotp({target:{value:'000000'}});
    await flush();
    check('14.8.1 неверный код: totpError непустой, шаг остаётся totp',
          !!c.state.totpError && c.state.step === 'totp', c.state.totpError);
    check('14.8.1 неверный код: поле очищено, authed:false, loginError не тронут',
          c.state.totp === '' && c.state.authed === false && c.state.loginError === false,
          JSON.stringify({totp:c.state.totp, authed:c.state.authed, loginError:c.state.loginError}));
    const v2 = c.renderVals();
    check('14.8.1 сообщение рисуется именно на шаге TOTP (v.stepTotp + точный текст)',
          v2.v.stepTotp === true &&
          v2.totpError === 'Неверный код. Код обновляется каждые 30 секунд',
          v2.totpError);
  }

  // 31. 14.8.1: не-401 (сеть/5xx/мёртвая сессия логина) -> текст от describe(e),
  //     ссылка «Вернуться ко входу» (totpBack), поле не очищено; возврат
  //     возвращает на шаг логина и чистит ошибку.
  {
    const {c, api} = await mountTotp('123456');
    api.post = async (p)=>{
      if(p === '/auth/totp') throw new Error('сеть недоступна');
      return {ok:true};
    };  // isUnauthorized стаба по умолчанию false; describe — штатный стаб
    const v = c.renderVals();
    await v.doTotp();
    await flush();
    check('14.8.1 не-401: totpError из describe(e), ссылка возврата включена',
          c.state.totpError === 'ошибка: сеть недоступна' && c.state.totpBack === true,
          c.state.totpError);
    check('14.8.1 не-401: поле не очищено (код можно поправить), authed:false',
          c.state.totp === '123456' && c.state.authed === false,
          JSON.stringify({totp:c.state.totp}));
    const v2 = c.renderVals();
    v2.backToLogin({preventDefault(){}});
    check('«Вернуться ко входу»: шаг login, ошибка и код сброшены',
          c.state.step === 'login' && c.state.totpError === '' &&
          c.state.totp === '' && c.state.totpBack === false,
          JSON.stringify({step:c.state.step, err:c.state.totpError}));
  }

  // 32. 14.8.2: кнопка «Подтвердить» с шестью цифрами в state — /auth/totp
  //     уходит ровно один раз с этим кодом; на успехе authed:true, me из ответа,
  //     реестр сценариев перечитан (/workflows дёрнут), поток открыт (openStream).
  {
    const {c, api} = await mountTotp('654321');
    const me = {role:'owner', sections:['dashboard'], name:'Сервер', initials:'С'};
    const posts = [];
    api.post = async (p, body)=>{
      posts.push([p, body]);
      if(p === '/auth/totp') return me;
      return {ok:true};
    };
    const wfHits = [];
    const origGet = api.get;
    api.get = async (p, params)=>{ if(p === '/workflows') wfHits.push(p); return origGet(p, params); };
    let streams = 0;
    const origStream = c.openStream;
    c.openStream = function(){ streams++; return origStream.apply(this, arguments); };
    const v = c.renderVals();
    await v.doTotp();
    await flush();
    check('14.8.2 «Подтвердить»: /auth/totp отправлен ровно один раз с кодом из поля',
          posts.length === 1 && posts[0][0] === '/auth/totp' && posts[0][1].code === '654321',
          JSON.stringify(posts));
    check('14.8.2 успех: authed:true, me/serverRole/sections из ответа сервера',
          c.state.authed === true && c.state.me === me &&
          c.state.serverRole === 'owner' && c.state.sections === me.sections,
          JSON.stringify({authed:c.state.authed, role:c.state.serverRole}));
    check('14.8.2 успех: реестр сценариев перечитан (/workflows) и поток открыт',
          wfHits.length === 1 && streams === 1,
          JSON.stringify({workflows:wfHits.length, streams}));
  }

  // 33. 14.8.2: кнопка с тремя цифрами запрос не шлёт — вместо него подсказка.
  {
    const {c, api} = await mountTotp('123');
    const posts = [];
    api.post = async (p, body)=>{ posts.push([p, body]); return {ok:true}; };
    const v = c.renderVals();
    await v.doTotp();
    await flush();
    check('14.8.2 три цифры: запрос не отправлен, подсказка «Введите 6 цифр»',
          posts.length === 0 && c.state.totpError === 'Введите 6 цифр' &&
          c.state.authed === false && c.state.step === 'totp',
          JSON.stringify({posts:posts.length, err:c.state.totpError}));
  }

  // 34. Автоотправка при вводе шестой цифры сохранилась: setTotp фильтрует ввод
  //     и сам зовёт общий submitTotp, когда стало шесть.
  {
    const {c, api} = await mountTotp('');
    const me = {role:'viewer', sections:['dashboard'], name:'Авто', initials:'А'};
    const posts = [];
    api.post = async (p, body)=>{
      posts.push([p, body]);
      if(p === '/auth/totp') return me;
      return {ok:true};
    };
    const v = c.renderVals();
    await v.setTotp({target:{value:'12аб34'}});
    check('фильтрация ввода не изменилась: не-цифры отброшены, отправки ещё нет',
          c.state.totp === '1234' && posts.length === 0,
          JSON.stringify({totp:c.state.totp, posts:posts.length}));
    await v.setTotp({target:{value:'123456'}});
    await flush();
    check('14.8.2 шестая цифра через setTotp отправляет код сама',
          posts.length === 1 && posts[0][1].code === '123456' && c.state.authed === true,
          JSON.stringify({posts:posts.length, authed:c.state.authed}));
  }

  // Мутации, в файл не кодируемые: убрать 'drafts' из HIDDEN_NAV в обеих копиях
  // оболочки -> краснеет 23; убрать 'leads' из HIDDEN_NAV -> краснеет 27 (первая
  // проверка); вернуть безусловную подмену drafts в go() (`if(route === 'drafts')`)
  // -> краснеют 8 и 9 (первая проверка каждого; 22 по прямому хешу остаётся
  // зелёным — applyHash() идёт мимо go()); убрать переадресацию leads в go()
  // -> краснеет 27; вернуть `nav.push` вместо `splice` по якорю -> краснеет 26;
  // вернуть заглушку `doTotp:()=>{}` в renderVals обеих копий -> краснеют
  // 31 (не-401), 32 (все три) и 33 — они зовут кнопку; в submitTotp на 401
  // писать loginError вместо totpError -> краснеет 30 (первая и третья проверки).

  let bad = 0;
  for(const [st, name] of results){ console.log(st + ' ' + name); if(st === 'FAIL') bad++; }
  console.log(bad ? ('--- ПРОВАЛОВ: ' + bad) : '--- все проверки прошли');
  process.exit(bad ? 1 : 0);
})().catch(e=>{ console.error('сорвался: ' + e.stack); process.exit(2); });

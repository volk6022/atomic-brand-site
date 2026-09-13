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
  return {ctx, listeners, C: ctx.__C};
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
  //    С 14.09 общий «Drafts» из панели спрятан (HIDDEN_NAV), и программный
  //    go('drafts') без сценария переадресуется в очередь черновиков cold_dm.
  {
    const {c, ctx} = await mountShell('#dashboard', owner);
    c.go('drafts', {focusDraft:41});
    check("go('drafts',{focusDraft:41}) без сценария пишет '#wf:cold_dm:drafts?focusDraft=41'",
          ctx.location.hash === '#wf:cold_dm:drafts?focusDraft=41' &&
          c.state.route === 'wf:cold_dm:drafts',
          ctx.location.hash);
    check('routeParams сохранены как переданы (число)', c.state.routeParams.focusDraft === 41);
    c.applyHash();  // эхо собственного присваивания
    check('эхо hashchange пропущено', c.state.routeParams.focusDraft === 41);
  }

  // 9. Кнопка «назад»: адрес изменился извне — применился. Вперёд — на прямой
  //    хеш #drafts: тот по-прежнему открывает СТАРЫЙ экран (архив), программа
  //    переадресуется, адресная строка — нет.
  {
    const {c, ctx} = await mountShell('#leads', owner);
    c.go('drafts', {focusDraft:7});
    check("go('drafts',{focusDraft:7}) уводит в сценарную очередь",
          ctx.location.hash === '#wf:cold_dm:drafts?focusDraft=7', ctx.location.hash);
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

  // 15. DraftsTable: чтение фильтров из хеша и обратная запись.
  {
    const dtSrc = fs.readFileSync(DIR + '/RadarDraftsTable.dc.html', 'utf8')
      .match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/)[1];
    const writes = [];
    const got = [];
    const ctx = {console, setTimeout:(f)=>0, clearTimeout(){}, URLSearchParams, Date, Math, JSON,
                 location:{hash:'#draftsTable?filter=approved&channel=VPS%20Talk&min_score=40&q=%D0%B1%D0%BE%D0%BB%D1%8C'},
                 history:{replaceState:(a,b,url)=>writes.push(url)},
                 window:{addEventListener(){}, removeEventListener(){}},
                 __imp: async ()=>({get: async (p, params)=>{got.push({p, params});
                       if(p === '/channels/options') return [];
                       return {rows:[], total:0, states:{}};}})};
    vm.createContext(ctx);
    const base = `class DCLogic { constructor(){ this.props = {}; }
      setState(p, cb){ const n = typeof p === 'function' ? p(this.state) : p;
        this.state = Object.assign({}, this.state, n); if(cb) cb(); } }`;
    ctx.__props = {};
    vm.runInContext(base + '\n' + dtSrc.replace(/await import\(/g, 'await __imp(') + '\n;this.__D = Component;', ctx);
    const d = new ctx.__D();
    await d.componentDidMount();
    check('draftsTable читает фильтры из хеша',
          d.state.filter === 'approved' && d.state.channel === 'VPS Talk'
          && d.state.minScore === 40 && d.state.query === 'боль');
    check('draftsTable шлёт фильтры на сервер', got.some(x=>x.p === '/drafts/list' && x.params
          && x.params.state === 'approved' && x.params.channel === 'VPS Talk'
          && x.params.min_score === 40 && x.params.q === 'боль'));
    check('draftsTable пишет свой срез в адрес',
          writes.some(w=>w === '#draftsTable?filter=approved&channel=VPS+Talk&min_score=40&q=%D0%B1%D0%BE%D0%BB%D1%8C'));
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

  // 25. Переадресованный переход из экрана монтирует очередь сценария: те же
  //     v.drafts и workflowKey, что у прямого клика по пункту блока cold_dm.
  //     Сюда попадают дашборд (плитка и очередь с go:'drafts' из payload),
  //     кнопка «Открыть очередь черновиков» в Leads и goQueue общей таблицы —
  //     все они зовут api.go('drafts') оболочки.
  {
    const {c} = await mountShell('#dashboard', owner,
      [{key:'cold_dm', title:'Личные сообщения', sections:[{key:'drafts', title:'Черновики'}]}]);
    c.go('drafts', {focusDraft:9});
    const v = c.renderVals();
    check("go('drafts') монтирует экран очереди с ключом сценария cold_dm",
          v.v.drafts === true && v.workflowKey === 'cold_dm' && v.denied === false,
          'workflowKey=' + v.workflowKey);
  }

  // Мутации, в файл не кодируемые: убрать 'drafts' из HIDDEN_NAV в обеих копиях
  // оболочки -> краснеет 23; убрать переадресацию в go() -> краснеют 8, 24, 25
  // и первая половина 9.

  let bad = 0;
  for(const [st, name] of results){ console.log(st + ' ' + name); if(st === 'FAIL') bad++; }
  console.log(bad ? ('--- ПРОВАЛОВ: ' + bad) : '--- все проверки прошли');
  process.exit(bad ? 1 : 0);
})().catch(e=>{ console.error('сорвался: ' + e.stack); process.exit(2); });

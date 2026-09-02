// Общее поведение табличных экранов: страницы, размер страницы, сортировка, поиск.
//
// Каждый экран задавал эти вопросы по-своему или не задавал вовсе: где-то было
// жёстко пятьдесят строк без продолжения, где-то весь список целиком, сортировки не
// было нигде. Здесь одна реализация на всех — экран описывает свои колонки и
// фильтры, остальное одинаково.
//
// Почему это модуль, а не компонент: разметка в `.dc.html` подставляет в дырки
// только имя или путь (`{{ c.label }}`), выражений в шаблоне нет. Значит, всё
// вычисляемое — стрелка в заголовке, список кнопок страниц, подпись «показано
// 51-100 из 12 043» — обязано приехать готовым из логики. Модуль это и готовит.
//
// Использование:
//     import { Table } from './radar-table.js';
//     table = new Table({ key:'stream', sort:'date', sorts:[...] });
//     // в componentDidMount:
//     this.table.attach(() => this.load());
//     // в load(): get('/messages', this.table.query())
//     // в renderVals(): ...this.table.vals(this.state.total)

const SIZES = [25, 50, 100, 250];

// Пауза перед запросом при наборе в поле поиска. Без неё каждая буква — запрос к
// серверу, а поиск идёт по таблице сообщений, где их двенадцать тысяч.
const TYPING_PAUSE_MS = 350;

function readStoredSize(key) {
  const n = parseInt(localStorage.getItem('radar.size.' + key), 10);
  return SIZES.includes(n) ? n : null;
}

// Состояние таблицы живёт в адресной строке, чтобы срез можно было прислать
// ссылкой, а не пересказывать словами. Заодно бесплатно работает кнопка «назад».
//
// Маршрут в адресе — часть до «?», и она принадлежит оболочке. У таблицы общего
// раздела ключ и есть маршрут; у таблицы сценария ключ — «раздел:ключ», а
// маршрут — wf-форма. Писать в адрес свой ключ напрямую значило бы стирать
// маршрут сценария: адрес молча превращался в общий раздел, и ссылка после
// перезагрузки вела не туда, куда человек смотрел.
function routeOf(key) {
  const i = key.indexOf(':');
  return i === -1 ? key : 'wf:' + key.slice(i + 1) + ':' + key.slice(0, i);
}

function readUrl(key) {
  const raw = (location.hash || '').replace(/^#/, '');
  const [route, query] = raw.split('?');
  if (route !== key && route !== routeOf(key)) return {};
  const p = new URLSearchParams(query || '');
  const out = {};
  for (const [k, v] of p) out[k] = v;
  return out;
}

function writeUrl(key, params) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined && v !== '') p.set(k, String(v));
  }
  const q = p.toString();
  // `replaceState`, а не `pushState`: смена страницы или сортировки — уточнение
  // текущего экрана, а не переход. Иначе «назад» отматывает по одному клику
  // фильтра, и до предыдущего раздела не добраться.
  history.replaceState(null, '', '#' + routeOf(key) + (q ? '?' + q : ''));
}

export class Table {
  // opts:
  //   key    — имя экрана, оно же ключ в адресе и в localStorage
  //   size   — размер страницы по умолчанию
  //   sort   — колонка сортировки по умолчанию
  //   order  — 'asc' | 'desc'
  //   sorts  — [{key, label}] колонки, по которым сервер разрешает сортировать;
  //            остальные заголовки рисуются без клика
  //   filters — {имя: значение по умолчанию} произвольные фильтры экрана
  constructor(opts) {
    const url = readUrl(opts.key);
    this.key = opts.key;
    this.sorts = opts.sorts || [];
    this.filterNames = Object.keys(opts.filters || {});

    this.size = parseInt(url.size, 10) || readStoredSize(opts.key) || opts.size || 50;
    this.page = Math.max(1, parseInt(url.page, 10) || 1);
    this.sort = url.sort || opts.sort || null;
    this.order = url.order === 'asc' ? 'asc' : (url.order === 'desc' ? 'desc'
                                                : (opts.order || 'desc'));
    this.q = url.q || '';
    this.filters = {};
    for (const name of this.filterNames) {
      this.filters[name] = url[name] !== undefined ? url[name] : opts.filters[name];
    }
    this.reload = () => {};
    this.timer = null;
  }

  attach(reload) { this.reload = reload; this.sync(); }

  sync() {
    writeUrl(this.key, {
      page: this.page > 1 ? this.page : '', size: this.size,
      sort: this.sort, order: this.order, q: this.q, ...this.filters,
    });
  }

  // Параметры запроса к серверу. Пустые не отправляются: `channel_id=` сервер
  // разберёт как ошибку типа, а не как «фильтр не задан».
  query(extra) {
    const out = {limit: this.size, offset: (this.page - 1) * this.size};
    if (this.sort) { out.sort = this.sort; out.order = this.order; }
    if (this.q) out.q = this.q;
    for (const [k, v] of Object.entries(this.filters)) {
      if (v !== null && v !== undefined && v !== '') out[k] = v;
    }
    return Object.assign(out, extra || {});
  }

  set(patch, {resetPage = true} = {}) {
    Object.assign(this, patch);
    // Любая смена условий отбора возвращает на первую страницу. Иначе человек,
    // стоявший на седьмой странице и сменивший фильтр, видит пустоту и решает,
    // что под фильтр ничего не подошло.
    if (resetPage) this.page = 1;
    this.sync();
    this.reload();
  }

  setFilter(name, value) {
    this.filters[name] = value;
    this.page = 1;
    this.sync();
    this.reload();
  }

  setSize(n) {
    localStorage.setItem('radar.size.' + this.key, String(n));
    this.set({size: n});
  }

  // Клик по заголовку: первый раз — сортировка по этой колонке, второй — обратный
  // порядок. Порядок по умолчанию убывающий: у всех наших таблиц интересное
  // (свежее, крупное, проблемное) сверху.
  toggleSort(key) {
    if (this.sort === key) this.set({order: this.order === 'desc' ? 'asc' : 'desc'});
    else this.set({sort: key, order: 'desc'});
  }

  setQuery(text) {
    this.q = text;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.page = 1; this.sync(); this.reload(); },
                            TYPING_PAUSE_MS);
  }

  reset() {
    this.q = '';
    this.page = 1;
    for (const name of this.filterNames) this.filters[name] = '';
    this.sync();
    this.reload();
  }

  get pages() { return Math.max(1, Math.ceil(this.total / this.size)); }

  // Кнопки страниц: первая, последняя, текущая и по одной вокруг неё. На 482
  // страницах (12 043 сообщения по 25) полный список кнопок не помещается на экран
  // и не нужен: прыжок на 237-ю страницу — не тот способ навигации, которым
  // пользуются, для этого есть фильтры.
  pageButtons() {
    const last = this.pages, cur = this.page;
    const want = new Set([1, last, cur - 1, cur, cur + 1]);
    const nums = [...want].filter(n => n >= 1 && n <= last).sort((a, b) => a - b);
    const out = [];
    let prev = 0;
    for (const n of nums) {
      if (n - prev > 1) out.push({label: '…', gap: true, pick: () => {}});
      out.push({
        label: String(n), gap: false, cur: n === cur,
        bg: n === cur ? '#131E5F' : 'transparent',
        fg: n === cur ? '#F8F3E0' : '#156479',
        pick: () => this.set({page: n}, {resetPage: false}),
      });
      prev = n;
    }
    return out;
  }

  // Значения для разметки. `total` приходит с сервера — сама таблица его не знает.
  vals(total, opts) {
    this.total = total || 0;
    const o = opts || {};
    const from = this.total ? (this.page - 1) * this.size + 1 : 0;
    const to = Math.min(this.page * this.size, this.total);
    const arrow = (key) => this.sort !== key ? '' : (this.order === 'desc' ? '↓' : '↑');

    const heads = (o.columns || []).map(c => {
      const sortable = this.sorts.some(s => s.key === c.sort);
      return {
        label: c.label,
        arrow: sortable ? arrow(c.sort) : '',
        fg: sortable && this.sort === c.sort ? '#131E5F' : '#156479',
        cursor: sortable ? 'pointer' : 'default',
        pick: sortable ? () => this.toggleSort(c.sort) : () => {},
      };
    });

    return {
      cols: heads,
      pages: this.pageButtons(),
      sizes: SIZES.map(n => ({
        label: String(n), cur: n === this.size,
        bg: n === this.size ? '#131E5F' : 'transparent',
        fg: n === this.size ? '#F8F3E0' : '#156479',
        pick: () => this.setSize(n),
      })),
      // Диапазон, а не только общее число: «показано 12 043» на экране с
      // пятьюдесятью строками — неправда, которую легко принять за правду.
      range: o.loading ? 'загрузка…'
           : (o.error ? o.error
           : (this.total ? `Показано ${from}–${to} из ${this.total}`
                         : 'Ничего не найдено')),
      q: this.q,
      setQ: (e) => this.setQuery(e.target.value),
      hasFilters: !!(this.q || Object.values(this.filters).some(v => v)),
      resetAll: () => this.reset(),
      prev: () => this.page > 1 && this.set({page: this.page - 1}, {resetPage: false}),
      next: () => this.page < this.pages
                  && this.set({page: this.page + 1}, {resetPage: false}),
      prevFg: this.page > 1 ? '#156479' : '#C9CCD6',
      nextFg: this.page < this.pages ? '#156479' : '#C9CCD6',
    };
  }
}

// Выпадающий список: одинаковый во всех фильтрах, поэтому собирается здесь.
// `value` пустой строкой означает «без фильтра» — сервер такого параметра не
// получит вовсе (см. `query`).
export function options(list, current, {empty = 'все'} = {}) {
  return [{value: '', label: empty}].concat(list).map(o => ({
    value: String(o.value), label: o.label,
    selected: String(o.value) === String(current || ''),
  }));
}

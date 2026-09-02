// Оболочка живёт в двух файлах, и браузер исполняет НЕ тот, который правят.
//
// `/radar/` отдаётся из `index.html` — это самостоятельная копия оболочки со своим
// блоком логики. Компонентный файл `Atomic Radar.dc.html` правят люди и агенты, его
// проверяют `check-dc.js` и `check-routing.js`, но на страницу он не подключён
// ничем.
//
// Чем это уже стоило: фикс маршрутизации (коммит 337f980, замечание 2) прошёл все
// проверки, был слит и выкачен — и не работал на проде вообще. `check-routing.js`
// показывал 25/25, потому что создаёт класс из `Atomic Radar.dc.html` напрямую.
// Расхождение прожило от 30.08 до 02.09 и нашлось только живой проверкой в браузере.
//
// Пока копии две, единственная защита — сверять их машинно. Проверка сравнивает
// блоки логики побайтово и заодно скармливает логику из `index.html` парсеру: до
// этого её синтаксис не проверял никто, `check-dc.js` смотрит только `*.dc.html`.
//
//     node check-shell-copy.js
//
// Падает — значит правку оболочки перенесли не во все копии. Перенос:
// заменить содержимое <script type="text/x-dc"> в `index.html` на такое же из
// `Atomic Radar.dc.html`. Всё остальное в этих файлах различается законно
// (index.html — экспорт со своей обвязкой), сверяется только логика.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = __dirname;
const SHELL = 'Atomic Radar.dc.html';
const PAGE = 'index.html';

function logicOf(file) {
  const src = fs.readFileSync(path.join(dir, file), 'utf8');
  const m = src.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) {
    console.log(`FAIL  ${file}: блока <script type="text/x-dc"> нет`);
    process.exit(1);
  }
  return m[1];
}

const shell = logicOf(SHELL);
const page = logicOf(PAGE);
let bad = 0;

// 1. Синтаксис логики страницы. `check-dc.js` до неё не добирается.
try {
  new vm.Script('class DCLogic {};' + page, { filename: PAGE });
  console.log(`ok    ${PAGE}: логика разбирается`);
} catch (e) {
  bad++;
  console.log(`FAIL  ${PAGE}: ${e.message}`);
}

// 2. Копии совпадают.
if (shell === page) {
  console.log(`ok    логика ${PAGE} совпадает с ${SHELL}`);
} else {
  bad++;
  const a = shell.split('\n');
  const b = page.split('\n');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  console.log(`FAIL  логика ${PAGE} разошлась с ${SHELL}`);
  console.log(`      строк: ${SHELL} ${a.length}, ${PAGE} ${b.length}; первое расхождение в строке ${i + 1}`);
  console.log(`      ${SHELL}: ${(a[i] || '<конец файла>').trim().slice(0, 110)}`);
  console.log(`      ${PAGE}: ${(b[i] || '<конец файла>').trim().slice(0, 110)}`);
  console.log('      Браузер исполняет index.html — значит правка НЕ доедет до прода.');
}

console.log(bad ? '\n--- есть расхождения' : '\n--- копии оболочки сходятся');
process.exit(bad ? 1 : 0);

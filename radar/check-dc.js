// Синтаксическая проверка логики .dc-компонентов.
//
// Класс внутри <script type="text/x-dc"> не исполняется браузером как обычный
// скрипт — его достаёт и вычисляет рантайм support.js, поэтому опечатка вроде
// пропущенной скобки не подсвечивается ничем и проявляется как молча пустой экран.
// Здесь блок вырезается и отдаётся парсеру Node: DCLogic подставляется заглушкой,
// импорты остаются динамическими и не резолвятся.
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const dir = process.argv[2];
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.dc.html'));
let bad = 0;

for (const f of files) {
  const src = fs.readFileSync(path.join(dir, f), 'utf8');
  const m = src.match(/<script type="text\/x-dc"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) { console.log(`SKIP  ${f} — блока логики нет`); continue; }
  try {
    new vm.Script('class DCLogic {};' + m[1], { filename: f });
    console.log(`ok    ${f}`);
  } catch (e) {
    bad++;
    console.log(`FAIL  ${f}: ${e.message}`);
  }
}
process.exit(bad ? 1 : 0);

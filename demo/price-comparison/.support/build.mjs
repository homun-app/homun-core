import fs from 'node:fs/promises';
import { Workbook } from '@oai/artifact-tool';

// Synthetic operational fixtures. No production price-comparison code is used.
const dir = new URL('../', import.meta.url);
const common = [
  ['OFFICE-100', 'Demo risma carta Aurora', 5, 5.5],
  ['OFFICE-101', 'Demo quaderno Lino', 10, 12],
  ['OFFICE-102', 'Demo organizer Prisma', 20, 21],
  ['OFFICE-103', 'Demo penne Tinta', 8, 6],
  ['OFFICE-104', 'Demo lampada Alba', 50, 45],
  ['OFFICE-105', 'Demo sedia Nuvola', 100, 80],
  ['OFFICE-106', 'Demo cartelline Arco', 12, 12],
  ['OFFICE-107', 'Demo gomma Neve', 2.5, 2.5],
  ['OFFICE-108', 'Demo campione Blocchetto', 0, 3],
];
const august = [
  ...common.map(([sku,name,price]) => [sku,name,price,'EUR']),
  ['OFFICE-110','Demo righello Linea',4,'EUR'],
  ['OFFICE-111','Demo portapenne Nido',7,'EUR'],
  ['OFFICE-112','Demo raccoglitore Doppio',15,'EUR'],
  ['OFFICE-112','Demo raccoglitore Doppio bis',16,'EUR'],
  ['OFFICE-113','Demo cucitrice Sospesa',null,'EUR'],
  ['OFFICE-114','Demo tappetino Onda',18,'EUR'],
  ['CASE-01','Demo etichette Maiuscole',6,'EUR'],
];
const september = [
  ...common.map(([sku,name,,price]) => [sku,name,price,'EUR']),
  ['OFFICE-120','Demo forbici Taglio',9,'EUR'],
  ['OFFICE-121','Demo calendario Giorno',14,'EUR'],
  ['OFFICE-112','Demo raccoglitore Doppio',17,'EUR'],
  ['OFFICE-113','Demo cucitrice Sospesa',11,'EUR'],
  ['OFFICE-114','Demo tappetino Onda',20,'USD'],
  ['case-01','Demo etichette Minuscole',6.5,'EUR'],
];
const workbook = Workbook.create();
for (const [month, rows] of [['agosto',august],['settembre',september]]) {
  const sheet = workbook.worksheets.add(month);
  sheet.showGridLines = false;
  sheet.getRange(`A1:D${rows.length+1}`).values = [['sku','name','price','currency'],...rows];
  sheet.getRange(`A1:D${rows.length+1}`).format.font = {name:'Arial',size:11};
  sheet.getRange('A1:D1').format = {fill:'#253B53',font:{color:'#FFFFFF',bold:true}};
  sheet.getRange(`C2:C${rows.length+1}`).setNumberFormat('0.00');
  sheet.getRange(`A1:D${rows.length+1}`).format.autofitColumns();
}
workbook.recalculate();
for (const [month, rows] of [['agosto',august],['settembre',september]]) {
  const sheet = workbook.worksheets.getItem(month);
  const values = sheet.getRange(`A1:D${rows.length+1}`).values;
  // Public documentation/help exposes no CSV export. Serialize the authored
  // typed cells explicitly to preserve the required semicolon/dot convention.
  const escape = value => String(value ?? '').replaceAll('"','""');
  const csv = values.map((row,i) => row.map((value,j) => {
    const s = i > 0 && j === 2 && typeof value === 'number' ? value.toFixed(2) : escape(value);
    return /[;"\r\n]/.test(s) ? `"${s}"` : s;
  }).join(';')).join('\n')+'\n';
  await fs.writeFile(new URL(`listino-${month}.csv`,dir),csv,'utf8');
  const preview = await workbook.render({sheetName:month,range:`A1:D${rows.length+1}`,scale:1,format:'png'});
  await fs.writeFile(new URL(`${month}.png`,import.meta.url),new Uint8Array(await preview.arrayBuffer()));
  console.log((await workbook.inspect({kind:'table',range:`${month}!A1:D4`,include:'values,formulas',tableMaxRows:4,tableMaxCols:4})).ndjson);
}

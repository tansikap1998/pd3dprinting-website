// ระบบจัดการสต็อกวัสดุ + คิวงานพิมพ์ 3 มิติ + แจ้งเตือนกลุ่ม LINE OA
// ไม่มี dependency ภายนอก: ใช้ node:http, node:sqlite, fetch ที่มากับ Node 22
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------- โหลด .env แบบง่าย ----------
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const LINE_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN || '';
const LINE_SECRET = process.env.LINE_CHANNEL_SECRET || '';
const LINE_API = process.env.LINE_API_BASE || 'https://api.line.me';
// คีย์สำหรับระบบอื่น (เช่น เว็บไซต์) ส่งออเดอร์/ไฟล์เข้าคิว ผ่าน header X-API-Key
const INTEGRATION_API_KEY = process.env.INTEGRATION_API_KEY || '';
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(__dirname, 'uploads');
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 100);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');

// ---------- ฐานข้อมูล ----------
const db = new DatabaseSync(DB_PATH);
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS materials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'PLA',
  color TEXT DEFAULT '',
  brand TEXT DEFAULT '',
  stock_g REAL NOT NULL DEFAULT 0,
  min_g REAL NOT NULL DEFAULT 200,
  cost_per_kg REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS stock_moves (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id INTEGER NOT NULL REFERENCES materials(id),
  change_g REAL NOT NULL,
  reason TEXT NOT NULL,           -- in | adjust | print | waste
  job_id INTEGER,
  note TEXT DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS printers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  model TEXT DEFAULT '',
  status TEXT NOT NULL DEFAULT 'idle',  -- idle | printing | maintenance
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  customer TEXT DEFAULT '',
  material_id INTEGER REFERENCES materials(id),
  est_grams REAL NOT NULL DEFAULT 0,      -- ต่อชิ้น
  est_minutes INTEGER NOT NULL DEFAULT 0, -- ต่อชิ้น
  qty INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 0,    -- 0 ปกติ, 1 ด่วน
  due_date TEXT DEFAULT '',
  printer_id INTEGER REFERENCES printers(id),
  status TEXT NOT NULL DEFAULT 'queued',  -- queued | printing | done | failed | cancelled
  note TEXT DEFAULT '',
  actual_grams REAL,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  started_at TEXT,
  finished_at TEXT
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS notify_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT, ok INTEGER, error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
`);

db.exec(`
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shop_product_id TEXT NOT NULL,
  shop_variation_id TEXT NOT NULL DEFAULT '',
  name TEXT NOT NULL,
  short_name TEXT NOT NULL,
  variation_name TEXT DEFAULT '',
  sku TEXT DEFAULT '',
  price REAL DEFAULT 0,
  shop_stock INTEGER DEFAULT 0,
  est_grams REAL NOT NULL DEFAULT 0,
  est_minutes INTEGER NOT NULL DEFAULT 0,
  material_id INTEGER REFERENCES materials(id),
  hidden INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(shop_product_id, shop_variation_id)
);
`);
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
if (!cols('jobs').includes('product_id')) db.exec('ALTER TABLE jobs ADD COLUMN product_id INTEGER REFERENCES products(id)');
db.exec(`CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, stored TEXT NOT NULL, size INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')))`);
for (const [c, def] of [['file_id', 'TEXT'], ['contact', "TEXT DEFAULT ''"], ['source', "TEXT DEFAULT ''"], ['price', 'REAL']])
  if (!cols('jobs').includes(c)) db.exec(`ALTER TABLE jobs ADD COLUMN ${c} ${def}`);
if (!cols('jobs').includes('order_no')) db.exec(`ALTER TABLE jobs ADD COLUMN order_no TEXT DEFAULT ''`);

const q = (sql, ...p) => db.prepare(sql).all(...p);
const one = (sql, ...p) => db.prepare(sql).get(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);
const tx = (fn) => { db.exec('BEGIN'); try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; } };

const getSetting = (k, d = '') => one('SELECT value FROM settings WHERE key=?', k)?.value ?? d;
const setSetting = (k, v) => run('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', k, String(v));
if (process.env.LINE_GROUP_ID && !getSetting('line_group_id')) setSetting('line_group_id', process.env.LINE_GROUP_ID);
if (!getSetting('notify')) setSetting('notify', JSON.stringify({ newJob: true, start: true, done: true, failed: true, lowStock: true, stockIn: false }));
if (!getSetting('flex')) setSetting('flex', '1');
if (!getSetting('daily')) setSetting('daily', JSON.stringify({ enabled: true, time: '18:00' }));

// ---------- ตัวช่วยแสดงผล ----------
const STATUS_TH = { queued: 'รอคิว', printing: 'กำลังพิมพ์', done: 'เสร็จแล้ว', failed: 'พิมพ์เสีย', cancelled: 'ยกเลิก' };
const PRINTER_TH = { idle: 'ว่าง', printing: 'กำลังพิมพ์', maintenance: 'ซ่อมบำรุง' };
const fmtG = (g) => (Math.abs(g) >= 1000 ? (g / 1000).toFixed(2) + ' kg' : Math.round(g) + ' g');
const fmtMin = (m) => { m = Math.round(m); const h = Math.floor(m / 60); return h ? `${h} ชม. ${m % 60} นาที` : `${m} นาที`; };
const baht = (n) => '฿' + Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 });
const costOf = (materialId, grams) => {
  const m = materialId ? one('SELECT cost_per_kg FROM materials WHERE id=?', materialId) : null;
  return m ? (m.cost_per_kg * grams) / 1000 : 0;
};
const bkkNow = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Bangkok' }));
const matLabel = (m) => (m ? `${m.type} ${m.color || ''} ${m.brand ? '(' + m.brand + ')' : ''}`.replace(/\s+/g, ' ').trim() || m.name : '-');

// ---------- LINE ----------
// สร้าง Flex Message แบบการ์ด (ปุ่มใช้ message action → ส่งคำสั่งเข้ากลุ่ม แล้วบอทประมวลผลต่อ)
function flexCard({ head, color = '#06c755', rows = [], lines = [], buttons = [], alt }) {
  const nz = (v) => (v === undefined || v === null || String(v).trim() === '' ? '-' : String(v));
  const body = [
    ...rows.map(([k, v]) => ({ type: 'box', layout: 'baseline', spacing: 'sm', contents: [
      { type: 'text', text: nz(k), color: '#8c8c8c', size: 'sm', flex: 2 },
      { type: 'text', text: nz(v), size: 'sm', flex: 5, wrap: true }] })),
    ...lines,
  ];
  const bubble = {
    type: 'bubble',
    header: { type: 'box', layout: 'vertical', backgroundColor: color, paddingAll: '14px', contents: [{ type: 'text', text: nz(head), color: '#ffffff', weight: 'bold', wrap: true }] },
    body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: body.length ? body : [{ type: 'text', text: '-' }] },
  };
  if (buttons.length) bubble.footer = { type: 'box', layout: 'horizontal', spacing: 'sm', contents: buttons.map((b) => ({
    type: 'button', style: b.primary ? 'primary' : 'secondary', height: 'sm', ...(b.primary ? { color: b.color || '#06c755' } : {}),
    action: { type: 'message', label: b.label.slice(0, 20), text: b.text } })) };
  return { type: 'flex', altText: (alt || head).slice(0, 380), contents: bubble };
}

async function linePush(text, flex) {
  const to = getSetting('line_group_id');
  const flags = JSON.parse(getSetting('notify', '{}'));
  if (flags.enabled === false) return { ok: false, error: 'ปิดการแจ้งเตือนอยู่' };
  if (!LINE_TOKEN || !to) {
    run('INSERT INTO notify_log(text,ok,error) VALUES(?,?,?)', text, 0, 'ยังไม่ได้ตั้งค่า token หรือ group id');
    console.log('[LINE:skip]\n' + text);
    return { ok: false, error: 'ยังไม่ได้ตั้งค่า LINE_CHANNEL_ACCESS_TOKEN หรือ Group ID' };
  }
  try {
    const r = await fetch(LINE_API + '/v2/bot/message/push', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_TOKEN}` },
      body: JSON.stringify({ to, messages: [flex && getSetting('flex') === '1' ? flex : { type: 'text', text: text.slice(0, 4900) }] }),
    });
    const err = r.ok ? null : await r.text();
    run('INSERT INTO notify_log(text,ok,error) VALUES(?,?,?)', text, r.ok ? 1 : 0, err);
    return { ok: r.ok, error: err };
  } catch (e) {
    run('INSERT INTO notify_log(text,ok,error) VALUES(?,?,?)', text, 0, String(e));
    return { ok: false, error: String(e) };
  }
}
function notify(kind, text, flex) {
  const flags = JSON.parse(getSetting('notify', '{}'));
  if (flags[kind] === false) return;
  linePush(text, flex).catch(() => {});
}
async function lineReply(replyToken, text) {
  if (!LINE_TOKEN) return;
  await fetch(LINE_API + '/v2/bot/message/reply', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${LINE_TOKEN}` },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text: text.slice(0, 4900) }] }),
  }).catch((e) => console.error('reply error', e));
}

// ---------- ตรรกะธุรกิจ ----------
function materialsWithReserved() {
  return q(`SELECT m.*,
      COALESCE((SELECT SUM(j.est_grams*j.qty) FROM jobs j WHERE j.material_id=m.id AND j.status IN ('queued','printing')),0) AS reserved_g
    FROM materials m WHERE m.active=1 ORDER BY m.type, m.color`).map((m) => ({ ...m, available_g: m.stock_g - m.reserved_g, low: m.stock_g <= m.min_g }));
}
function queueList() {
  return q(`SELECT j.*, m.name AS material_name, m.type AS material_type, m.color AS material_color, m.brand AS material_brand, p.name AS printer_name, f.name AS file_name
    FROM jobs j LEFT JOIN materials m ON m.id=j.material_id LEFT JOIN printers p ON p.id=j.printer_id LEFT JOIN files f ON f.id=j.file_id
    WHERE j.status IN ('queued','printing')
    ORDER BY CASE j.status WHEN 'printing' THEN 0 ELSE 1 END, j.priority DESC, j.id ASC`);
}
function moveStock(materialId, change, reason, jobId = null, note = '') {
  run('UPDATE materials SET stock_g = stock_g + ? WHERE id=?', change, materialId);
  run('INSERT INTO stock_moves(material_id,change_g,reason,job_id,note) VALUES(?,?,?,?,?)', materialId, change, reason, jobId, note);
}
function checkLowStock(materialId, before) {
  const m = one('SELECT * FROM materials WHERE id=?', materialId);
  if (m && m.stock_g <= m.min_g && before > m.min_g) {
    notify('lowStock', `⚠️ วัสดุใกล้หมด!\n${matLabel(m)}\nคงเหลือ: ${fmtG(m.stock_g)} (ขั้นต่ำ ${fmtG(m.min_g)})\nกรุณาสั่งซื้อเพิ่ม`);
  }
}
function jobDetail(id) {
  return one(`SELECT j.*, p.name AS printer_name FROM jobs j LEFT JOIN printers p ON p.id=j.printer_id WHERE j.id=?`, id);
}

// ---------- สินค้า ----------
const productTitle = (p) => `${p.short_name}${p.variation_name ? ' - ' + p.variation_name : ''}`;
const COLOR_WORDS = [
  ['ขาว', /white|ขาว/i], ['ดำ', /black|ดำ/i], ['แดง', /red|แดง/i], ['น้ำเงิน', /navy|blue|น้ำเงิน/i], ['ฟ้า', /sky|ฟ้า/i],
  ['เขียว', /green|เขียว/i], ['เหลือง', /yellow|เหลือง/i], ['ส้ม', /orange|ส้ม/i], ['ชมพู', /pink|ชมพู/i], ['ม่วง', /purple|ม่วง/i],
  ['เทา', /gr[ae]y|เทา/i], ['น้ำตาล', /brown|น้ำตาล/i], ['ใส', /clear|transparent|ใส/i],
];
const colorOf = (s) => COLOR_WORDS.find(([, re]) => re.test(s || ''))?.[0] || '';
function guessMaterial(p) {
  const color = colorOf(p.variation_name) || colorOf(p.name);
  const ms = q('SELECT * FROM materials WHERE active=1');
  const type = ['PETG', 'ABS', 'ASA', 'TPU', 'PLA'].find((t) => (p.name || '').toUpperCase().includes(t));
  const byColor = color ? ms.filter((m) => colorOf(m.color) === color) : [];
  return byColor.find((m) => type && m.type.toUpperCase().startsWith(type)) || byColor.find((m) => m.type.toUpperCase().startsWith('PLA')) || byColor[0] || null;
}
function resolveMaterial(type, color) {
  if (!type) return null;
  const t = String(type).toUpperCase().replace(/\s+/g, '');
  const ms = q('SELECT * FROM materials WHERE active=1').filter((m) => m.type.toUpperCase().replace(/\s+/g, '').startsWith(t) || t.startsWith(m.type.toUpperCase().replace(/\s+/g, '')));
  const c = colorOf(color);
  return (c && ms.find((m) => colorOf(m.color) === c)) || (!color ? ms.sort((a, b) => b.stock_g - a.stock_g)[0] : null) || null;
}
function defaultShortName(name) {
  let s = name.replace(/^PB3D\s*/i, '').replace(/\s*\(ไม่ร.*$/, '').trim();
  if (s.length > 48) s = s.slice(0, 48).replace(/\s+\S*$/, '');
  return s;
}

// อ่าน .xlsx โดยไม่ใช้ไลบรารี: zip (central directory + inflateRaw) แล้วอ่าน XML ด้วย regex
function unzip(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw httpErr(400, 'ไฟล์ไม่ใช่ .xlsx');
  const files = {};
  let off = buf.readUInt32LE(eocd + 16);
  const count = buf.readUInt16LE(eocd + 10);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10), size = buf.readUInt32LE(off + 20);
    const nl = buf.readUInt16LE(off + 28), el = buf.readUInt16LE(off + 30), cl = buf.readUInt16LE(off + 32), lo = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nl);
    const dataStart = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    const raw = buf.subarray(dataStart, dataStart + size);
    files[name] = () => (method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8');
    off += 46 + nl + el + cl;
  }
  return files;
}
const xmlDecode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(n)).replace(/&amp;/g, '&');
function readXlsx(buf) {
  const f = unzip(buf);
  const ss = f['xl/sharedStrings.xml'] ? [...f['xl/sharedStrings.xml']().matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xmlDecode([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(''))) : [];
  const sheetName = Object.keys(f).filter((k) => /^xl\/worksheets\/sheet\d+\.xml$/.test(k)).sort()[0];
  if (!sheetName) throw httpErr(400, 'ไม่พบชีตในไฟล์');
  const rows = [];
  for (const rm of f[sheetName]().matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const row = {};
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const col = /r="([A-Z]+)/.exec(cm[1])?.[1]; const t = /t="(\w+)"/.exec(cm[1])?.[1];
      const inner = cm[2] || '';
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let val = null;
      if (t === 's' && v !== undefined) val = ss[Number(v)];
      else if (t === 'inlineStr') val = xmlDecode([...inner.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((x) => x[1]).join(''));
      else if (v !== undefined) val = xmlDecode(v);
      if (col) row[col] = val;
    }
    rows.push(row);
  }
  return rows;
}
function importShopee(buf) {
  const rows = readXlsx(buf);
  const KEYS = { product_id: ['et_title_product_id', 'รหัสสินค้า'], name: ['et_title_product_name', 'ชื่อสินค้า'], variation_id: ['et_title_variation_id', 'รหัสตัวเลือกสินค้า'],
    variation_name: ['et_title_variation_name', 'ชื่อตัวเลือกสินค้า'], parent_sku: ['et_title_parent_sku', 'Parent SKU'], sku: ['et_title_variation_sku', 'เลข SKU'],
    price: ['et_title_variation_price', 'ราคา'], stock: ['et_title_variation_stock', 'คลัง'] };
  const hi = rows.findIndex((r) => Object.values(r).some((v) => v === 'et_title_product_id' || v === 'รหัสสินค้า'));
  if (hi < 0) throw httpErr(400, 'ไม่พบหัวตาราง (ต้องเป็นไฟล์ mass update sales info จาก Shopee)');
  const col = {};
  for (const [k, names] of Object.entries(KEYS)) col[k] = Object.keys(rows[hi]).find((c) => names.includes(rows[hi][c]));
  let added = 0, updated = 0;
  const seen = new Set();
  tx(() => {
    for (const r of rows.slice(hi + 1)) {
      const pid = String(r[col.product_id] ?? '').trim();
      if (!/^\d+$/.test(pid)) continue;
      const vid = String(r[col.variation_id] ?? '').trim();
      const name = String(r[col.name] ?? '').trim();
      const vname = String(r[col.variation_name] ?? '').trim();
      const sku = String(r[col.sku] ?? r[col.parent_sku] ?? '').trim();
      const price = Number(r[col.price]) || 0, stock = Number(r[col.stock]) || 0;
      seen.add(`${pid}|${vid}`);
      const ex = one('SELECT id FROM products WHERE shop_product_id=? AND shop_variation_id=?', pid, vid);
      if (ex) {
        run(`UPDATE products SET name=?, variation_name=?, sku=?, price=?, shop_stock=?, updated_at=datetime('now','localtime') WHERE id=?`, name, vname, sku, price, stock, ex.id);
        updated++;
      } else {
        // สินค้าใหม่: ยืมค่ากรัม/เวลา จากตัวเลือกอื่นของสินค้าเดียวกัน (ถ้ามี)
        const sib = one('SELECT short_name, est_grams, est_minutes FROM products WHERE shop_product_id=? ORDER BY est_grams DESC LIMIT 1', pid);
        const id = Number(run(`INSERT INTO products(shop_product_id,shop_variation_id,name,short_name,variation_name,sku,price,shop_stock,est_grams,est_minutes) VALUES(?,?,?,?,?,?,?,?,?,?)`,
          pid, vid, name, sib?.short_name || defaultShortName(name), vname, sku, price, stock, sib?.est_grams || 0, sib?.est_minutes || 0).lastInsertRowid);
        const m = guessMaterial({ name, variation_name: vname });
        if (m) run('UPDATE products SET material_id=? WHERE id=?', m.id, id);
        added++;
      }
    }
  });
  return { added, updated, total: seen.size };
}

const actions = {
  createJob(b, opt = {}) {
    let prod = null;
    if (b.product_id) {
      prod = one('SELECT * FROM products WHERE id=?', b.product_id);
      if (!prod) throw httpErr(404, 'ไม่พบสินค้า');
      if (!b.title) b.title = productTitle(prod);
      if (b.est_grams === undefined || b.est_grams === '') b.est_grams = prod.est_grams;
      if (b.est_minutes === undefined || b.est_minutes === '') b.est_minutes = prod.est_minutes;
      if (!b.material_id) b.material_id = prod.material_id || guessMaterial(prod)?.id || null;
    }
    if (!b.title) throw httpErr(400, 'กรุณาระบุชื่องาน');
    const r = run(`INSERT INTO jobs(title,customer,material_id,est_grams,est_minutes,qty,priority,due_date,note,product_id,order_no,file_id,contact,source,price)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      String(b.title).slice(0, 200), b.customer || '', b.material_id || null, Number(b.est_grams) || 0, Number(b.est_minutes) || 0,
      Math.max(1, Number(b.qty) || 1), b.priority ? 1 : 0, b.due_date || '', b.note || '', prod?.id || null, opt.order_no || '',
      b.file_id || null, b.contact || '', opt.source || b.source || '', b.price != null && b.price !== '' ? Number(b.price) : null);
    const id = Number(r.lastInsertRowid);
    const j = jobDetail(id);
    if (opt.silent) return j;
    const m = j.material_id ? one('SELECT * FROM materials WHERE id=?', j.material_id) : null;
    const pos = queueList().filter((x) => x.status === 'queued').findIndex((x) => x.id === id) + 1;
    const rows = [['งาน', `${j.title}${j.qty > 1 ? ' x' + j.qty : ''}`]];
    if (j.customer) rows.push(['ลูกค้า', j.customer]);
    rows.push(['วัสดุ', `${matLabel(m)} ~${fmtG(j.est_grams * j.qty)}`]);
    if (j.est_minutes) rows.push(['เวลา', fmtMin(j.est_minutes * j.qty)]);
    if (j.due_date) rows.push(['กำหนดส่ง', j.due_date]);
    if (j.note) rows.push(['หมายเหตุ', j.note]);
    rows.push(['ลำดับคิว', String(pos)]);
    let warn = '';
    if (m) {
      const mm = materialsWithReserved().find((x) => x.id === m.id);
      if (mm && mm.available_g < 0) { warn = `วัสดุไม่พอสำหรับคิวทั้งหมด (ขาด ${fmtG(-mm.available_g)})`; rows.push(['⚠️', warn]); }
    }
    const head = `🆕 งานพิมพ์ใหม่ #${id}${j.priority ? ' 🔥ด่วน' : ''}`;
    const text = head + '\n' + rows.map(([k, v]) => `${k}: ${v}`).join('\n');
    notify('newJob', text, flexCard({ head, color: j.priority ? '#ef4444' : '#3b82f6', rows, alt: `${head} ${j.title}`,
      buttons: [{ label: '▶ เริ่มพิมพ์', text: `เริ่ม ${id}`, primary: true }, { label: '📋 ดูคิว', text: 'คิว' }] }));
    return j;
  },
  createOrder(b) {
    // รายการได้ 2 แบบ: { product_id, qty } จากหน้าสินค้า หรือ { title, material_type, color, est_grams, est_minutes, qty, file_id } จากระบบภายนอก
    const items = (b.items || []).filter((i) => (i.product_id || i.title) && Number(i.qty) > 0);
    if (!items.length) throw httpErr(400, 'ยังไม่ได้เลือกสินค้า');
    if (items.length > 100) throw httpErr(400, 'รายการเยอะเกินไป (สูงสุด 100)');
    for (const i of items) if (i.file_id && !one('SELECT id FROM files WHERE id=?', String(i.file_id))) throw httpErr(400, `ไม่พบไฟล์ ${i.file_id}`);
    const d = bkkNow();
    const prefix = `PO${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    const n = one(`SELECT COUNT(DISTINCT order_no) c FROM jobs WHERE order_no LIKE ?`, prefix + '%').c + 1;
    const order_no = `${prefix}-${String(n).padStart(2, '0')}`;
    const jobs = tx(() => items.map((i) => actions.createJob({
      ...(i.product_id ? { product_id: i.product_id } : {
        title: i.title, est_grams: i.est_grams, est_minutes: i.est_minutes, file_id: i.file_id || null, price: i.price,
        material_id: i.material_id || resolveMaterial(i.material_type, i.color)?.id || null }),
      qty: i.qty, priority: b.priority || i.priority, customer: b.customer, contact: b.contact,
      due_date: b.due_date, note: [i.note, b.note].filter(Boolean).join(' / ') }, { silent: true, order_no, source: b.source })));
    const totPrice = jobs.reduce((s, j) => s + (j.price || 0), 0);
    const totG = jobs.reduce((s, j) => s + j.est_grams * j.qty, 0);
    const totM = jobs.reduce((s, j) => s + j.est_minutes * j.qty, 0);
    const totPcs = jobs.reduce((s, j) => s + j.qty, 0);
    const mats = Object.fromEntries(materialsWithReserved().map((m) => [m.id, m]));
    const head = `${b.source === 'web' ? '🌐 ออเดอร์เว็บไซต์' : '🧾 ใบสั่งพิมพ์'} ${order_no}${b.priority ? ' 🔥ด่วน' : ''}`;
    let text = `${head}\n`;
    if (b.customer) text += `ลูกค้า/ออเดอร์: ${b.customer}\n`;
    if (b.contact) text += `ติดต่อ: ${b.contact}\n`;
    if (b.due_date) text += `กำหนดส่ง: ${b.due_date}\n`;
    const lines = [{ type: 'separator', margin: 'md' }];
    for (const j of jobs) {
      const m = mats[j.material_id];
      const want = !m && j.file_id ? items.find((i) => i.title === j.title) : null; // วัสดุที่ลูกค้าเลือก แต่ยังไม่มีในสต็อก
      const mtxt = m ? matLabel(m) : want ? `${want.material_type || ''} ${want.color || ''} (ไม่มีในสต็อก)`.trim() : '-';
      text += `\n#${j.id} ${j.title} x${j.qty}${j.file_id ? ' 📎' : ''}\n   ${mtxt} ~${fmtG(j.est_grams * j.qty)}${j.est_minutes ? ' · ' + fmtMin(j.est_minutes * j.qty) : ''}`;
      if (jobs.length <= 25) lines.push({ type: 'box', layout: 'vertical', margin: 'md', contents: [
        { type: 'box', layout: 'baseline', contents: [
          { type: 'text', text: `#${j.id} ${j.title}${j.file_id ? ' 📎' : ''}`, size: 'sm', weight: 'bold', wrap: true, flex: 5 },
          { type: 'text', text: `x${j.qty}`, size: 'md', weight: 'bold', align: 'end', flex: 1, color: '#06c755' }] },
        { type: 'text', text: `${mtxt} · ~${fmtG(j.est_grams * j.qty)}${j.est_minutes ? ' · ' + fmtMin(j.est_minutes * j.qty) : ''}`, size: 'xs', color: '#8c8c8c', wrap: true }] });
    }
    const short = Object.values(mats).filter((m) => m.available_g < 0);
    text += `\n\nรวม ${jobs.length} รายการ ${totPcs} ชิ้น · ~${fmtG(totG)}${totM ? ' · ' + fmtMin(totM) : ''}`;
    if (short.length) text += `\n⚠️ วัสดุไม่พอ: ${short.map((m) => `${matLabel(m)} ขาด ${fmtG(-m.available_g)}`).join(', ')}`;
    if (b.note) text += `\n📝 ${b.note}`;
    if (jobs.length > 25) lines.push({ type: 'text', text: `(${jobs.length} รายการ — ดูรายละเอียดด้วยคำสั่ง "คิว")`, size: 'sm', wrap: true, margin: 'md' });
    lines.push({ type: 'separator', margin: 'md' });
    lines.push({ type: 'text', text: `รวม ${jobs.length} รายการ ${totPcs} ชิ้น · ~${fmtG(totG)}${totM ? ' · ' + fmtMin(totM) : ''}`, size: 'sm', weight: 'bold', margin: 'md', wrap: true });
    if (short.length) lines.push({ type: 'text', text: `⚠️ วัสดุไม่พอ: ${short.map((m) => `${matLabel(m)} ขาด ${fmtG(-m.available_g)}`).join(', ')}`, size: 'xs', color: '#ef4444', wrap: true });
    if (totPrice) {
      text += `\n💰 ยอดรวม ${baht(totPrice)}`;
      lines.push({ type: 'text', text: `💰 ยอดรวม ${baht(totPrice)}`, size: 'sm', weight: 'bold', color: '#06c755', wrap: true });
    }
    const rows = [];
    if (b.customer) rows.push(['ลูกค้า', b.customer]);
    if (b.contact) rows.push(['ติดต่อ', b.contact]);
    if (b.due_date) rows.push(['กำหนดส่ง', b.due_date]);
    if (b.note) rows.push(['หมายเหตุ', b.note]);
    const buttons = [{ label: '📋 ดูคิว', text: 'คิว' }];
    if (jobs.length === 1) buttons.unshift({ label: '▶ เริ่มพิมพ์', text: `เริ่ม ${jobs[0].id}`, primary: true });
    notify('newJob', text, flexCard({ head, color: b.priority ? '#ef4444' : '#7c3aed', rows, lines, buttons, alt: `${head} (${totPcs} ชิ้น)` }));
    return { order_no, jobs };
  },
  startJob(id, b = {}) {
    const j = jobDetail(id);
    if (!j) throw httpErr(404, 'ไม่พบงาน');
    if (j.status !== 'queued') throw httpErr(400, `งานนี้สถานะ "${STATUS_TH[j.status]}" เริ่มพิมพ์ไม่ได้`);
    let printerId = b.printer_id ? Number(b.printer_id) : null;
    if (!printerId) printerId = one(`SELECT id FROM printers WHERE active=1 AND status='idle' ORDER BY id LIMIT 1`)?.id;
    if (!printerId) throw httpErr(400, 'ไม่มีเครื่องพิมพ์ว่าง');
    const p = one('SELECT * FROM printers WHERE id=?', printerId);
    if (!p || p.status !== 'idle') throw httpErr(400, 'เครื่องพิมพ์นี้ไม่ว่าง');
    tx(() => {
      run(`UPDATE jobs SET status='printing', printer_id=?, started_at=datetime('now','localtime') WHERE id=?`, printerId, id);
      run(`UPDATE printers SET status='printing' WHERE id=?`, printerId);
    });
    const finish = j.est_minutes ? new Date(Date.now() + j.est_minutes * j.qty * 60000).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' }) : null;
    const sRows = [['งาน', `${j.title}${j.qty > 1 ? ' x' + j.qty : ''}`], ['เครื่อง', p.name]];
    if (finish) sRows.push(['คาดว่าเสร็จ', `~${finish} น.`]);
    notify('start', `▶️ เริ่มพิมพ์ #${id}\n📦 ${j.title}${j.qty > 1 ? ' x' + j.qty : ''}\n🖨 เครื่อง: ${p.name}${finish ? `\n⏱ คาดว่าเสร็จ ~${finish} น.` : ''}`,
      flexCard({ head: `▶️ เริ่มพิมพ์ #${id}`, color: '#0ea5e9', rows: sRows,
        buttons: [{ label: '✅ เสร็จ', text: `เสร็จ ${id}`, primary: true }, { label: '❌ เสีย', text: `เสีย ${id}`, primary: true, color: '#ef4444' }] }));
    return jobDetail(id);
  },
  completeJob(id, b = {}) {
    const j = jobDetail(id);
    if (!j) throw httpErr(404, 'ไม่พบงาน');
    if (j.status !== 'printing') throw httpErr(400, 'งานนี้ยังไม่ได้อยู่ในสถานะกำลังพิมพ์');
    const used = b.actual_grams !== undefined && b.actual_grams !== '' ? Number(b.actual_grams) : j.est_grams * j.qty;
    let before = null;
    tx(() => {
      run(`UPDATE jobs SET status='done', actual_grams=?, finished_at=datetime('now','localtime') WHERE id=?`, used, id);
      if (j.printer_id) run(`UPDATE printers SET status='idle' WHERE id=?`, j.printer_id);
      if (j.material_id && used > 0) {
        before = one('SELECT stock_g FROM materials WHERE id=?', j.material_id).stock_g;
        moveStock(j.material_id, -used, 'print', id, `งาน #${id}`);
      }
    });
    const next = queueList().find((x) => x.status === 'queued');
    const cost = costOf(j.material_id, used);
    const dRows = [['งาน', `${j.title}${j.qty > 1 ? ' x' + j.qty : ''}`]];
    if (j.customer) dRows.push(['ลูกค้า', j.customer]);
    dRows.push(['เครื่อง', `${j.printer_name || '-'} (ว่างแล้ว)`], ['ใช้วัสดุ', `${fmtG(used)}${cost ? ' · ต้นทุน ' + baht(cost) : ''}`]);
    dRows.push(['คิวถัดไป', next ? `#${next.id} ${next.title}` : '🎉 ไม่มีงานค้าง']);
    notify('done', `✅ พิมพ์เสร็จ #${id}\n` + dRows.map(([k, v]) => `${k}: ${v}`).join('\n'),
      flexCard({ head: `✅ พิมพ์เสร็จ #${id}`, color: '#06c755', rows: dRows,
        buttons: next ? [{ label: `▶ เริ่ม #${next.id}`, text: `เริ่ม ${next.id}`, primary: true }, { label: '📋 ดูคิว', text: 'คิว' }] : [] }));
    if (before !== null) checkLowStock(j.material_id, before);
    return jobDetail(id);
  },
  failJob(id, b = {}) {
    const j = jobDetail(id);
    if (!j) throw httpErr(404, 'ไม่พบงาน');
    if (j.status !== 'printing') throw httpErr(400, 'งานนี้ยังไม่ได้อยู่ในสถานะกำลังพิมพ์');
    const waste = Number(b.waste_grams) || 0;
    let before = null;
    let newId = null;
    tx(() => {
      run(`UPDATE jobs SET status='failed', actual_grams=?, finished_at=datetime('now','localtime'), note=TRIM(note || ' ' || ?) WHERE id=?`, waste, b.reason ? `[เสีย: ${b.reason}]` : '', id);
      if (j.printer_id) run(`UPDATE printers SET status='idle' WHERE id=?`, j.printer_id);
      if (j.material_id && waste > 0) {
        before = one('SELECT stock_g FROM materials WHERE id=?', j.material_id).stock_g;
        moveStock(j.material_id, -waste, 'waste', id, `งานเสีย #${id}`);
      }
      if (b.requeue) {
        newId = Number(run(`INSERT INTO jobs(title,customer,material_id,est_grams,est_minutes,qty,priority,due_date,note) VALUES(?,?,?,?,?,?,1,?,?)`,
          j.title, j.customer, j.material_id, j.est_grams, j.est_minutes, j.qty, j.due_date, `พิมพ์ซ้ำจาก #${id}`).lastInsertRowid);
      }
    });
    notify('failed', `❌ พิมพ์เสีย #${id}\n📦 ${j.title}\n🖨 ${j.printer_name || '-'}${b.reason ? '\n📝 สาเหตุ: ' + b.reason : ''}${waste ? '\n🗑 วัสดุเสีย ' + fmtG(waste) : ''}${newId ? `\n🔁 เพิ่มเข้าคิวใหม่เป็น #${newId} (ด่วน)` : ''}`);
    if (before !== null) checkLowStock(j.material_id, before);
    return jobDetail(id);
  },
  cancelJob(id) {
    const j = jobDetail(id);
    if (!j) throw httpErr(404, 'ไม่พบงาน');
    if (!['queued', 'printing'].includes(j.status)) throw httpErr(400, 'ยกเลิกไม่ได้');
    tx(() => {
      run(`UPDATE jobs SET status='cancelled', finished_at=datetime('now','localtime') WHERE id=?`, id);
      if (j.status === 'printing' && j.printer_id) run(`UPDATE printers SET status='idle' WHERE id=?`, j.printer_id);
    });
    notify('failed', `🚫 ยกเลิกงาน #${id} ${j.title}`);
    return jobDetail(id);
  },
  stockIn(materialId, b) {
    const m = one('SELECT * FROM materials WHERE id=?', materialId);
    if (!m) throw httpErr(404, 'ไม่พบวัสดุ');
    const g = Number(b.grams);
    if (!g) throw httpErr(400, 'กรุณาระบุจำนวนกรัม');
    const reason = b.reason === 'adjust' ? 'adjust' : 'in';
    tx(() => moveStock(materialId, g, reason, null, b.note || ''));
    const after = one('SELECT * FROM materials WHERE id=?', materialId);
    notify('stockIn', `${g > 0 ? '📥 รับวัสดุเข้า' : '📤 ปรับลดสต็อก'}\n${matLabel(m)} ${g > 0 ? '+' : ''}${fmtG(g)}\nคงเหลือ: ${fmtG(after.stock_g)}${b.note ? '\n📝 ' + b.note : ''}`);
    if (g < 0) checkLowStock(materialId, m.stock_g);
    return after;
  },
};

function summaryText() {
  const queue = queueList();
  const printing = queue.filter((j) => j.status === 'printing');
  const queued = queue.filter((j) => j.status === 'queued');
  let t = `📋 สถานะคิวพิมพ์ 3D\n`;
  t += `\n🖨 กำลังพิมพ์ (${printing.length})`;
  for (const j of printing) t += `\n • #${j.id} ${j.title} @${j.printer_name}`;
  t += `\n\n⏳ รอคิว (${queued.length})`;
  queued.slice(0, 15).forEach((j, i) => { t += `\n ${i + 1}. #${j.id} ${j.priority ? '🔥' : ''}${j.title}${j.qty > 1 ? ' x' + j.qty : ''} (${j.material_type || '-'} ${j.material_color || ''})`; });
  if (queued.length > 15) t += `\n ...และอีก ${queued.length - 15} งาน`;
  const totalMin = queued.reduce((s, j) => s + j.est_minutes * j.qty, 0);
  if (totalMin) t += `\n\n⏱ เวลารวมคิวที่รอ ~${fmtMin(totalMin)}`;
  const ps = q('SELECT * FROM printers WHERE active=1');
  if (ps.length) t += `\n\n🖥 เครื่อง: ` + ps.map((p) => `${p.name}=${PRINTER_TH[p.status]}`).join(', ');
  return t;
}
function stockText() {
  const ms = materialsWithReserved();
  let t = `🧵 สต็อกวัสดุ (${ms.length} รายการ)`;
  for (const m of ms) t += `\n${m.low ? '🔴' : '🟢'} #${m.id} ${matLabel(m)}: ${fmtG(m.stock_g)}${m.reserved_g ? ` (จองคิว ${fmtG(m.reserved_g)})` : ''}`;
  const low = ms.filter((m) => m.low);
  if (low.length) t += `\n\n⚠️ ใกล้หมด ${low.length} รายการ`;
  return t;
}
function dailyText() {
  const d = one(`SELECT COUNT(*) c, COALESCE(SUM(j.qty),0) pcs, COALESCE(SUM(j.actual_grams),0) g, COALESCE(SUM(j.actual_grams*COALESCE(m.cost_per_kg,0)/1000),0) cost
    FROM jobs j LEFT JOIN materials m ON m.id=j.material_id WHERE j.status='done' AND date(j.finished_at)=date('now','localtime')`);
  const f = one(`SELECT COUNT(*) c, COALESCE(SUM(actual_grams),0) g FROM jobs WHERE status='failed' AND date(finished_at)=date('now','localtime')`);
  const top = q(`SELECT title, SUM(qty) n FROM jobs WHERE status='done' AND date(finished_at)=date('now','localtime') GROUP BY title ORDER BY n DESC LIMIT 5`);
  const date = bkkNow().toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' });
  let t = `📊 สรุปประจำวัน ${date}\n\n✅ พิมพ์เสร็จ ${d.c} งาน (${d.pcs} ชิ้น)\n🧵 ใช้วัสดุ ${fmtG(d.g)}${d.cost ? ' · ต้นทุน ' + baht(d.cost) : ''}`;
  if (f.c) t += `\n❌ พิมพ์เสีย ${f.c} งาน (เสีย ${fmtG(f.g)})`;
  if (top.length) t += `\n\n🏆 ผลิตมากสุดวันนี้` + top.map((x) => `\n • ${x.title} x${x.n}`).join('');
  t += '\n\n' + summaryText();
  const low = materialsWithReserved().filter((m) => m.low || m.available_g < 0);
  if (low.length) t += `\n\n⚠️ วัสดุต้องสั่งเพิ่ม` + low.map((m) => `\n • ${matLabel(m)} เหลือ ${fmtG(m.stock_g)}${m.available_g < 0 ? ` (คิวต้องการเพิ่ม ${fmtG(-m.available_g)})` : ''}`).join('');
  return t;
}
setInterval(() => {
  const cfg = JSON.parse(getSetting('daily', '{}'));
  if (!cfg.enabled) return;
  const now = bkkNow();
  const hm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const today = now.toDateString();
  if (hm >= (cfg.time || '18:00') && getSetting('daily_last') !== today) {
    setSetting('daily_last', today);
    linePush(dailyText()).catch(() => {});
  }
}, 30000);
// เปิดเครื่องครั้งแรกหลังเลยเวลา ไม่ต้องส่งย้อนหลังของวันนี้
{ const cfg = JSON.parse(getSetting('daily', '{}')); const n = bkkNow();
  if (!getSetting('daily_last') && `${String(n.getHours()).padStart(2, '0')}:${String(n.getMinutes()).padStart(2, '0')}` >= (cfg.time || '18:00')) setSetting('daily_last', n.toDateString()); }

const HELP = `🤖 คำสั่งในกลุ่ม
• คิว — ดูคิวงานพิมพ์
• สรุป — สรุปยอดวันนี้
• สต็อก — ดูวัสดุคงเหลือ
• เริ่ม 12 — เริ่มพิมพ์งาน #12 (เลือกเครื่องว่างให้อัตโนมัติ)
• เสร็จ 12 — งาน #12 พิมพ์เสร็จ (ตัดสต็อกตามที่ประมาณไว้)
• เสร็จ 12 85 — เสร็จ ใช้จริง 85 กรัม
• เสีย 12 — งาน #12 พิมพ์เสีย และเพิ่มเข้าคิวใหม่
• ตั้งกลุ่มนี้ — ให้ระบบส่งแจ้งเตือนเข้ากลุ่มนี้
• ไอดี — ดู Group ID`;

async function handleLineEvent(ev) {
  const src = ev.source || {};
  const chatId = src.groupId || src.roomId || src.userId;
  if (ev.type === 'join' && src.groupId) {
    if (!getSetting('line_group_id')) setSetting('line_group_id', src.groupId);
    return lineReply(ev.replyToken, `สวัสดีครับ 👋 บอทคิวพิมพ์ 3D พร้อมใช้งาน\n${getSetting('line_group_id') === src.groupId ? '✅ ตั้งกลุ่มนี้เป็นกลุ่มรับแจ้งเตือนแล้ว' : 'พิมพ์ "ตั้งกลุ่มนี้" เพื่อรับแจ้งเตือนที่กลุ่มนี้'}\n\n${HELP}`);
  }
  if (ev.type !== 'message' || ev.message?.type !== 'text') return;
  const text = ev.message.text.trim();
  const [cmd, a1, a2] = text.split(/\s+/);
  const id = Number(String(a1 || '').replace('#', ''));
  try {
    switch (cmd.replace(/^[/!]/, '')) {
      case 'คิว': case 'queue': return lineReply(ev.replyToken, summaryText());
      case 'สต็อก': case 'สต๊อก': case 'stock': return lineReply(ev.replyToken, stockText());
      case 'สรุป': case 'summary': return lineReply(ev.replyToken, dailyText());
      case 'ช่วยเหลือ': case 'help': case 'คำสั่ง': return lineReply(ev.replyToken, HELP);
      case 'ไอดี': case 'id': return lineReply(ev.replyToken, `ID: ${chatId}`);
      case 'ตั้งกลุ่มนี้':
        setSetting('line_group_id', chatId);
        return lineReply(ev.replyToken, '✅ ตั้งค่าให้แจ้งเตือนเข้ากลุ่มนี้แล้ว');
      case 'เริ่ม': if (id) { actions.startJob(id); return; } break;
      case 'เสร็จ': if (id) { actions.completeJob(id, { actual_grams: a2 }); return; } break;
      case 'เสีย': if (id) { actions.failJob(id, { requeue: true, waste_grams: a2 }); return; } break;
    }
  } catch (e) {
    return lineReply(ev.replyToken, `❗ ${e.message}`);
  }
}

// ---------- HTTP ----------
function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }
function send(res, status, data, headers = {}) {
  const body = typeof data === 'string' || Buffer.isBuffer(data) ? data : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': typeof data === 'object' && !Buffer.isBuffer(data) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8', ...headers });
  res.end(body);
}
const readBody = (req) => new Promise((ok, bad) => {
  const c = []; let n = 0;
  req.on('data', (d) => { n += d.length; if (n <= MAX_UPLOAD_MB * 1048576) c.push(d); });
  req.on('end', () => (n > MAX_UPLOAD_MB * 1048576 ? bad(httpErr(413, `ไฟล์ใหญ่เกิน ${MAX_UPLOAD_MB}MB`)) : ok(Buffer.concat(c)))); req.on('error', bad);
});
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png' };

const routes = [];
const route = (method, pattern, fn, raw = false) => routes.push({ method, raw, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), fn });

route('GET', '/api/dashboard', () => {
  const ms = materialsWithReserved();
  const today = one(`SELECT COUNT(*) c, COALESCE(SUM(j.actual_grams),0) g, COALESCE(SUM(j.actual_grams*COALESCE(m.cost_per_kg,0)/1000),0) cost
    FROM jobs j LEFT JOIN materials m ON m.id=j.material_id WHERE j.status IN ('done','failed') AND date(j.finished_at)=date('now','localtime')`);
  return {
    queue: queueList(), materials: ms, printers: q('SELECT * FROM printers WHERE active=1 ORDER BY id'),
    stats: { queued: one(`SELECT COUNT(*) c FROM jobs WHERE status='queued'`).c, printing: one(`SELECT COUNT(*) c FROM jobs WHERE status='printing'`).c, doneToday: today.c, usedToday: today.g, costToday: today.cost, lowStock: ms.filter((m) => m.low).length },
  };
});
route('GET', '/api/jobs', (_, url) => {
  const status = url.searchParams.get('status');
  return q(`SELECT j.*, m.type AS material_type, m.color AS material_color, p.name AS printer_name,
      COALESCE(j.actual_grams,0)*COALESCE(m.cost_per_kg,0)/1000 AS cost, pr.price AS unit_price FROM jobs j
    LEFT JOIN materials m ON m.id=j.material_id LEFT JOIN printers p ON p.id=j.printer_id LEFT JOIN products pr ON pr.id=j.product_id
    ${status ? 'WHERE j.status=?' : ''} ORDER BY j.id DESC LIMIT 300`, ...(status ? [status] : []));
});
route('POST', '/api/jobs', (b) => actions.createJob(b));
route('PUT', '/api/jobs/:id', (b, _, p) => {
  const j = jobDetail(p.id);
  if (!j) throw httpErr(404, 'ไม่พบงาน');
  if (j.status !== 'queued') throw httpErr(400, 'แก้ไขได้เฉพาะงานที่รอคิว');
  run(`UPDATE jobs SET title=?,customer=?,material_id=?,est_grams=?,est_minutes=?,qty=?,priority=?,due_date=?,note=? WHERE id=?`,
    b.title || j.title, b.customer ?? j.customer, b.material_id || null, Number(b.est_grams) || 0, Number(b.est_minutes) || 0,
    Math.max(1, Number(b.qty) || 1), b.priority ? 1 : 0, b.due_date || '', b.note || '', p.id);
  return jobDetail(p.id);
});
route('POST', '/api/jobs/:id/start', (b, _, p) => actions.startJob(Number(p.id), b));
route('POST', '/api/jobs/:id/complete', (b, _, p) => actions.completeJob(Number(p.id), b));
route('POST', '/api/jobs/:id/fail', (b, _, p) => actions.failJob(Number(p.id), b));
route('POST', '/api/jobs/:id/cancel', (_, __, p) => actions.cancelJob(Number(p.id)));

route('GET', '/api/materials', () => materialsWithReserved());
route('POST', '/api/materials', (b) => {
  if (!b.type) throw httpErr(400, 'กรุณาระบุชนิดวัสดุ');
  const name = b.name || `${b.type} ${b.color || ''}`.trim();
  const id = Number(run(`INSERT INTO materials(name,type,color,brand,stock_g,min_g,cost_per_kg) VALUES(?,?,?,?,0,?,?)`,
    name, b.type, b.color || '', b.brand || '', Number(b.min_g) || 0, Number(b.cost_per_kg) || 0).lastInsertRowid);
  if (Number(b.stock_g) > 0) moveStock(id, Number(b.stock_g), 'in', null, 'ยอดยกมา');
  return one('SELECT * FROM materials WHERE id=?', id);
});
route('PUT', '/api/materials/:id', (b, _, p) => {
  const m = one('SELECT * FROM materials WHERE id=?', p.id);
  if (!m) throw httpErr(404, 'ไม่พบวัสดุ');
  run(`UPDATE materials SET name=?,type=?,color=?,brand=?,min_g=?,cost_per_kg=? WHERE id=?`,
    b.name || m.name, b.type || m.type, b.color ?? m.color, b.brand ?? m.brand, Number(b.min_g ?? m.min_g), Number(b.cost_per_kg ?? m.cost_per_kg), p.id);
  return one('SELECT * FROM materials WHERE id=?', p.id);
});
route('DELETE', '/api/materials/:id', (_, __, p) => { run('UPDATE materials SET active=0 WHERE id=?', p.id); return { ok: true }; });
route('POST', '/api/materials/:id/stock', (b, _, p) => actions.stockIn(Number(p.id), b));
route('GET', '/api/stock-moves', () => q(`SELECT s.*, m.type, m.color, m.brand FROM stock_moves s JOIN materials m ON m.id=s.material_id ORDER BY s.id DESC LIMIT 300`));

route('GET', '/api/printers', () => q('SELECT * FROM printers WHERE active=1 ORDER BY id'));
route('POST', '/api/printers', (b) => {
  if (!b.name) throw httpErr(400, 'กรุณาระบุชื่อเครื่อง');
  return one('SELECT * FROM printers WHERE id=?', Number(run('INSERT INTO printers(name,model) VALUES(?,?)', b.name, b.model || '').lastInsertRowid));
});
route('PUT', '/api/printers/:id', (b, _, p) => {
  const pr = one('SELECT * FROM printers WHERE id=?', p.id);
  if (!pr) throw httpErr(404, 'ไม่พบเครื่อง');
  if (b.status && b.status !== pr.status) {
    if (pr.status === 'printing') throw httpErr(400, 'เครื่องกำลังพิมพ์อยู่ ให้จบงานก่อน');
    if (!['idle', 'maintenance'].includes(b.status)) throw httpErr(400, 'สถานะไม่ถูกต้อง');
  }
  run('UPDATE printers SET name=?, model=?, status=? WHERE id=?', b.name || pr.name, b.model ?? pr.model, b.status || pr.status, p.id);
  if (b.status === 'maintenance' && pr.status !== 'maintenance') notify('failed', `🔧 เครื่อง ${pr.name} เข้าซ่อมบำรุง`);
  return one('SELECT * FROM printers WHERE id=?', p.id);
});
route('DELETE', '/api/printers/:id', (_, __, p) => {
  if (one('SELECT status FROM printers WHERE id=?', p.id)?.status === 'printing') throw httpErr(400, 'เครื่องกำลังพิมพ์อยู่');
  run('UPDATE printers SET active=0 WHERE id=?', p.id); return { ok: true };
});

route('GET', '/api/settings', () => ({
  line_token_set: !!LINE_TOKEN, line_secret_set: !!LINE_SECRET, line_group_id: getSetting('line_group_id'),
  notify: JSON.parse(getSetting('notify', '{}')), flex: getSetting('flex') === '1', daily: JSON.parse(getSetting('daily', '{}')), log: q('SELECT * FROM notify_log ORDER BY id DESC LIMIT 20'),
}));
route('PUT', '/api/settings', (b) => {
  if (b.line_group_id !== undefined) setSetting('line_group_id', b.line_group_id.trim());
  if (b.notify) setSetting('notify', JSON.stringify(b.notify));
  if (b.flex !== undefined) setSetting('flex', b.flex ? '1' : '0');
  if (b.daily) setSetting('daily', JSON.stringify({ enabled: !!b.daily.enabled, time: /^\d{2}:\d{2}$/.test(b.daily.time) ? b.daily.time : '18:00' }));
  return { ok: true };
});
route('POST', '/api/line/test', async () => linePush('🔔 ทดสอบการแจ้งเตือนจากระบบคิวพิมพ์ 3D สำเร็จ!'));
route('POST', '/api/line/summary', async () => linePush(summaryText() + '\n\n' + stockText()));
route('POST', '/api/line/daily', async () => linePush(dailyText()));

// สินค้า (จาก Shopee) + ใบสั่งพิมพ์
route('GET', '/api/products', () => q(`SELECT p.*, m.type AS material_type, m.color AS material_color,
    (SELECT COALESCE(SUM(j.qty),0) FROM jobs j WHERE j.product_id=p.id AND j.status IN ('queued','printing')) AS in_queue,
    (SELECT COALESCE(SUM(j.qty),0) FROM jobs j WHERE j.product_id=p.id AND j.status='done') AS printed
  FROM products p LEFT JOIN materials m ON m.id=p.material_id ORDER BY p.hidden, p.shop_product_id DESC, p.variation_name`));
route('POST', '/api/products/import', (buf) => importShopee(buf), true);
route('PUT', '/api/products/:id', (b, _, p) => {
  const pr = one('SELECT * FROM products WHERE id=?', p.id);
  if (!pr) throw httpErr(404, 'ไม่พบสินค้า');
  const fields = ['short_name', 'est_grams', 'est_minutes', 'material_id', 'hidden'].filter((k) => b[k] !== undefined);
  const val = (k) => (k === 'material_id' ? b[k] || null : k === 'short_name' ? String(b[k]).trim() || pr.short_name : Number(b[k]) || 0);
  // ชื่อย่อ/กรัม/เวลา/ซ่อน ใช้ร่วมทุกตัวเลือกของสินค้าเดียวกัน (ยกเว้นวัสดุซึ่งขึ้นกับสี) เมื่อส่ง all=true
  for (const k of fields) {
    if (b.all && k !== 'material_id') run(`UPDATE products SET ${k}=? WHERE shop_product_id=?`, val(k), pr.shop_product_id);
    else run(`UPDATE products SET ${k}=? WHERE id=?`, val(k), p.id);
  }
  return one('SELECT * FROM products WHERE id=?', p.id);
});
route('POST', '/api/products/auto-material', () => {
  let n = 0;
  for (const p of q('SELECT * FROM products WHERE material_id IS NULL')) { const m = guessMaterial(p); if (m) { run('UPDATE products SET material_id=? WHERE id=?', m.id, p.id); n++; } }
  return { updated: n };
});
route('POST', '/api/orders', (b) => actions.createOrder(b));

// ---------- สำหรับระบบภายนอก (เว็บไซต์) ใช้ X-API-Key ----------
route('POST', '/api/external/files', (buf, _, __, req) => {
  if (!buf.length) throw httpErr(400, 'ไฟล์ว่าง');
  const name = decodeURIComponent(String(req.headers['x-file-name'] || 'model.stl')).replace(/[^\p{L}\p{M}\p{N}._ -]/gu, '_').slice(-120) || 'model.stl';
  const id = crypto.randomUUID();
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  const stored = `${id}${path.extname(name).toLowerCase().slice(0, 8)}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, stored), buf);
  run('INSERT INTO files(id,name,stored,size) VALUES(?,?,?,?)', id, name, stored, buf.length);
  return { id, name, size: buf.length };
}, true);
route('POST', '/api/external/orders', (b) => actions.createOrder({ ...b, source: b.source || 'web' }));
route('GET', '/api/external/health', () => ({ ok: true }));

function checkAuth(req) {
  if (!ADMIN_PASSWORD) return true;
  const h = req.headers.authorization || '';
  const [, b64] = h.split(' ');
  const [, pass] = Buffer.from(b64 || '', 'base64').toString().split(':');
  return pass && crypto.timingSafeEqual(crypto.createHash('sha256').update(pass).digest(), crypto.createHash('sha256').update(ADMIN_PASSWORD).digest());
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    // LINE webhook (ไม่ต้องล็อกอิน แต่ตรวจลายเซ็น)
    if (url.pathname === '/webhook' && req.method === 'POST') {
      const raw = await readBody(req);
      if (LINE_SECRET) {
        const sig = crypto.createHmac('sha256', LINE_SECRET).update(raw).digest('base64');
        const got = req.headers['x-line-signature'] || '';
        if (sig.length !== got.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(got))) return send(res, 401, 'bad signature');
      }
      send(res, 200, 'OK');
      const body = JSON.parse(raw.toString() || '{}');
      for (const ev of body.events || []) handleLineEvent(ev).catch((e) => console.error(e));
      return;
    }
    if (url.pathname === '/healthz') return send(res, 200, 'ok');
    if (url.pathname.startsWith('/api/external/')) {
      const key = String(req.headers['x-api-key'] || '');
      const ok = INTEGRATION_API_KEY && key.length === INTEGRATION_API_KEY.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(INTEGRATION_API_KEY));
      if (!ok) return send(res, 401, { error: 'invalid api key' });
    } else if (!checkAuth(req)) return send(res, 401, 'ต้องเข้าสู่ระบบ', { 'WWW-Authenticate': 'Basic realm="3D Print"' });

    // ดาวน์โหลดไฟล์งาน (ต้องล็อกอิน)
    const fm = url.pathname.match(/^\/files\/([0-9a-f-]{36})$/);
    if (fm && req.method === 'GET') {
      const f = one('SELECT * FROM files WHERE id=?', fm[1]);
      if (!f) return send(res, 404, 'not found');
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': f.size,
        'Content-Disposition': `attachment; filename="file${path.extname(f.name)}"; filename*=UTF-8''${encodeURIComponent(f.name)}` });
      return fs.createReadStream(path.join(UPLOAD_DIR, f.stored)).pipe(res);
    }

    if (url.pathname.startsWith('/api/')) {
      for (const r of routes) {
        const m = r.method === req.method && url.pathname.match(r.re);
        if (!m) continue;
        const raw = await readBody(req);
        const body = r.raw ? raw : raw.length ? JSON.parse(raw.toString()) : {};
        return send(res, 200, await r.fn(body, url, m.groups || {}, req));
      }
      return send(res, 404, { error: 'not found' });
    }
    // ไฟล์หน้าเว็บ
    const file = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[/\\])+/, ''));
    if (file.startsWith(path.join(__dirname, 'public')) && fs.existsSync(file) && fs.statSync(file).isFile()) {
      return send(res, 200, fs.readFileSync(file), { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    }
    send(res, 404, 'not found');
  } catch (e) {
    if (!e.status) console.error(e);
    send(res, e.status || 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`🖨  ระบบคิวพิมพ์ 3D + สต็อก: http://localhost:${PORT}`);
  console.log(`   LINE webhook: http://<โดเมนของคุณ>/webhook`);
  if (!LINE_TOKEN) console.log('   ⚠️ ยังไม่ได้ตั้ง LINE_CHANNEL_ACCESS_TOKEN (ข้อความจะแสดงใน console แทน)');
});

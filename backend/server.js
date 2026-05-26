/**
 * server.js — Backend API para Control de Gastos
 * Express + better-sqlite3 + multer
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const Database = require('better-sqlite3');

// ─── Configuración ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

// Asegurar que existen los directorios de datos
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(path.join(UPLOADS_DIR, 'tickets'), { recursive: true });
fs.mkdirSync(path.join(UPLOADS_DIR, 'extractos'), { recursive: true });

// ─── Base de datos SQLite ────────────────────────────────────────
const db = new Database(path.join(DATA_DIR, 'database.sqlite'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Crear tablas si no existen
db.exec(`
  CREATE TABLE IF NOT EXISTS app_state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS categories (
    id            TEXT PRIMARY KEY,
    name          TEXT NOT NULL,
    icon          TEXT NOT NULL DEFAULT 'payments',
    color         TEXT NOT NULL DEFAULT 'slate-100',
    textColor     TEXT NOT NULL DEFAULT 'slate-600',
    darkColor     TEXT NOT NULL DEFAULT 'slate-900/30',
    darkTextColor TEXT NOT NULL DEFAULT 'slate-400',
    budgetLimit   REAL NOT NULL DEFAULT 500,
    isDefault     INTEGER NOT NULL DEFAULT 0,
    sortOrder     INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id         TEXT PRIMARY KEY,
    store      TEXT NOT NULL,
    amount     REAL NOT NULL,
    categoryId TEXT NOT NULL,
    date       TEXT NOT NULL,
    type       TEXT NOT NULL DEFAULT 'expense',
    ticketUrl  TEXT,
    createdAt  TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (categoryId) REFERENCES categories(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS imported_files (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    fileName TEXT NOT NULL UNIQUE,
    importedAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// ─── Datos por defecto (seed) ────────────────────────────────────
function seedDefaults() {
  const catCount = db.prepare('SELECT COUNT(*) as cnt FROM categories').get();
  if (catCount.cnt === 0) {
    const insertCat = db.prepare(`
      INSERT INTO categories (id, name, icon, color, textColor, darkColor, darkTextColor, budgetLimit, isDefault, sortOrder)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const defaults = [
      ['cat-ocio',         'Ocio',         'coffee',          'orange-100', 'orange-600', 'orange-900/30', 'orange-400', 500, 1, 0],
      ['cat-hogar',        'Hogar',        'home',            'blue-100',   'blue-600',   'blue-900/30',   'blue-400',   500, 1, 1],
      ['cat-alimentacion', 'Alimentación', 'shopping_basket', 'green-100',  'green-600',  'green-900/30',  'green-400',  500, 1, 2],
      ['cat-nomina',       'Nómina',       'payments',        'emerald-100','emerald-600','emerald-900/30','emerald-400', 500, 1, 3],
      ['cat-compras',      'Compras',      'shopping_cart',   'purple-100', 'purple-600', 'purple-900/30', 'purple-400', 500, 1, 4],
    ];

    const tx = db.transaction(() => {
      for (const d of defaults) {
        insertCat.run(...d);
      }
    });
    tx();
  }

  // Estado inicial por defecto
  const stateCount = db.prepare('SELECT COUNT(*) as cnt FROM app_state').get();
  if (stateCount.cnt === 0) {
    const ins = db.prepare('INSERT OR IGNORE INTO app_state (key, value) VALUES (?, ?)');
    const tx = db.transaction(() => {
      ins.run('budget', '2000');
      ins.run('language', 'es');
      ins.run('theme', 'light');
      ins.run('googleApiKey', '');
    });
    tx();
  }
}
seedDefaults();

// ─── Express App ─────────────────────────────────────────────────
const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// Servir archivos subidos (tickets, extractos)
app.use('/uploads', express.static(UPLOADS_DIR));

// Servir frontend estático
app.use(express.static(path.join(__dirname, '..', 'control_gastos_app')));

// ─── Multer para subida de archivos ─────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const type = req.query.type === 'extracto' ? 'extractos' : 'tickets';
    cb(null, path.join(UPLOADS_DIR, type));
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const safeName = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}${ext}`;
    cb(null, safeName);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 20 * 1024 * 1024 } // 20 MB max
});

// ═══════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════

// ─── Estado de la app ────────────────────────────────────────────
app.get('/api/state', (req, res) => {
  const rows = db.prepare('SELECT key, value FROM app_state').all();
  const state = {};
  rows.forEach(r => { state[r.key] = r.value; });
  // Convertir budget a número
  if (state.budget) state.budget = parseFloat(state.budget);
  res.json(state);
});

app.post('/api/state', (req, res) => {
  const upsert = db.prepare('INSERT INTO app_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  const tx = db.transaction(() => {
    for (const [key, value] of Object.entries(req.body)) {
      upsert.run(key, String(value));
    }
  });
  tx();
  res.json({ ok: true });
});

// ─── Categorías ──────────────────────────────────────────────────
app.get('/api/categories', (req, res) => {
  const cats = db.prepare('SELECT * FROM categories ORDER BY sortOrder ASC').all();
  // Convertir isDefault integer a boolean para el frontend
  res.json(cats.map(c => ({ ...c, isDefault: !!c.isDefault })));
});

app.post('/api/categories', (req, res) => {
  const { id, name, icon, color, textColor, darkColor, darkTextColor, budgetLimit } = req.body;
  if (!id || !name) {
    return res.status(400).json({ error: 'id y name son requeridos' });
  }
  const maxOrder = db.prepare('SELECT COALESCE(MAX(sortOrder), 0) as m FROM categories').get();
  db.prepare(`
    INSERT INTO categories (id, name, icon, color, textColor, darkColor, darkTextColor, budgetLimit, isDefault, sortOrder)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
  `).run(id, name, icon || 'payments', color || 'slate-100', textColor || 'slate-600',
         darkColor || 'slate-900/30', darkTextColor || 'slate-400', budgetLimit || 500, maxOrder.m + 1);
  res.json({ ok: true, id });
});

app.put('/api/categories/:id', (req, res) => {
  const { budgetLimit, name, icon, color, textColor, darkColor, darkTextColor } = req.body;
  const fields = [];
  const values = [];

  if (budgetLimit !== undefined) { fields.push('budgetLimit = ?'); values.push(budgetLimit); }
  if (name !== undefined) { fields.push('name = ?'); values.push(name); }
  if (icon !== undefined) { fields.push('icon = ?'); values.push(icon); }
  if (color !== undefined) { fields.push('color = ?'); values.push(color); }
  if (textColor !== undefined) { fields.push('textColor = ?'); values.push(textColor); }
  if (darkColor !== undefined) { fields.push('darkColor = ?'); values.push(darkColor); }
  if (darkTextColor !== undefined) { fields.push('darkTextColor = ?'); values.push(darkTextColor); }

  if (fields.length === 0) return res.status(400).json({ error: 'No fields to update' });

  values.push(req.params.id);
  db.prepare(`UPDATE categories SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  res.json({ ok: true });
});

app.delete('/api/categories/:id', (req, res) => {
  const catId = req.params.id;
  // Reasignar transacciones a cat-ocio
  db.prepare("UPDATE transactions SET categoryId = 'cat-ocio' WHERE categoryId = ?").run(catId);
  db.prepare('DELETE FROM categories WHERE id = ? AND isDefault = 0').run(catId);
  res.json({ ok: true });
});

// ─── Transacciones ───────────────────────────────────────────────
app.get('/api/transactions', (req, res) => {
  const txs = db.prepare('SELECT * FROM transactions ORDER BY createdAt DESC').all();
  res.json(txs);
});

app.post('/api/transactions', (req, res) => {
  const items = Array.isArray(req.body) ? req.body : [req.body];
  const insert = db.prepare(`
    INSERT INTO transactions (id, store, amount, categoryId, date, type, ticketUrl)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    for (const item of items) {
      insert.run(
        item.id || `tx-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`,
        item.store,
        item.amount,
        item.categoryId,
        item.date,
        item.type || 'expense',
        item.ticketUrl || null
      );
    }
  });
  tx();
  res.json({ ok: true, count: items.length });
});

app.delete('/api/transactions/:id', (req, res) => {
  db.prepare('DELETE FROM transactions WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ─── Archivos importados (tracking de PDFs ya procesados) ────────
app.get('/api/imported-files', (req, res) => {
  const files = db.prepare('SELECT fileName FROM imported_files ORDER BY importedAt DESC').all();
  res.json(files.map(f => f.fileName));
});

app.post('/api/imported-files', (req, res) => {
  const { fileName } = req.body;
  if (!fileName) return res.status(400).json({ error: 'fileName requerido' });
  try {
    db.prepare('INSERT OR IGNORE INTO imported_files (fileName) VALUES (?)').run(fileName);
  } catch (_) { /* ignore duplicate */ }
  res.json({ ok: true });
});

// ─── Upload de archivos ─────────────────────────────────────────
app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No se ha proporcionado ningún archivo' });
  }
  const type = req.query.type === 'extracto' ? 'extractos' : 'tickets';
  const url = `/uploads/${type}/${req.file.filename}`;
  res.json({ ok: true, url, filename: req.file.filename });
});

// ─── Health check ────────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// ─── Fallback: SPA ──────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'control_gastos_app', 'index.html'));
});

// ─── Start Server ────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  🚀 Control de Gastos Backend`);
  console.log(`  ───────────────────────────`);
  console.log(`  → Servidor:  http://localhost:${PORT}`);
  console.log(`  → API:       http://localhost:${PORT}/api/health`);
  console.log(`  → Base Datos: ${path.join(DATA_DIR, 'database.sqlite')}`);
  console.log(`  → Uploads:   ${UPLOADS_DIR}\n`);
});

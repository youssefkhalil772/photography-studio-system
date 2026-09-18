'use strict';

const path = require('path');
const fs = require('fs');
const bcrypt = require('bcryptjs');

let db = null;
let appRef = null;

// ─── Current session state (per-process) ──────────────────────────────────────
let currentSession = {
  userId: null,
  employeeId: null,
  username: null,
  role: null,
  shiftId: null,
  loginSessionId: null
};

function getDb(app) {
  if (db) return db;
  appRef = app;

  const Database = require('better-sqlite3');
  const userDataPath = app.getPath('userData');
  const dbPath = path.join(userDataPath, 'photostudio.db');

  db = new Database(dbPath, { verbose: null });
  
  // ─── Core & High-Performance Pragmas ───
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');     // Faster writes in WAL mode
  db.pragma('cache_size = -64000');      // 64MB Cache (negative = KB)
  db.pragma('temp_store = MEMORY');      // Use memory for temporary tables
  db.pragma('mmap_size = 300000000');    // Memory-mapped I/O (~300MB)

  initSchema();     // أولاً: أنشئ الجداول لو مش موجودة
  migrateSchema();  // ثانياً: طبّق الـ migrations (ALTER TABLE وغيرها)
  runSeed();

  // استعادة الشيفت المفتوح تلقائياً في الجلسة الحالية عند إعادة تشغيل البرنامج
  try {
    const activeShift = db.prepare("SELECT id FROM shifts WHERE status = 'مفتوح' ORDER BY id DESC LIMIT 1").get();
    if (activeShift) {
      currentSession.shiftId = activeShift.id;
      console.log(`[Shift] Restored active shift ID: ${activeShift.id}`);
    }
  } catch (e) {
    console.error('[Shift] Failed to restore active shift ID:', e);
  }

  return db;
}

function getDbPath() {
  if (!appRef) return null;
  return path.join(appRef.getPath('userData'), 'photostudio.db');
}

// ─── External Backup Path (حفظ مسار النسخ الخارجية) ─────────────────────────
function getExternalBackupSettingsPath() {
  if (!appRef) return null;
  return path.join(appRef.getPath('userData'), 'external-backup.json');
}

function getExternalBackupPath() {
  try {
    const p = getExternalBackupSettingsPath();
    if (!p || !fs.existsSync(p)) return null;
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    return data.externalBackupDir || null;
  } catch {
    return null;
  }
}

function setExternalBackupPath(dir) {
  try {
    const p = getExternalBackupSettingsPath();
    if (!p) return { success: false, error: 'لم يتم تهيئة التطبيق' };
    fs.writeFileSync(p, JSON.stringify({ externalBackupDir: dir }), 'utf8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function migrateSchema() {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY)');
  const row = db.prepare('SELECT MAX(version) as v FROM schema_migrations').get();
  let currentVersion = row ? (row.v || 0) : 0;

  const runSafe = (sql) => {
    try { db.exec(sql); } catch (e) { /* ignore if already applied */ }
  };

  const migrations = [
    {
      version: 1,
      run: () => {
        runSafe("ALTER TABLE shifts ADD COLUMN status TEXT DEFAULT 'مفتوح'");
        runSafe("ALTER TABLE shifts ADD COLUMN user_id INTEGER REFERENCES users(id)");
        runSafe("ALTER TABLE shifts ADD COLUMN opening_cash REAL DEFAULT 0");
        runSafe("ALTER TABLE shifts ADD COLUMN expected_cash REAL");
        runSafe("ALTER TABLE shifts ADD COLUMN actual_cash_counted REAL");
        runSafe("ALTER TABLE shifts ADD COLUMN cash_difference REAL");
        runSafe("ALTER TABLE shifts ADD COLUMN vodafone_cash_expected REAL DEFAULT 0");
        runSafe("ALTER TABLE shifts ADD COLUMN vodafone_cash_actual REAL DEFAULT 0");
        runSafe("ALTER TABLE shifts ADD COLUMN total_returns REAL DEFAULT 0");
        runSafe("ALTER TABLE shifts ADD COLUMN invoice_count INTEGER DEFAULT 0");
        runSafe("ALTER TABLE shifts ADD COLUMN closed_by_user_id INTEGER REFERENCES users(id)");
      }
    },
    {
      version: 2,
      run: () => {
        runSafe("ALTER TABLE employees ADD COLUMN commission_percent REAL DEFAULT 0");
        runSafe("ALTER TABLE employees ADD COLUMN salary_type TEXT DEFAULT 'ثابت'");
        runSafe("ALTER TABLE employees ADD COLUMN monthly_leave_days INTEGER DEFAULT 2");
      }
    },
    {
      version: 3,
      run: () => {
        runSafe("ALTER TABLE company_settings ADD COLUMN receipt_notes TEXT");
        runSafe("ALTER TABLE company_settings ADD COLUMN show_customer_phone INTEGER DEFAULT 1");
        runSafe("ALTER TABLE company_settings ADD COLUMN logo_path TEXT");
        runSafe("ALTER TABLE company_settings ADD COLUMN prevent_cashier_price_edit INTEGER DEFAULT 0");
      }
    },
    {
      version: 4,
      run: () => {
        runSafe("ALTER TABLE company_settings ADD COLUMN cashier_hide_reports INTEGER DEFAULT 0");
        runSafe("ALTER TABLE company_settings ADD COLUMN cashier_hide_hr INTEGER DEFAULT 0");
        runSafe("ALTER TABLE company_settings ADD COLUMN cashier_prevent_returns INTEGER DEFAULT 0");
        runSafe("ALTER TABLE company_settings ADD COLUMN cashier_hide_finance INTEGER DEFAULT 0");
        runSafe("ALTER TABLE company_settings ADD COLUMN cashier_prevent_discount INTEGER DEFAULT 0");
        runSafe("ALTER TABLE company_settings ADD COLUMN cashier_prevent_settings INTEGER DEFAULT 0");
      }
    },
    {
      version: 5,
      run: () => {
        runSafe("ALTER TABLE company_settings ADD COLUMN wa_phone1 TEXT DEFAULT ''");
        runSafe("ALTER TABLE company_settings ADD COLUMN wa_phone2 TEXT DEFAULT ''");
        runSafe("ALTER TABLE company_settings ADD COLUMN wa_tpl_invoice_confirm TEXT DEFAULT ''");
        runSafe("ALTER TABLE company_settings ADD COLUMN wa_tpl_order_ready TEXT DEFAULT ''");
        runSafe("ALTER TABLE company_settings ADD COLUMN wa_tpl_delivered TEXT DEFAULT ''");
        runSafe("ALTER TABLE company_settings ADD COLUMN wa_tpl_full_payment TEXT DEFAULT ''");
        runSafe("ALTER TABLE company_settings ADD COLUMN wa_tpl_partial_payment TEXT DEFAULT ''");
      }
    },
    {
      version: 6,
      run: () => {
        runSafe("ALTER TABLE invoices ADD COLUMN status TEXT DEFAULT 'تحت الشغل'");
      }
    },
    {
      version: 7,
      run: () => {
        runSafe("ALTER TABLE returns ADD COLUMN shift_id INTEGER REFERENCES shifts(id)");
      }
    },
    {
      version: 8,
      run: () => {
        runSafe("DROP TABLE IF EXISTS shifts_old");
      }
    },
    {
      version: 9,
      run: () => {
        runSafe("UPDATE expenses SET payment_source = 'الخزينة' WHERE payment_source = 'خزينة'");
      }
    },
    {
      version: 10,
      run: () => {
        // High Performance Indexes
        runSafe("CREATE INDEX IF NOT EXISTS idx_invoices_customer_id ON invoices(customer_id)");
        runSafe("CREATE INDEX IF NOT EXISTS idx_invoices_shift_id ON invoices(shift_id)");
        runSafe("CREATE INDEX IF NOT EXISTS idx_invoices_employee_id ON invoices(employee_id)");
        runSafe("CREATE INDEX IF NOT EXISTS idx_invoice_items_invoice_id ON invoice_items(invoice_id)");
        runSafe("CREATE INDEX IF NOT EXISTS idx_returns_shift_id ON returns(shift_id)");
        runSafe("CREATE INDEX IF NOT EXISTS idx_return_items_return_id ON return_items(return_id)");
        runSafe("CREATE INDEX IF NOT EXISTS idx_expenses_shift_id ON expenses(shift_id)");
        runSafe("CREATE INDEX IF NOT EXISTS idx_attendance_shift_id ON attendance(shift_id)");
      }
    },
    {
      version: 11,
      run: () => {
        // جدول إعدادات مزوّد الواتساب — Multi-Provider Support
        runSafe(`
          CREATE TABLE IF NOT EXISTS whatsapp_settings (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            provider TEXT NOT NULL DEFAULT 'web_js',
            wa_phone_number_id TEXT,
            wa_access_token TEXT,
            wa_business_account_id TEXT,
            wa_api_version TEXT DEFAULT 'v20.0',
            web_session_client_id TEXT DEFAULT 'photostudio-whatsapp',
            web_session_path TEXT,
            is_active INTEGER DEFAULT 1,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);

        // إدخال صف افتراضي بـ web_js للعملاء الحاليين (backward compatible)
        runSafe(`
          INSERT OR IGNORE INTO whatsapp_settings (id, provider, web_session_client_id)
          VALUES (1, 'web_js', 'photostudio-whatsapp')
        `);

        // جدول خريطة القوالب المنطقية → الأسماء الفعلية على Meta
        runSafe(`
          CREATE TABLE IF NOT EXISTS whatsapp_template_map (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            logical_key TEXT NOT NULL UNIQUE,
            actual_template_name TEXT NOT NULL,
            language_code TEXT DEFAULT 'ar'
          )
        `);
      }
    },
    {
      version: 12,
      run: () => {
        runSafe("ALTER TABLE company_settings ADD COLUMN admin_wa_phone TEXT DEFAULT ''");
      }
    },
    {
      version: 13,
      run: () => {
        runSafe("ALTER TABLE company_settings ADD COLUMN report_save_path TEXT DEFAULT ''");
      }
    },
    {
      version: 14,
      run: () => {
        runSafe("ALTER TABLE treasury ADD COLUMN shift_id INTEGER REFERENCES shifts(id)");
        runSafe("ALTER TABLE advances ADD COLUMN shift_id INTEGER REFERENCES shifts(id)");
        runSafe("CREATE INDEX IF NOT EXISTS idx_treasury_shift_id ON treasury(shift_id)");
        runSafe("CREATE INDEX IF NOT EXISTS idx_advances_shift_id ON advances(shift_id)");
      }
    },
    {
      version: 15,
      run: () => {
        runSafe("ALTER TABLE company_settings ADD COLUMN day_cutoff_hour INTEGER DEFAULT 0");
      }
    },
    {
      version: 16,
      run: () => {
        runSafe("ALTER TABLE shifts ADD COLUMN instapay_cash_expected REAL DEFAULT 0");
        runSafe("ALTER TABLE shifts ADD COLUMN instapay_cash_actual REAL DEFAULT 0");
      }
    },
    {
      version: 17,
      run: () => {
        runSafe(`
          INSERT OR IGNORE INTO whatsapp_template_map (logical_key, actual_template_name, language_code)
          VALUES ('daily_report', 'daily_report', 'ar')
        `);
      }
    },
    {
      version: 18,
      run: () => {
        // أعمدة إعدادات الـ Webhook
        runSafe("ALTER TABLE whatsapp_settings ADD COLUMN webhook_port INTEGER DEFAULT 3000");
        runSafe("ALTER TABLE whatsapp_settings ADD COLUMN webhook_verify_token TEXT DEFAULT 'photostudio_wa_token'");
        runSafe("ALTER TABLE whatsapp_settings ADD COLUMN webhook_custom_url TEXT DEFAULT ''");
        runSafe("ALTER TABLE whatsapp_settings ADD COLUMN webhook_auto_tunnel INTEGER DEFAULT 1");

        // جدول رسائل ومحادثات الواتساب
        runSafe(`
          CREATE TABLE IF NOT EXISTS whatsapp_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            wa_message_id TEXT UNIQUE,
            phone TEXT NOT NULL,
            sender_name TEXT,
            direction TEXT NOT NULL,
            message_type TEXT DEFAULT 'text',
            message_body TEXT,
            media_url TEXT,
            status TEXT DEFAULT 'received',
            is_read INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
          )
        `);
        runSafe("CREATE INDEX IF NOT EXISTS idx_wa_messages_phone ON whatsapp_messages(phone)");
        runSafe("CREATE INDEX IF NOT EXISTS idx_wa_messages_created ON whatsapp_messages(created_at)");
        runSafe("CREATE INDEX IF NOT EXISTS idx_wa_messages_read ON whatsapp_messages(is_read)");
      }
    },
    {
      version: 19,
      run: () => {
        runSafe("SELECT 1");
      }
    },
    {
      version: 20,
      run: () => {
        // Dynamic drop of legacy columns if present in existing DBs
        try {
          const legacyKey = String.fromCharCode(116, 97, 105, 108, 111, 114);
          const invCols = db.prepare("PRAGMA table_info(invoices)").all().map(c => c.name);
          for (const c of invCols) {
            if (c.includes(legacyKey)) runSafe(`ALTER TABLE invoices DROP COLUMN ${c}`);
          }
          const setCols = db.prepare("PRAGMA table_info(company_settings)").all().map(c => c.name);
          for (const c of setCols) {
            if (c.includes(legacyKey)) runSafe(`ALTER TABLE company_settings DROP COLUMN ${c}`);
          }
          const pTable = String.fromCharCode(112, 97, 114, 116, 110, 101, 114, 115);
          runSafe(`DROP TABLE IF EXISTS ${pTable}`);
        } catch (e) {}

        // Add printer and barcode settings columns
        runSafe("ALTER TABLE company_settings ADD COLUMN printer_receipt TEXT DEFAULT ''");
        runSafe("ALTER TABLE company_settings ADD COLUMN printer_barcode TEXT DEFAULT ''");
        runSafe("ALTER TABLE company_settings ADD COLUMN printer_reports TEXT DEFAULT ''");
        runSafe("ALTER TABLE company_settings ADD COLUMN barcode_width REAL DEFAULT 38");
        runSafe("ALTER TABLE company_settings ADD COLUMN barcode_height REAL DEFAULT 25");
        runSafe("ALTER TABLE company_settings ADD COLUMN barcode_show_price INTEGER DEFAULT 1");
        runSafe("ALTER TABLE company_settings ADD COLUMN barcode_show_name INTEGER DEFAULT 1");
        runSafe("ALTER TABLE company_settings ADD COLUMN barcode_show_studio INTEGER DEFAULT 1");
        // High Performance Indexes
        runSafe("CREATE INDEX IF NOT EXISTS idx_invoices_date ON invoices(invoice_date)");
        runSafe("CREATE INDEX IF NOT EXISTS idx_invoices_status ON invoices(status)");
        runSafe("CREATE INDEX IF NOT EXISTS idx_invoices_number ON invoices(invoice_number)");
        runSafe("CREATE INDEX IF NOT EXISTS idx_returns_orig_inv ON returns(original_invoice_id)");
        runSafe("CREATE INDEX IF NOT EXISTS idx_customers_name ON customers(name)");
        runSafe("CREATE INDEX IF NOT EXISTS idx_customers_phone ON customers(phone)");
        // Rebrand company_name and WhatsApp defaults if legacy
        runSafe("UPDATE company_settings SET company_name = 'استوديو التصوير' WHERE company_name NOT LIKE '%استوديو%'");
        runSafe("UPDATE whatsapp_settings SET webhook_verify_token = 'photostudio_wa_token' WHERE webhook_verify_token NOT LIKE '%photostudio%'");
      }
    },
    {
      version: 21,
      run() {
        // Inventory (Stock) module tables and columns
        runSafe("ALTER TABLE services ADD COLUMN track_inventory INTEGER DEFAULT 0");
        runSafe("ALTER TABLE services ADD COLUMN quantity REAL DEFAULT 0");
        runSafe("ALTER TABLE services ADD COLUMN low_stock_threshold REAL DEFAULT 0");
        runSafe("CREATE INDEX IF NOT EXISTS idx_services_track_inventory ON services(track_inventory)");

        runSafe(`
          CREATE TABLE IF NOT EXISTS inventory_movements (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            service_id INTEGER REFERENCES services(id),
            movement_type TEXT NOT NULL,
            quantity_change REAL NOT NULL,
            quantity_after REAL NOT NULL,
            reference_type TEXT,
            reference_id INTEGER,
            notes TEXT,
            employee_id INTEGER REFERENCES employees(id),
            created_at TEXT DEFAULT (datetime('now'))
          )
        `);
        runSafe("CREATE INDEX IF NOT EXISTS idx_inventory_movements_service ON inventory_movements(service_id)");

        runSafe(`
          CREATE TABLE IF NOT EXISTS stocktake_sessions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            started_at TEXT DEFAULT (datetime('now')),
            completed_at TEXT,
            status TEXT DEFAULT 'مفتوح',
            employee_id INTEGER REFERENCES employees(id),
            notes TEXT
          )
        `);

        runSafe(`
          CREATE TABLE IF NOT EXISTS stocktake_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            stocktake_id INTEGER REFERENCES stocktake_sessions(id) ON DELETE CASCADE,
            service_id INTEGER REFERENCES services(id),
            system_quantity REAL NOT NULL,
            counted_quantity REAL,
            variance REAL
          )
        `);
        runSafe("CREATE INDEX IF NOT EXISTS idx_stocktake_items_session ON stocktake_items(stocktake_id)");
      }
    },
    {
      version: 22,
      run() {
        // تنظيف أي بيانات تجريبية سابقة تخص الترزي (طالما غير مرتبطة بفواتير بيع فعلية)
        runSafe(`
          DELETE FROM services 
          WHERE (name LIKE '%بنطلون%' OR name LIKE '%قميص%' OR name LIKE '%ترزي%' OR name LIKE '%خياطة%') 
            AND id NOT IN (SELECT DISTINCT service_id FROM invoice_items WHERE service_id IS NOT NULL)
        `);
        runSafe(`
          DELETE FROM service_categories 
          WHERE (name LIKE '%ترزي%' OR name LIKE '%خياطة%' OR name LIKE '%تفصيل%') 
            AND id NOT IN (SELECT DISTINCT category_id FROM services WHERE category_id IS NOT NULL)
        `);

        // إذا كانت الأقسام فارغة، إضافة أقسام استوديو التصوير الافتراضية
        try {
          const catCount = db.prepare('SELECT COUNT(*) as cnt FROM service_categories').get();
          if (catCount && catCount.cnt === 0) {
            const insCat = db.prepare('INSERT INTO service_categories (name) VALUES (?)');
            insCat.run('جلسات تصوير (Sessions)');
            insCat.run('طباعة وتكبير صور');
            insCat.run('ألبومات وبراويز');
            insCat.run('خدمات استوديو وتعديل');
          }
        } catch (_) {}
      }
    },
    {
      version: 23,
      run() {
        runSafe("ALTER TABLE company_settings ADD COLUMN stock_out_behavior TEXT DEFAULT 'warn'");
      }
    }
  ];

  for (const m of migrations) {
    if (m.version > currentVersion) {
      console.log(`[DB] Running migration v${m.version}...`);
      m.run();
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(m.version);
    }
  }
}

function initSchema() {
  const schemaPath = path.join(__dirname, 'schema.sql');
  const schema = fs.readFileSync(schemaPath, 'utf8');
  db.exec(schema);
}

function runSeed() {
  const { seedData } = require('./seed');
  seedData(db);
}

// ─── Role checking helper ─────────────────────────────────────────────────────
function requireAdmin() {
  if (currentSession.role !== 'admin') {
    throw new Error('ACCESS_DENIED: هذه العملية متاحة للمدير فقط');
  }
}

// ─── Audit log helper ─────────────────────────────────────────────────────────
function logAudit(action, tableName, recordId, oldValue, newValue) {
  try {
    db.prepare(`
      INSERT INTO audit_log (user_id, action, table_name, record_id, old_value, new_value)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(currentSession.userId, action, tableName, recordId,
      oldValue ? JSON.stringify(oldValue) : null,
      newValue ? JSON.stringify(newValue) : null
    );
  } catch (e) {
    console.error('Audit log error:', e.message);
  }
}

// ─── Generic query helpers ────────────────────────────────────────────────────
function query(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    return { success: true, data: stmt.all(...params) };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function queryOne(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    return { success: true, data: stmt.get(...params) };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function run(sql, params = []) {
  try {
    const stmt = db.prepare(sql);
    const info = stmt.run(...params);
    return { success: true, lastInsertRowid: info.lastInsertRowid, changes: info.changes };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── Invoice Number Generator ─────────────────────────────────────────────────
function generateInvoiceNumber() {
  const year = new Date().getFullYear();
  let row = db.prepare('SELECT * FROM invoice_sequence WHERE id = 1').get();

  if (!row) {
    db.prepare('INSERT INTO invoice_sequence (id, last_number, year) VALUES (1, 0, ?)').run(year);
    row = { last_number: 0, year: year };
  }

  let nextNum = row.year === year ? row.last_number : 0;
  let candidateStr = '';
  
  const checkStmt = db.prepare('SELECT id FROM invoices WHERE invoice_number = ?');
  
  while (true) {
    nextNum++;
    candidateStr = `INV-${year}-${String(nextNum).padStart(4, '0')}`;
    const exists = checkStmt.get(candidateStr);
    if (!exists) {
      break;
    }
  }

  db.prepare('UPDATE invoice_sequence SET last_number = ?, year = ? WHERE id = 1').run(nextNum, year);
  return candidateStr;
}

function previewInvoiceNumber() {
  const year = new Date().getFullYear();
  let row = db.prepare('SELECT * FROM invoice_sequence WHERE id = 1').get();
  
  let nextNum = (row && row.year === year) ? row.last_number : 0;
  let candidateStr = '';
  
  const checkStmt = db.prepare('SELECT id FROM invoices WHERE invoice_number = ?');
  
  while (true) {
    nextNum++;
    candidateStr = `INV-${year}-${String(nextNum).padStart(4, '0')}`;
    const exists = checkStmt.get(candidateStr);
    if (!exists) {
      return candidateStr;
    }
  }
}

// ─── Local Time Helper ───────────────────────────────────────────────────────
function getLocalISOString(d = new Date()) {
  const offset = d.getTimezoneOffset() * 60000;
  const localD = new Date(d.getTime() - offset);
  return localD.toISOString().replace('T', ' ').substring(0, 19);
}

// ─── Business Date (يراعي قلب اليوم / day_cutoff_hour) ─────────────────────
// لو الساعة الحالية أقل من ساعة القلب، نرجع تاريخ أمس (نفس اليوم التجاري السابق)
function getBusinessDate(d = new Date()) {
  const offset = d.getTimezoneOffset() * 60000;
  const localD = new Date(d.getTime() - offset);
  try {
    const settings = db.prepare('SELECT day_cutoff_hour FROM company_settings WHERE id = 1').get();
    const cutoffHour = (settings && settings.day_cutoff_hour) ? parseInt(settings.day_cutoff_hour, 10) : 0;
    if (cutoffHour > 0 && localD.getUTCHours() < cutoffHour) {
      // بعد منتصف الليل وقبل ساعة القلب → نحسبها على اليوم السابق
      localD.setUTCDate(localD.getUTCDate() - 1);
    }
  } catch (e) {
    // لو فشل الاستعلام، نرجع التاريخ الطبيعي بدون تعديل
  }
  return localD.toISOString().split('T')[0];
}

// ─── Treasury helpers ─────────────────────────────────────────────────────────
function getTreasuryBalance(treasuryType = 'الخزينة') {
  const row = db.prepare(
    `SELECT balance_after FROM treasury WHERE treasury_type = ? ORDER BY id DESC LIMIT 1`
  ).get(treasuryType);
  return row ? row.balance_after : 0;
}

function addTreasuryEntry(type, description, amount, treasuryType = 'الخزينة', shiftId = null) {
  const currentBalance = getTreasuryBalance(treasuryType);
  const newBalance = type === 'إيراد' ? currentBalance + amount : currentBalance - amount;
  
  const d = new Date();
  const offset = d.getTimezoneOffset() * 60000;
  const localD = new Date(d.getTime() - offset);
  const localDate = getBusinessDate(d);     // ← يراعي قلب اليوم
  const localTime = localD.toISOString().split('T')[1].substring(0, 8);

  const activeShiftId = shiftId || currentSession.shiftId || null;

  db.prepare(
    `INSERT INTO treasury (type, description, amount, balance_after, treasury_type, date, time, shift_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(type, description, amount, newBalance, treasuryType, localDate, localTime, activeShiftId);
  
  return newBalance;
}

// ─── Auth helpers ─────────────────────────────────────────────────────────────
function authenticateUser(username, password) {
  const user = db.prepare(`
    SELECT u.*, e.name as employee_name
    FROM users u
    LEFT JOIN employees e ON u.employee_id = e.id
    WHERE u.username = ? AND u.is_active = 1
  `).get(username);

  if (!user) {
    return { success: false, error: 'اسم المستخدم غير موجود' };
  }

  const valid = bcrypt.compareSync(password, user.password_hash);
  if (!valid) {
    return { success: false, error: 'كلمة المرور غير صحيحة' };
  }

  // Update last_login
  db.prepare('UPDATE users SET last_login = datetime(\'now\') WHERE id = ?').run(user.id);

  // Create login session
  const session = db.prepare(`
    INSERT INTO login_sessions (user_id, login_time) VALUES (?, datetime('now'))
  `).run(user.id);

  // Update current session state
  currentSession = {
    userId: user.id,
    employeeId: user.employee_id,
    username: user.username,
    role: user.role,
    shiftId: null,
    loginSessionId: session.lastInsertRowid
  };

  // Check for open shift
  const openShift = db.prepare(`SELECT id FROM shifts WHERE user_id = ? AND status = 'مفتوح' ORDER BY id DESC LIMIT 1`).get(user.id);
  if (openShift) {
    currentSession.shiftId = openShift.id;
  }

  return {
    success: true,
    data: {
      userId: user.id,
      employeeId: user.employee_id,
      employeeName: user.employee_name || user.username,
      username: user.username,
      role: user.role,
      shiftId: currentSession.shiftId
    }
  };
}

function logoutUser() {
  if (currentSession.loginSessionId) {
    db.prepare(`UPDATE login_sessions SET logout_time = datetime('now') WHERE id = ?`)
      .run(currentSession.loginSessionId);
  }
  const prev = { ...currentSession };
  currentSession = { userId: null, employeeId: null, username: null, role: null, shiftId: null, loginSessionId: null };
  return { success: true, data: prev };
}

// ─── Shift helpers ────────────────────────────────────────────────────────────
function startShift(openingCash) {
  if (!currentSession.userId) {
    return { success: false, error: 'يجب تسجيل الدخول أولاً' };
  }

  // Check for existing open shift
  const existing = db.prepare(`SELECT id FROM shifts WHERE user_id = ? AND status = 'مفتوح'`).get(currentSession.userId);
  if (existing) {
    currentSession.shiftId = existing.id;
    return { success: true, data: { shiftId: existing.id, alreadyOpen: true } };
  }

  const startTime = getLocalISOString();

  const result = db.prepare(`
    INSERT INTO shifts (employee_id, user_id, opening_cash, status, start_time)
    VALUES (?, ?, ?, 'مفتوح', ?)
  `).run(currentSession.employeeId, currentSession.userId, openingCash || 0, startTime);

  currentSession.shiftId = result.lastInsertRowid;
  return { success: true, data: { shiftId: result.lastInsertRowid, alreadyOpen: false } };
}

function getShiftSummary(shiftId) {
  const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId);
  if (!shift) return { success: false, error: 'الشيفت غير موجود' };

  const shiftStartTimeStr = shift.start_time ? shift.start_time.substring(0, 19) : '';
  const shiftEndTimeStr = shift.end_time ? shift.end_time.substring(0, 19) : '';

  // Invoice count during this shift
  const invCount = db.prepare(`
    SELECT COUNT(*) as cnt FROM invoices WHERE shift_id = ? OR (
      created_at >= ? AND (? = '' OR created_at <= ?)
    )
  `).get(shiftId, shiftStartTimeStr, shiftEndTimeStr, shiftEndTimeStr);

  // Fetch detailed treasury movements for this shift
  let treasuryDetails = [];
  try {
    if (shiftEndTimeStr) {
      treasuryDetails = db.prepare(`
        SELECT type, description, amount, treasury_type, time, date, shift_id
        FROM treasury
        WHERE shift_id = ? OR (
          (date || ' ' || time) >= ? AND (date || ' ' || time) <= ?
        )
        ORDER BY date ASC, time ASC, id ASC
      `).all(shiftId, shiftStartTimeStr, shiftEndTimeStr);
    } else if (shiftStartTimeStr) {
      treasuryDetails = db.prepare(`
        SELECT type, description, amount, treasury_type, time, date, shift_id
        FROM treasury
        WHERE shift_id = ? OR (
          (date || ' ' || time) >= ?
        )
        ORDER BY date ASC, time ASC, id ASC
      `).all(shiftId, shiftStartTimeStr);
    } else {
      treasuryDetails = db.prepare(`
        SELECT type, description, amount, treasury_type, time, date, shift_id
        FROM treasury
        WHERE shift_id = ?
        ORDER BY date ASC, time ASC, id ASC
      `).all(shiftId);
    }
  } catch (err) {
    console.error('Error fetching treasuryDetails:', err);
  }

  // حساب كروت ملخص الشيفت بناءً على حركات الخزينة الفعلية (الداخل والخارج)
  // لضمان تطابق المعادلة المعروضة: المتوقع = العهدة + مبيعات نقدي - مرتجعات - مصروفات - سلف
  let totalSalesCash = 0;
  let totalSalesVodafone = 0;
  let totalReturns = 0;   // مرتجعات نقدي
  let totalExpenses = 0;  // مصروفات نقدي
  let totalAdvances = 0;  // سلف ورواتب نقدي

  let expectedVodafone = 0;
  let totalReturnsVodafone = 0;
  let totalExpensesVodafone = 0;
  let totalAdvancesVodafone = 0;

  let expectedInstapay = 0;
  let totalSalesInstapay = 0;

  for (const t of treasuryDetails) {
    const isRevenue = t.type === 'إيراد';
    const desc = t.description || '';
    const isReturn = desc.includes('مرتجع') || desc.includes('إرجاع');
    const isAdvanceOrSalary = desc.includes('سلفة') || desc.includes('راتب');

    if (t.treasury_type === 'الخزينة') {
      if (isRevenue) {
        totalSalesCash += t.amount;
      } else {
        if (isReturn) {
          totalReturns += t.amount;
        } else if (isAdvanceOrSalary) {
          totalAdvances += t.amount;
        } else {
          totalExpenses += t.amount;
        }
      }
    } else if (t.treasury_type === 'فودافون كاش') {
      if (isRevenue) {
        totalSalesVodafone += t.amount;
      } else {
        if (isReturn) {
          totalReturnsVodafone += t.amount;
        } else if (isAdvanceOrSalary) {
          totalAdvancesVodafone += t.amount;
        } else {
          totalExpensesVodafone += t.amount;
        }
      }
    } else if (t.treasury_type === 'إنستا باي') {
      if (isRevenue) {
        totalSalesInstapay += t.amount;
      }
    }
  }

  const expectedCash = (shift.opening_cash || 0) + totalSalesCash - totalReturns - totalExpenses - totalAdvances;
  expectedVodafone = totalSalesVodafone - totalReturnsVodafone - totalExpensesVodafone - totalAdvancesVodafone;
  expectedInstapay = totalSalesInstapay;

  return {
    success: true,
    data: {
      shift,
      totalSalesCash,
      totalSalesVodafone,
      totalSales: totalSalesCash + totalSalesVodafone + totalSalesInstapay,
      totalReturns,
      totalExpenses,
      totalAdvances,
      expectedCash,
      expectedVodafone,
      expectedInstapay,
      invoiceCount: invCount.cnt || 0,
      treasuryDetails
    }
  };
}

function endShift(shiftId, actualCash, actualVodafone, actualInstapay, notes) {
  const summary = getShiftSummary(shiftId);
  if (!summary.success) return summary;

  const { expectedCash, expectedVodafone, expectedInstapay, totalSalesCash, totalSalesVodafone, totalSales, totalReturns, totalExpenses, invoiceCount } = summary.data;

  const cashDifference = (actualCash || 0) - expectedCash;
  const vodafoneDiff = (actualVodafone || 0) - expectedVodafone;
  const instapayDiff = (actualInstapay || 0) - (expectedInstapay || 0);
  const endTime = getLocalISOString();

  db.prepare(`
    UPDATE shifts SET
      end_time = ?,
      expected_cash = ?,
      actual_cash_counted = ?,
      cash_difference = ?,
      vodafone_cash_expected = ?,
      vodafone_cash_actual = ?,
      instapay_cash_expected = ?,
      instapay_cash_actual = ?,
      total_sales = ?,
      total_returns = ?,
      total_expenses = ?,
      invoice_count = ?,
      status = 'مغلق',
      notes = ?,
      closed_by_user_id = ?
    WHERE id = ?
  `).run(
    endTime,
    expectedCash, actualCash, cashDifference,
    expectedVodafone, actualVodafone || 0,
    expectedInstapay || 0, actualInstapay || 0,
    totalSales, totalReturns, totalExpenses,
    invoiceCount, notes || null,
    currentSession.userId, shiftId
  );

  currentSession.shiftId = null;
  return { success: true, data: { cashDifference, vodafoneDifference: vodafoneDiff, instapayDifference: instapayDiff } };
}

// ─── Selective Reset ──────────────────────────────────────────────────────────
// options: { keepCustomers, keepServices, keepEmployees, keepSettings }
function selectiveReset(options = {}) {
  try {
    requireAdmin();
    const { keepCustomers = false, keepServices = false, keepEmployees = false, keepSettings = false } = options;
    const errors = [];

    // ── تعطيل FK constraints أولاً لتجنب مشاكل الترابط بين الجداول ──────────
    db.pragma('foreign_keys = OFF');

    try {
      const resetTx = db.transaction(() => {
        const alwaysDelete = [
          'audit_log', 'login_sessions',
          'return_items', 'returns',
          'invoice_items', 'invoices',
          'attendance', 'leaves', 'advances', 'deductions',
          'incentives', 'custody', 'salary_payments',
          'expenses', 'revenues', 'treasury',
          'purchase_items', 'purchases',
          'shifts', 'suppliers', 'backups'
        ];

        for (const tbl of alwaysDelete) {
          try {
            db.prepare(`DELETE FROM ${tbl}`).run();
          } catch (e) {
            errors.push(`فشل مسح جدول ${tbl}: ${e.message}`);
          }
        }

        // إعادة تسلسل الفواتير
        try {
          db.prepare('DELETE FROM invoice_sequence').run();
          db.prepare("INSERT OR REPLACE INTO invoice_sequence (id, last_number, year) VALUES (1, 0, strftime('%Y', 'now'))").run();
        } catch (e) {
          errors.push(`فشل إعادة تسلسل الفواتير: ${e.message}`);
        }

        // ─── مسح العملاء ──────────────────────────────────────────────────────
        if (!keepCustomers) {
          try { db.prepare('DELETE FROM customers').run(); }
          catch (e) { errors.push(`فشل مسح العملاء: ${e.message}`); }
        }

        // ─── مسح الأصناف والخدمات ─────────────────────────────────────────────
        if (!keepServices) {
          try { db.prepare('DELETE FROM services').run(); }
          catch (e) { errors.push(`فشل مسح الخدمات: ${e.message}`); }
          try { db.prepare('DELETE FROM service_categories').run(); }
          catch (e) { errors.push(`فشل مسح الفئات: ${e.message}`); }
        }

        // ─── مسح الموظفين والمستخدمين ─────────────────────────────────────────
        if (!keepEmployees) {
          const currentUserId = currentSession.userId;
          try {
            if (currentUserId) {
              db.prepare('DELETE FROM users WHERE id != ?').run(currentUserId);
            } else {
              const adminUser = db.prepare("SELECT id FROM users WHERE role='admin' ORDER BY id LIMIT 1").get();
              if (adminUser) {
                db.prepare('DELETE FROM users WHERE id != ?').run(adminUser.id);
              }
            }
          } catch (e) { errors.push(`فشل مسح المستخدمين: ${e.message}`); }

          try {
            const adminEmpId = currentSession.employeeId;
            if (adminEmpId) {
              db.prepare('DELETE FROM employees WHERE id != ?').run(adminEmpId);
            } else {
              db.prepare('DELETE FROM employees').run();
            }
          } catch (e) { errors.push(`فشل مسح الموظفين: ${e.message}`); }
        }

        // ─── إعادة الإعدادات ──────────────────────────────────────────────────
        if (!keepSettings) {
          try {
            db.prepare(`UPDATE company_settings SET
              company_name='استوديو التصوير', address='', phone='', logo_path=NULL,
              tax_number='', receipt_footer='شكراً لزيارتكم', receipt_notes='',
              show_customer_phone=1, currency='جنيه',
              prevent_cashier_price_edit=0,
              cashier_hide_reports=0, cashier_hide_hr=0, cashier_prevent_returns=0,
              cashier_hide_finance=0, cashier_prevent_discount=0, cashier_prevent_settings=0,
              wa_phone1='', wa_phone2='',
              wa_tpl_invoice_confirm='', wa_tpl_order_ready='', wa_tpl_delivered='',
              wa_tpl_full_payment='', wa_tpl_partial_payment=''
              WHERE id=1`).run();
          } catch (e) { errors.push(`فشل إعادة الإعدادات: ${e.message}`); }
          try { db.prepare('DELETE FROM whatsapp_settings').run(); } catch (e) {}
          try { db.prepare('DELETE FROM whatsapp_template_map').run(); } catch (e) {}
        }
      });

      resetTx();
    } finally {
      // ── إعادة تفعيل FK constraints دائماً حتى لو حدث خطأ ─────────────────
      db.pragma('foreign_keys = ON');
    }

    if (errors.length > 0) {
      return { success: false, error: 'أخطاء أثناء المسح:\n' + errors.join('\n') };
    }
    return { success: true };

  } catch (err) {
    try { db.pragma('foreign_keys = ON'); } catch(e) {}
    return { success: false, error: err.message };
  }
}

// ─── Backup helpers ───────────────────────────────────────────────────────────
async function createBackup(backupType = 'يدوي', customDir = null) {
  const bType = typeof backupType === 'string' ? backupType : 'يدوي';
  const dbPath = getDbPath();
  if (!dbPath) return { success: false, error: 'لم يتم العثور على مسار قاعدة البيانات' };

  const now = new Date();
  const dateStr = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const fileName = `backup_${dateStr}.db`;

  let backupDir;
  if (customDir) {
    backupDir = customDir;
  } else {
    backupDir = path.join(path.dirname(dbPath), 'backups');
  }

  if (!fs.existsSync(backupDir)) {
    fs.mkdirSync(backupDir, { recursive: true });
  }

  const destPath = path.join(backupDir, fileName);

  try {
    // Use better-sqlite3's backup API synchronously / awaited
    await db.backup(destPath);
    const stats = fs.statSync(destPath);
    const sizeKb = (stats.size / 1024).toFixed(2);

    db.prepare(`
      INSERT INTO backups (file_name, file_path, file_size_kb, backup_type)
      VALUES (?, ?, ?, ?)
    `).run(fileName, destPath, sizeKb, bType);

    copyBackupToExternal(destPath);

    return { success: true, data: { fileName, filePath: destPath } };
  } catch (err) {
    // Fallback: copy file directly
    try {
      fs.copyFileSync(dbPath, destPath);
      const stats = fs.statSync(destPath);
      const sizeKb = (stats.size / 1024).toFixed(2);

      db.prepare(`
        INSERT INTO backups (file_name, file_path, file_size_kb, backup_type)
        VALUES (?, ?, ?, ?)
      `).run(fileName, destPath, sizeKb, bType);

      copyBackupToExternal(destPath);

      return { success: true, data: { fileName, filePath: destPath } };
    } catch (copyErr) {
      return { success: false, error: copyErr.message };
    }
  }
}

// ─── Copy latest backup to external path ────────────────────────────────────
function copyBackupToExternal(srcFilePath) {
  try {
    const extDir = getExternalBackupPath();
    if (!extDir) return; // No external path configured
    if (!fs.existsSync(extDir)) {
      fs.mkdirSync(extDir, { recursive: true });
    }
    const destFile = path.join(extDir, path.basename(srcFilePath));
    fs.copyFileSync(srcFilePath, destFile);
    console.log('[Backup] Copied to external path:', destFile);
  } catch (err) {
    console.error('[Backup] Failed to copy to external path:', err.message);
  }
}

function listBackups() {
  try {
    const rows = db.prepare('SELECT * FROM backups ORDER BY created_at DESC').all();
    // Verify files still exist
    return {
      success: true,
      data: rows.map(r => ({
        ...r,
        exists: fs.existsSync(r.file_path)
      }))
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── Daily Report ───────────────────────────────────────────────────────────────
function getDailyReport(date) {
  try {
    const dateLike = date + '%';

    // ── 1. Invoices created today ───────────────────────────────────────────────
    const invoices = db.prepare(`
      SELECT i.*, c.name as customer_name, e.name as employee_name,
             COALESCE(i.amount_paid,0) as paid,
             COALESCE(i.remaining,0) as remaining_amount
      FROM invoices i 
      LEFT JOIN customers c ON i.customer_id = c.id
      LEFT JOIN employees e ON i.employee_id = e.id
      WHERE i.invoice_date LIKE ?
    `).all(dateLike);

    // ── 2. Today's treasury movements on OLD invoices (تسديد/استلام اليوم لفواتير قديمة) ──
    // كل حركة خزينة اليوم نوعها "إيراد" ومرتبطة بفاتورة من تاريخ مختلف
    const todayTreasury = db.prepare(`SELECT * FROM treasury WHERE date LIKE ? AND type='إيراد' ORDER BY time ASC`).all(dateLike);
    
    // رابط الوصف بالفاتورة: نبحث عن فواتير مذكورة في الـ treasury اليوم لكنها ليست من اليوم
    const todayInvoiceNumbers = new Set(invoices.map(i => i.invoice_number));
    const todayPaymentsOnOldInvoices = [];
    
    for (const tr of todayTreasury) {
      // استخراج رقم الفاتورة من الوصف
      if (!tr.description) continue;
      const m = tr.description.match(/(?:فاتورة|invoice)\s*([\w-]+)/i);
      if (!m) continue;
      const invNum = m[1];
      // لو الفاتورة مش من تقرير اليوم — يعني فاتورة قديمة
      if (!todayInvoiceNumbers.has(invNum)) {
        // نجيب بيانات الفاتورة نفسها
        const oldInv = db.prepare(`
          SELECT i.*, c.name as customer_name, c.phone as customer_phone
          FROM invoices i LEFT JOIN customers c ON i.customer_id = c.id
          WHERE i.invoice_number = ?
        `).get(invNum);
        todayPaymentsOnOldInvoices.push({
          treasury_row: tr,
          invoice: oldInv || null,
          invoice_number: invNum
        });
      }
    }

    const expenses = db.prepare(`SELECT * FROM expenses WHERE date LIKE ?`).all(dateLike);

    const advances = db.prepare(`
      SELECT a.*, e.name as emp_name 
      FROM advances a 
      LEFT JOIN employees e ON a.employee_id = e.id 
      WHERE a.date LIKE ?
    `).all(dateLike);

    const attendance = db.prepare(`
      SELECT a.*, e.name as emp_name, e.salary_type 
      FROM attendance a 
      LEFT JOIN employees e ON a.employee_id = e.id 
      WHERE a.date LIKE ?
    `).all(dateLike);

    const returns = db.prepare(`
      SELECT r.*, i.invoice_number, c.name as customer_name
      FROM returns r
      LEFT JOIN invoices i ON r.original_invoice_id = i.id
      LEFT JOIN customers c ON i.customer_id = c.id
      WHERE r.return_date LIKE ?
    `).all(dateLike);

    const treasury = db.prepare(`SELECT * FROM treasury WHERE date LIKE ? ORDER BY time ASC`).all(dateLike);

    const salaries = db.prepare(`
      SELECT s.*, e.name as emp_name
      FROM salary_payments s
      LEFT JOIN employees e ON s.employee_id = e.id
      WHERE s.paid_date LIKE ?
    `).all(dateLike);

    const revenues = (() => {
      try { return db.prepare(`SELECT * FROM revenues WHERE date LIKE ?`).all(dateLike); }
      catch(e) { return []; }
    })();

    // Summary totals
    // دفعات اليوم على فواتير قديمة تُحتسب ضمن الإيرادات
    const todayOldPaymentsTotal = todayPaymentsOnOldInvoices.reduce((s, p) => s + (p.treasury_row.amount || 0), 0);
    const invoicesPaid   = invoices.reduce((s, i) => s + (i.paid || 0), 0);
    const revenuesTotal  = revenues.reduce ? revenues.reduce((s, r) => s + (r.amount || 0), 0) : 0;
    const expensesTotal  = expenses.reduce((s, e) => s + (e.amount || 0), 0);
    const returnsTotal   = returns.reduce((s, r) => s + (r.total_returned || 0), 0);
    const advancesTotal  = advances.reduce((s, a) => s + (a.amount || 0), 0);
    const salariesTotal  = salaries.reduce((s, s2) => s + (s2.net_salary || 0), 0);

    const summary = {
      invoices_paid: invoicesPaid + todayOldPaymentsTotal,
      revenues: revenuesTotal,
      expenses: expensesTotal,
      returns: returnsTotal,
      advances: advancesTotal,
      salaries: salariesTotal
    };

    // Treasury daily net — بدون "البنك"
    const allTypes = ['الخزينة', 'فودافون كاش', 'إنستا باي'];
    const treasuryBalances = allTypes.map(t => {
      const row = db.prepare(
        `SELECT COALESCE(SUM(CASE WHEN type='إيراد' THEN amount ELSE -amount END),0) as net FROM treasury WHERE date LIKE ? AND treasury_type = ?`
      ).get(dateLike, t);
      return { treasury_type: t, balance: row ? row.net : 0 };
    });

    return {
      success: true,
      data: { summary, treasuryBalances, invoices, expenses, advances, attendance, returns, treasury, salaries, revenues, todayPaymentsOnOldInvoices }
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ─── IPC Handler Map ──────────────────────────────────────────────────────────
function setupIpcHandlers(ipcMain, app) {
  getDb(app);

  // ─── Auth ─────────────────────────────────────────────────────────────────
  ipcMain.handle('auth:login', (_, username, password) => {
    try {
      return authenticateUser(username, password);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('auth:logout', () => {
    try {
      return logoutUser();
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('auth:getSession', () => {
    if (!currentSession.userId) {
      return { success: false, error: 'غير مسجل دخول' };
    }
    // Fetch employee name
    let employeeName = currentSession.username;
    if (currentSession.employeeId) {
      const emp = db.prepare('SELECT name FROM employees WHERE id = ?').get(currentSession.employeeId);
      if (emp) employeeName = emp.name;
    }
    return {
      success: true,
      data: {
        ...currentSession,
        employeeName
      }
    };
  });

  // ─── Shift ────────────────────────────────────────────────────────────────
  ipcMain.handle('shift:start', (_, openingCash) => {
    try {
      return startShift(openingCash);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('shift:end', (_, shiftId, actualCash, actualVodafone, actualInstapay, notes) => {
    try {
      return endShift(shiftId, actualCash, actualVodafone, actualInstapay, notes);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('shift:getSummary', (_, shiftId) => {
    try {
      return getShiftSummary(shiftId);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('shift:getCurrent', () => {
    if (!currentSession.shiftId) {
      return { success: false, error: 'لا يوجد شيفت مفتوح' };
    }
    return getShiftSummary(currentSession.shiftId);
  });

  // ─── Generic query ────────────────────────────────────────────────────────
  ipcMain.handle('db:query', (_, sql, params) => query(sql, params || []));
  ipcMain.handle('db:queryOne', (_, sql, params) => queryOne(sql, params || []));
  ipcMain.handle('db:run', (_, sql, params) => {
    const sqlLower = (sql || '').toLowerCase().trim();

    // ─── Cashier restrictions ──────────────────────────────────────────────
    if (currentSession.role === 'cashier') {
      // Block destructive operations
      if (sqlLower.startsWith('delete') || sqlLower.startsWith('drop') || sqlLower.startsWith('alter')) {
        return { success: false, error: 'ACCESS_DENIED: هذه العملية متاحة للمدير فقط' };
      }
      // Block price edits
      if (sqlLower.includes('update services') && sqlLower.includes('sell_price')) {
        return { success: false, error: 'ACCESS_DENIED: لا يمكنك تعديل الأسعار' };
      }
      // Block salary/settings/user table modifications
      const protectedTables = ['salary_payments', 'company_settings', 'users', 'audit_log'];
      for (const t of protectedTables) {
        if ((sqlLower.startsWith('insert') || sqlLower.startsWith('update')) && sqlLower.includes(t)) {
          return { success: false, error: 'ACCESS_DENIED: هذه العملية متاحة للمدير فقط' };
        }
      }
    }

    // ─── Audit logging for write operations ────────────────────────────────
    if (sqlLower.startsWith('insert') || sqlLower.startsWith('update') || sqlLower.startsWith('delete')) {
      try {
        logAudit('db:run', 'raw_sql', null, null, { sql: sql.substring(0, 200) });
      } catch (e) { /* ignore audit errors */ }
    }

    return run(sql, params || []);
  });

  // ─── Invoice number ───────────────────────────────────────────────────────
  ipcMain.handle('db:previewInvoiceNumber', () => {
    try {
      return { success: true, data: previewInvoiceNumber() };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ─── Treasury ─────────────────────────────────────────────────────────────
  ipcMain.handle('db:getTreasuryBalance', (_, treasuryType) => {
    try {
      return { success: true, data: getTreasuryBalance(treasuryType) };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('db:addTreasuryEntry', (_, type, description, amount, treasuryType) => {
    try {
      const balance = addTreasuryEntry(type, description, amount, treasuryType);
      return { success: true, data: balance };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ─── Factory Reset ────────────────────────────────────────────────────────
  ipcMain.handle('app:factoryReset', () => {
    try {
      requireAdmin();
      const dbPath = getDbPath();
      db.close();
      
      if (fs.existsSync(dbPath)) fs.unlinkSync(dbPath);
      if (fs.existsSync(dbPath + '-wal')) fs.unlinkSync(dbPath + '-wal');
      if (fs.existsSync(dbPath + '-shm')) fs.unlinkSync(dbPath + '-shm');
      
      app.relaunch();
      app.exit(0);
      return { success: true };
    } catch (err) {
      console.error(err);
      return { success: false, error: err.message };
    }
  });

  // ─── Save full invoice (transaction) ──────────────────────────────────────
  ipcMain.handle('db:saveInvoice', (_, invoiceData, items) => {
    try {
      const saveInvoiceTx = db.transaction(() => {
        let invNum;
        if (invoiceData.invoiceNumber) {
          // Check if this number already exists in DB
          const existing = db.prepare('SELECT id FROM invoices WHERE invoice_number = ?').get(invoiceData.invoiceNumber);
          if (existing) {
            // Already used → generate fresh number
            invNum = generateInvoiceNumber();
          } else {
            // Not used → use it as-is (don't increment counter again)
            invNum = invoiceData.invoiceNumber;
          }
        } else {
          invNum = generateInvoiceNumber();
        }
        const invStmt = db.prepare(`
          INSERT INTO invoices (invoice_number, customer_id, employee_id, invoice_date,
            payment_method, invoice_type, treasury_type, subtotal, discount_percent,
            discount_amount, net_total, amount_paid, remaining, notes, shift_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const invInfo = invStmt.run(
          invNum,
          invoiceData.customer_id || null,
          invoiceData.employee_id || null,
          invoiceData.invoice_date || getBusinessDate(),
          invoiceData.payment_method || 'نقدي',
          invoiceData.invoice_type || null,
          invoiceData.treasury_type || 'الخزينة',
          invoiceData.subtotal || 0,
          invoiceData.discount_percent || 0,
          invoiceData.discount_amount || 0,
          invoiceData.net_total || 0,
          invoiceData.amount_paid || 0,
          invoiceData.remaining || 0,
          invoiceData.notes || null,
          currentSession.shiftId || invoiceData.shift_id || null
        );
        const invoiceId = invInfo.lastInsertRowid;

        const itemStmt = db.prepare(`
          INSERT INTO invoice_items (invoice_id, service_id, category_name, service_name,
            barcode, sell_price, quantity, item_discount, total)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const item of items) {
          itemStmt.run(
            invoiceId,
            item.service_id || null,
            item.category_name || '',
            item.service_name || '',
            item.barcode || null,
            item.sell_price || 0,
            item.quantity || 1,
            item.item_discount || 0,
            item.total || 0
          );

          // Automatic stock deduction for inventory-tracked items
          if (item.service_id) {
            const srv = db.prepare('SELECT id, track_inventory, quantity FROM services WHERE id = ?').get(item.service_id);
            if (srv && srv.track_inventory === 1) {
              const soldQty = Number(item.quantity) || 1;
              const newQty = (srv.quantity || 0) - soldQty;
              db.prepare('UPDATE services SET quantity = ? WHERE id = ?').run(newQty, srv.id);
              db.prepare(`
                INSERT INTO inventory_movements (service_id, movement_type, quantity_change, quantity_after, reference_type, reference_id, notes, employee_id)
                VALUES (?, 'sale', ?, ?, 'invoice', ?, ?, ?)
              `).run(
                srv.id,
                -soldQty,
                newQty,
                invoiceId,
                `بيع في فاتورة رقم ${invNum}`,
                invoiceData.employee_id || currentSession.employeeId || null
              );
            }
          }
        }

        // Update customer balance if remaining amount exists (دين على العميل)
        if (invoiceData.customer_id && (invoiceData.remaining > 0 || invoiceData.payment_method === 'أجل')) {
          db.prepare(`UPDATE customers SET current_balance = current_balance + ? WHERE id = ?`)
            .run(invoiceData.remaining || 0, invoiceData.customer_id);
        }

        // Add treasury entry for cash payment
        if (invoiceData.amount_paid > 0) {
          addTreasuryEntry('إيراد', `فاتورة رقم ${invNum}`,
            invoiceData.amount_paid, invoiceData.treasury_type || 'الخزينة');
        }

        return { invoiceId, invoiceNumber: invNum };
      });

      const result = saveInvoiceTx();
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ─── Save return (transaction) ────────────────────────────────────────────
  ipcMain.handle('db:saveReturn', (_, returnData, returnItems) => {
    try {
      const saveReturnTx = db.transaction(() => {
        const retStmt = db.prepare(`
          INSERT INTO returns (original_invoice_id, employee_id, return_date, total_returned, notes, shift_id)
          VALUES (?, ?, ?, ?, ?, ?)
        `);
        const retInfo = retStmt.run(
          returnData.original_invoice_id,
          returnData.employee_id || currentSession.employeeId || null,
          getBusinessDate(),
          returnData.total_returned || 0,
          returnData.notes || null,
          currentSession.shiftId || null
        );
        const returnId = retInfo.lastInsertRowid;

        // Calculate return ratio from original invoice to ensure accuracy
        const invStmt = db.prepare(`SELECT id, invoice_number, customer_id, subtotal, net_total, remaining, amount_paid, treasury_type FROM invoices WHERE id = ?`);
        const invInfo = invStmt.get(returnData.original_invoice_id);
        if (!invInfo) throw new Error('Original invoice not found');

        let ratio = 1;
        if (invInfo.subtotal > 0) {
          ratio = invInfo.net_total / invInfo.subtotal;
        }

        let calculatedTotalReturned = 0;

        const itemStmt = db.prepare(`
          INSERT INTO return_items (return_id, invoice_item_id, product_name, quantity_returned,
            price_before_discount, item_discount, price_after_discount, total)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const item of returnItems) {
          // Calculate item total using ratio
          const unitPrice = item.price_before_discount - (item.item_discount || 0);
          const itemTotal = (unitPrice * item.quantity_returned) * ratio;
          calculatedTotalReturned += itemTotal;

          itemStmt.run(
            returnId,
            item.invoice_item_id || null,
            item.product_name || '',
            item.quantity_returned || 1,
            item.price_before_discount || 0,
            item.item_discount || 0,
            unitPrice,
            itemTotal
          );

          // Automatic inventory restoration for tracked items
          // Explicitly resolve service_id: via item.service_id or via invoice_items.service_id
          let serviceId = item.service_id || null;
          if (!serviceId && item.invoice_item_id) {
            const invItemRow = db.prepare('SELECT service_id FROM invoice_items WHERE id = ?').get(item.invoice_item_id);
            if (invItemRow) serviceId = invItemRow.service_id;
          }
          if (serviceId) {
            const srv = db.prepare('SELECT id, track_inventory, quantity FROM services WHERE id = ?').get(serviceId);
            if (srv && srv.track_inventory === 1) {
              const retQty = Number(item.quantity_returned) || 1;
              const newQty = (srv.quantity || 0) + retQty;
              db.prepare('UPDATE services SET quantity = ? WHERE id = ?').run(newQty, srv.id);
              db.prepare(`
                INSERT INTO inventory_movements (service_id, movement_type, quantity_change, quantity_after, reference_type, reference_id, notes, employee_id)
                VALUES (?, 'return', ?, ?, 'return', ?, ?, ?)
              `).run(
                srv.id,
                retQty,
                newQty,
                returnId,
                `مرتجع من فاتورة رقم ${invInfo.invoice_number || returnData.original_invoice_id}`,
                returnData.employee_id || currentSession.employeeId || null
              );
            }
          }
        }

        // Update total_returned in returns table
        db.prepare('UPDATE returns SET total_returned = ? WHERE id = ?').run(calculatedTotalReturned, returnId);

        // Update original invoice's remaining and is_returned flag only
        const remainingDebt = invInfo ? (invInfo.remaining || 0) : 0;
        const originalTreasury = invInfo ? (invInfo.treasury_type || 'الخزينة') : 'الخزينة';
        
        let cashRefund = calculatedTotalReturned;
        let newRemaining = remainingDebt;
        
        if (remainingDebt > 0) {
          cashRefund = Math.max(0, calculatedTotalReturned - remainingDebt);
          newRemaining = Math.max(0, remainingDebt - calculatedTotalReturned);
        }

        const debtCancelled = remainingDebt - newRemaining;
        if (invInfo.customer_id && debtCancelled > 0) {
          db.prepare('UPDATE customers SET current_balance = MAX(0, current_balance - ?) WHERE id = ?')
            .run(debtCancelled, invInfo.customer_id);
        }

        const qtyCheck = db.prepare(`
          SELECT 
            (SELECT SUM(quantity) FROM invoice_items WHERE invoice_id = ?) as total_orig,
            (SELECT SUM(ri.quantity_returned) 
             FROM return_items ri 
             JOIN returns r ON ri.return_id = r.id 
             WHERE r.original_invoice_id = ?) as total_ret
        `).get(returnData.original_invoice_id, returnData.original_invoice_id);
        
        const isFullyReturned = (qtyCheck.total_orig > 0 && qtyCheck.total_orig <= qtyCheck.total_ret) ? 1 : 0;

        db.prepare(`UPDATE invoices SET is_returned = ?, remaining = ? WHERE id = ?`)
          .run(isFullyReturned, newRemaining, returnData.original_invoice_id);

        // Refund to treasury ONLY for cash refund
        // Use user-selected treasury_type if provided, otherwise fall back to original invoice treasury
        const refundTreasury = returnData.treasury_type || originalTreasury;
        if (cashRefund > 0) {
          addTreasuryEntry('مصروف', `مرتجع نقدي لفاتورة رقم ${returnData.original_invoice_id}`,
            cashRefund, refundTreasury);
        }

        return returnId;
      });

      const result = saveReturnTx();
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ─── Pay Invoice Remaining ────────────────────────────────────────────────
  ipcMain.handle('db:payInvoiceRemaining', (_, invoiceId, amount, safeType) => {
    try {
      const payTx = db.transaction(() => {
        db.prepare(`
          UPDATE invoices
          SET amount_paid = amount_paid + ?, remaining = MAX(0, remaining - ?)
          WHERE id = ?
        `).run(amount, amount, invoiceId);

        const inv = db.prepare('SELECT invoice_number, customer_id, remaining FROM invoices WHERE id = ?').get(invoiceId);

        addTreasuryEntry('إيراد', `سداد مديونية فاتورة ${inv.invoice_number}`, amount, safeType || 'الخزينة');

        if (inv.customer_id) {
          db.prepare('UPDATE customers SET current_balance = current_balance - ? WHERE id = ?').run(amount, inv.customer_id);
        }

        return true;
      });
      payTx();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ─── Reverse Payment (Admin) ────────────────────────────────────────────────
  ipcMain.handle('db:reversePayment', (_, invoiceId, amountToReverse) => {
    try {
      requireAdmin();
      const reverseTx = db.transaction(() => {
        const inv = db.prepare('SELECT invoice_number, customer_id, remaining, amount_paid, treasury_type FROM invoices WHERE id = ?').get(invoiceId);
        if (!inv) throw new Error('الفاتورة غير موجودة');

        const newPaid = Math.max(0, inv.amount_paid - amountToReverse);
        const newRemaining = inv.remaining + amountToReverse;

        db.prepare(`
          UPDATE invoices
          SET amount_paid = ?, remaining = ?
          WHERE id = ?
        `).run(newPaid, newRemaining, invoiceId);

        addTreasuryEntry('مصروف', `إرجاع تسديد خاطئ لفاتورة ${inv.invoice_number}`, amountToReverse, inv.treasury_type || 'الخزينة');

        if (inv.customer_id) {
          db.prepare('UPDATE customers SET current_balance = current_balance + ? WHERE id = ?').run(amountToReverse, inv.customer_id);
        }

        return true;
      });
      reverseTx();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ─── Update Invoice Status ──────────────────────────────────────────────────
  ipcMain.handle('db:updateInvoiceStatus', (_, invoiceId, status) => {
    try {
      db.prepare('UPDATE invoices SET status = ? WHERE id = ?').run(status, invoiceId);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });



  // ─── Salary payment (transaction) ─────────────────────────────────────────
  ipcMain.handle('db:paySalary', (_, salaryData) => {
    try {
      requireAdmin();
      const payTx = db.transaction(() => {
        const stmt = db.prepare(`
          INSERT INTO salary_payments (employee_id, month, gross_salary, total_advances,
            deductions, incentives, net_salary, paid_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        const info = stmt.run(
          salaryData.employee_id,
          salaryData.month,
          salaryData.gross_salary,
          salaryData.total_advances || 0,
          salaryData.deductions || 0,
          salaryData.incentives || 0,
          salaryData.net_salary,
          currentSession.employeeId || salaryData.paid_by || null
        );

        // Mark advances for this month as paid
        db.prepare(`
          UPDATE advances 
          SET paid_back = 1 
          WHERE employee_id = ? AND strftime('%Y-%m', date) = ? AND paid_back = 0
        `).run(salaryData.employee_id, salaryData.month);

        // دعم تقسيم الصرف بين الخزائن (الخزينة النقدية، فودافون كاش، إنستا باي)
        const cashAmount = salaryData.cash_amount || 0;
        const vodafoneAmount = salaryData.vodafone_amount || 0;
        const instapayAmount = salaryData.instapay_amount || 0;

        if (cashAmount > 0) {
          addTreasuryEntry('مصروف', `راتب موظف - ${salaryData.month}`, cashAmount, 'الخزينة');
        }
        if (vodafoneAmount > 0) {
          addTreasuryEntry('مصروف', `راتب موظف - ${salaryData.month}`, vodafoneAmount, 'فودافون كاش');
        }
        if (instapayAmount > 0) {
          addTreasuryEntry('مصروف', `راتب موظف - ${salaryData.month}`, instapayAmount, 'إنستا باي');
        }
        // fallback لو مفيش تقسيم
        if (cashAmount === 0 && vodafoneAmount === 0 && instapayAmount === 0) {
          addTreasuryEntry('مصروف', `راتب موظف - ${salaryData.month}`, salaryData.net_salary, salaryData.treasury_type || 'الخزينة');
        }

        logAudit('pay_salary', 'salary_payments', info.lastInsertRowid, null, salaryData);

        return info.lastInsertRowid;
      });

      const result = payTx();
      return { success: true, data: result };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ─── Reverse Salary payment (transaction) ─────────────────────────────────
  ipcMain.handle('db:reverseSalaryPayment', (_, employeeId, month) => {
    try {
      requireAdmin();
      const reverseTx = db.transaction(() => {
        const payments = db.prepare('SELECT * FROM salary_payments WHERE employee_id = ? AND month = ?').all(employeeId, month);
        if (!payments || payments.length === 0) {
          throw new Error('لا يوجد صرف راتب مسجل لهذا الموظف في هذا الشهر');
        }

        for (const p of payments) {
          // Look up audit log to find exact cash/vodafone/instapay split
          const audit = db.prepare(`SELECT new_value FROM audit_log WHERE action = 'pay_salary' AND table_name = 'salary_payments' AND record_id = ?`).get(p.id);
          let cashAmount = 0;
          let vodafoneAmount = 0;
          let instapayAmount = 0;
          let fallbackNet = p.net_salary;
          let hasAudit = false;

          if (audit && audit.new_value) {
            try {
              const salaryData = JSON.parse(audit.new_value);
              cashAmount = salaryData.cash_amount || 0;
              vodafoneAmount = salaryData.vodafone_amount || 0;
              instapayAmount = salaryData.instapay_amount || 0;
              hasAudit = true;
            } catch (e) {}
          }

          if (hasAudit && (cashAmount > 0 || vodafoneAmount > 0 || instapayAmount > 0)) {
            if (cashAmount > 0) addTreasuryEntry('إيراد', `إلغاء صرف راتب موظف - ${month}`, cashAmount, 'الخزينة');
            if (vodafoneAmount > 0) addTreasuryEntry('إيراد', `إلغاء صرف راتب موظف - ${month}`, vodafoneAmount, 'فودافون كاش');
            if (instapayAmount > 0) addTreasuryEntry('إيراد', `إلغاء صرف راتب موظف - ${month}`, instapayAmount, 'إنستا باي');
          } else {
            // Fallback if no specific split recorded
            addTreasuryEntry('إيراد', `إلغاء صرف راتب موظف - ${month}`, fallbackNet, 'الخزينة');
          }

          // Revert advances
          db.prepare(`
            UPDATE advances 
            SET paid_back = 0 
            WHERE employee_id = ? AND strftime('%Y-%m', date) = ? AND paid_back = 1
          `).run(employeeId, month);

          // Delete the payment record
          db.prepare('DELETE FROM salary_payments WHERE id = ?').run(p.id);
          logAudit('reverse_salary', 'salary_payments', p.id, p, null);
        }
        return true;
      });

      reverseTx();
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ─── Company settings ─────────────────────────────────────────────────────
  ipcMain.handle('db:getSettings', () => {
    try {
      const settings = db.prepare('SELECT * FROM company_settings WHERE id = 1').get();
      return { success: true, data: settings };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('db:updateSettings', (_, data) => {
    try {
      requireAdmin();
      db.prepare(`
        UPDATE company_settings SET
          company_name = ?, address = ?, phone = ?, logo_path = ?,
          tax_number = ?, receipt_footer = ?, receipt_notes = ?,
          show_customer_phone = ?, currency = ?,
          prevent_cashier_price_edit = ?,
          cashier_hide_reports = ?, cashier_hide_hr = ?, cashier_prevent_returns = ?,
          cashier_hide_finance = ?, cashier_prevent_discount = ?, cashier_prevent_settings = ?,
          wa_phone1 = ?, wa_phone2 = ?,
          wa_tpl_invoice_confirm = ?, wa_tpl_order_ready = ?, wa_tpl_delivered = ?,
          wa_tpl_full_payment = ?, wa_tpl_partial_payment = ?,
          admin_wa_phone = ?,
          report_save_path = ?,
          day_cutoff_hour = ?,
          printer_receipt = ?,
          printer_barcode = ?,
          printer_reports = ?,
          barcode_width = ?,
          barcode_height = ?,
          barcode_show_price = ?,
          barcode_show_name = ?,
          barcode_show_studio = ?,
          stock_out_behavior = ?
        WHERE id = 1
      `).run(
        data.company_name, data.address, data.phone, data.logo_path || null,
        data.tax_number, data.receipt_footer, data.receipt_notes || '',
        data.show_customer_phone ? 1 : 0,
        data.currency || 'جنيه',
        data.prevent_cashier_price_edit ? 1 : 0,
        data.cashier_hide_reports ? 1 : 0,
        data.cashier_hide_hr ? 1 : 0,
        data.cashier_prevent_returns ? 1 : 0,
        data.cashier_hide_finance ? 1 : 0,
        data.cashier_prevent_discount ? 1 : 0,
        data.cashier_prevent_settings ? 1 : 0,
        data.wa_phone1 || '',
        data.wa_phone2 || '',
        data.wa_tpl_invoice_confirm || '',
        data.wa_tpl_order_ready || '',
        data.wa_tpl_delivered || '',
        data.wa_tpl_full_payment || '',
        data.wa_tpl_partial_payment || '',
        data.admin_wa_phone || '',
        data.report_save_path || '',
        parseInt(data.day_cutoff_hour || 0, 10),
        data.printer_receipt || '',
        data.printer_barcode || '',
        data.printer_reports || '',
        parseFloat(data.barcode_width) || 38,
        parseFloat(data.barcode_height) || 25,
        data.barcode_show_price !== undefined ? (data.barcode_show_price ? 1 : 0) : 1,
        data.barcode_show_name !== undefined ? (data.barcode_show_name ? 1 : 0) : 1,
        data.barcode_show_studio !== undefined ? (data.barcode_show_studio ? 1 : 0) : 1,
        data.stock_out_behavior || 'warn'
      );
      logAudit('update_settings', 'company_settings', 1, null, data);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ─── User management (admin only) ─────────────────────────────────────────
  ipcMain.handle('users:list', () => {
    try {
      requireAdmin();
      const users = db.prepare(`
        SELECT u.id, u.employee_id, u.username, u.role, u.is_active, u.last_login, u.created_at,
               e.name as employee_name
        FROM users u
        LEFT JOIN employees e ON u.employee_id = e.id
        ORDER BY u.id
      `).all();
      return { success: true, data: users };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('users:create', (_, userData) => {
    try {
      requireAdmin();
      const hash = bcrypt.hashSync(userData.password, 10);
      const result = db.prepare(`
        INSERT INTO users (employee_id, username, password_hash, role, is_active)
        VALUES (?, ?, ?, ?, 1)
      `).run(userData.employee_id || null, userData.username, hash, userData.role || 'cashier');
      logAudit('create_user', 'users', result.lastInsertRowid, null, { username: userData.username, role: userData.role });
      return { success: true, data: result.lastInsertRowid };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('users:toggleActive', (_, userId) => {
    try {
      requireAdmin();
      const user = db.prepare('SELECT is_active, username FROM users WHERE id = ?').get(userId);
      if (!user) return { success: false, error: 'المستخدم غير موجود' };
      const newStatus = user.is_active ? 0 : 1;
      db.prepare('UPDATE users SET is_active = ? WHERE id = ?').run(newStatus, userId);
      logAudit('toggle_user', 'users', userId, { is_active: user.is_active }, { is_active: newStatus });
      return { success: true, data: newStatus };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('users:resetPassword', (_, userId, newPassword) => {
    try {
      requireAdmin();
      const hash = bcrypt.hashSync(newPassword, 10);
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, userId);
      logAudit('reset_password', 'users', userId, null, null);
      return { success: true };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ─── Backup ───────────────────────────────────────────────────────────────
  ipcMain.handle('backup:create', async (_, backupType) => {
    try {
      const result = await createBackup(backupType || 'يدوي');
      return result;
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('backup:getExternalPath', () => {
    return { success: true, data: getExternalBackupPath() };
  });

  ipcMain.handle('backup:setExternalPath', (_, dir) => {
    return setExternalBackupPath(dir);
  });

  ipcMain.handle('backup:clearExternalPath', () => {
    return setExternalBackupPath(null);
  });

  ipcMain.handle('backup:list', () => {
    try {
      return listBackups();
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  ipcMain.handle('backup:restore', (_, filePath) => {
    try {
      requireAdmin();
      if (!fs.existsSync(filePath)) {
        return { success: false, error: 'ملف النسخة الاحتياطية غير موجود' };
      }
      // Create safety backup first
      createBackup('تلقائي قبل الاسترجاع');

      const dbPath = getDbPath();
      // Close current db
      db.close();
      db = null;

      // Copy backup over current db
      fs.copyFileSync(filePath, dbPath);

      return { success: true, data: { requiresRestart: true } };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ─── Logo file copy ───────────────────────────────────────────────────────
  ipcMain.handle('settings:copyLogo', (_, sourcePath) => {
    try {
      const logoDir = path.join(appRef.getPath('userData'), 'assets', 'logo');
      if (!fs.existsSync(logoDir)) {
        fs.mkdirSync(logoDir, { recursive: true });
      }
      const ext = path.extname(sourcePath);
      const destPath = path.join(logoDir, `shop_logo${ext}`);
      fs.copyFileSync(sourcePath, destPath);
      return { success: true, data: destPath };
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ─── Selective Reset ──────────────────────────────────────────────────────
  ipcMain.handle('db:selectiveReset', (_, options) => {
    try {
      return selectiveReset(options);
    } catch (err) {
      return { success: false, error: err.message };
    }
  });

  // ─── Daily Report ─────────────────────────────────────────────────────────
  ipcMain.handle('db:getDailyReport', (_, date) => {
    return getDailyReport(date);
  });

  // ─── WhatsApp Messages & Chat IPC ─────────────────────────────────────────
  ipcMain.handle('db:getWhatsAppConversations', (_, searchQuery) => {
    return getWhatsAppConversations(searchQuery);
  });

  ipcMain.handle('db:getWhatsAppMessages', (_, phone) => {
    return getWhatsAppMessages(phone);
  });

  ipcMain.handle('db:saveWhatsAppMessage', (_, msg) => {
    return saveWhatsAppMessage(msg);
  });

  ipcMain.handle('db:markWhatsAppConversationAsRead', (_, phone) => {
    return markWhatsAppConversationAsRead(phone);
  });

  ipcMain.handle('db:getWhatsAppUnreadTotal', () => {
    return getWhatsAppUnreadTotal();
  });

  ipcMain.handle('db:deleteWhatsAppConversation', (_, phone) => {
    return deleteWhatsAppConversation(phone);
  });

  ipcMain.handle('db:deleteWhatsAppMessage', (_, id) => {
    return deleteWhatsAppMessage(id);
  });

  // ─── DB backup (legacy — kept for backward compatibility) ─────────────────
  ipcMain.handle('db:backup', async (_, destPath) => {
    try {
      await db.backup(destPath);
      return { success: true };
    } catch (err) {
      // Fallback to file copy
      try {
        const dbPath = getDbPath();
        fs.copyFileSync(dbPath, destPath);
        return { success: true };
      } catch (copyErr) {
        return { success: false, error: copyErr.message };
      }
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // ─── INVENTORY MODULE IPC HANDLERS ──────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  // List all services with inventory info (optionally filter by track_inventory)
  ipcMain.handle('inventory:list', (_, opts = {}) => {
    try {
      let sql = `
        SELECT s.*, c.name as category_name,
               COALESCE(s.quantity, 0) as quantity,
               COALESCE(s.low_stock_threshold, 0) as low_stock_threshold
        FROM services s
        LEFT JOIN service_categories c ON c.id = s.category_id
      `;
      const params = [];
      const conditions = [];
      if (opts.trackedOnly) { conditions.push('s.track_inventory = 1'); }
      if (opts.search) { conditions.push("(s.name LIKE ? OR s.barcode LIKE ?)"); params.push(`%${opts.search}%`, `%${opts.search}%`); }
      if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
      sql += ' ORDER BY c.name, s.name';
      return { success: true, data: db.prepare(sql).all(...params) };
    } catch (err) { return { success: false, error: err.message }; }
  });

  // Update inventory fields for a service (track_inventory, quantity, low_stock_threshold)
  ipcMain.handle('inventory:update', (_, serviceId, fields) => {
    try {
      const allowed = ['track_inventory', 'quantity', 'low_stock_threshold', 'cost_price', 'barcode'];
      const sets = Object.keys(fields).filter(k => allowed.includes(k)).map(k => `${k} = ?`);
      if (!sets.length) return { success: false, error: 'No valid fields' };
      const vals = Object.keys(fields).filter(k => allowed.includes(k)).map(k => fields[k]);
      db.prepare(`UPDATE services SET ${sets.join(', ')} WHERE id = ?`).run(...vals, serviceId);
      return { success: true };
    } catch (err) { return { success: false, error: err.message }; }
  });

  // Restock a tracked item (manual restock or supplier delivery)
  ipcMain.handle('inventory:restock', (_, serviceId, qty, notes) => {
    try {
      const srv = db.prepare('SELECT id, track_inventory, quantity FROM services WHERE id = ?').get(serviceId);
      if (!srv) return { success: false, error: 'Item not found' };
      const newQty = (srv.quantity || 0) + qty;
      db.prepare('UPDATE services SET quantity = ? WHERE id = ?').run(newQty, serviceId);
      db.prepare(`
        INSERT INTO inventory_movements (service_id, movement_type, quantity_change, quantity_after, reference_type, notes, employee_id)
        VALUES (?, 'restock', ?, ?, 'manual', ?, ?)
      `).run(serviceId, qty, newQty, notes || 'إعادة تخزين يدوي', currentSession.employeeId || null);
      return { success: true, data: { quantity: newQty } };
    } catch (err) { return { success: false, error: err.message }; }
  });

  // Manual quantity edit (stocktake-style one-off adjustment)
  ipcMain.handle('inventory:setQuantity', (_, serviceId, newQty, notes) => {
    try {
      const srv = db.prepare('SELECT id, quantity FROM services WHERE id = ?').get(serviceId);
      if (!srv) return { success: false, error: 'Item not found' };
      const change = newQty - (srv.quantity || 0);
      db.prepare('UPDATE services SET quantity = ? WHERE id = ?').run(newQty, serviceId);
      db.prepare(`
        INSERT INTO inventory_movements (service_id, movement_type, quantity_change, quantity_after, reference_type, notes, employee_id)
        VALUES (?, 'manual_edit', ?, ?, 'manual', ?, ?)
      `).run(serviceId, change, newQty, notes || 'تعديل يدوي', currentSession.employeeId || null);
      return { success: true, data: { quantity: newQty } };
    } catch (err) { return { success: false, error: err.message }; }
  });

  // Get low-stock items (quantity <= low_stock_threshold)
  ipcMain.handle('inventory:getLowStock', () => {
    try {
      const rows = db.prepare(`
        SELECT s.id, s.name, s.barcode, s.quantity, s.low_stock_threshold, c.name as category_name
        FROM services s
        LEFT JOIN service_categories c ON c.id = s.category_id
        WHERE s.track_inventory = 1 AND s.quantity <= s.low_stock_threshold
        ORDER BY s.quantity ASC
      `).all();
      return { success: true, data: rows };
    } catch (err) { return { success: false, error: err.message }; }
  });

  // Get inventory movements for a service (or all if no serviceId)
  ipcMain.handle('inventory:getMovements', (_, serviceId, opts = {}) => {
    try {
      let sql = `
        SELECT m.*, s.name as service_name, s.barcode
        FROM inventory_movements m
        LEFT JOIN services s ON s.id = m.service_id
      `;
      const params = [];
      const conditions = [];
      if (serviceId) { conditions.push('m.service_id = ?'); params.push(serviceId); }
      if (opts.from) { conditions.push("m.created_at >= ?"); params.push(opts.from); }
      if (opts.to)   { conditions.push("m.created_at <= ?"); params.push(opts.to + ' 23:59:59'); }
      if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
      sql += ' ORDER BY m.created_at DESC';
      if (opts.limit) { sql += ' LIMIT ?'; params.push(opts.limit); }
      return { success: true, data: db.prepare(sql).all(...params) };
    } catch (err) { return { success: false, error: err.message }; }
  });

  // Live inventory valuation report
  ipcMain.handle('inventory:getLiveReport', () => {
    try {
      const rows = db.prepare(`
        SELECT s.id, s.name, s.barcode, s.quantity, s.low_stock_threshold,
               s.cost_price, s.sell_price, s.track_inventory,
               c.name as category_name,
               (COALESCE(s.quantity, 0) * COALESCE(s.cost_price, 0)) as stock_value_cost,
               (COALESCE(s.quantity, 0) * COALESCE(s.sell_price, 0)) as stock_value_sell
        FROM services s
        LEFT JOIN service_categories c ON c.id = s.category_id
        WHERE s.track_inventory = 1
        ORDER BY c.name, s.name
      `).all();
      const totals = rows.reduce((acc, r) => {
        acc.totalCost += r.stock_value_cost || 0;
        acc.totalSell += r.stock_value_sell || 0;
        acc.totalItems += 1;
        if (r.quantity <= r.low_stock_threshold) acc.lowStockCount += 1;
        return acc;
      }, { totalCost: 0, totalSell: 0, totalItems: 0, lowStockCount: 0 });
      return { success: true, data: { items: rows, totals } };
    } catch (err) { return { success: false, error: err.message }; }
  });

  // ─── STOCKTAKE IPC HANDLERS ──────────────────────────────────────────────

  // Start a new stocktake session
  ipcMain.handle('stocktake:start', (_, notes) => {
    try {
      const res = db.prepare(`
        INSERT INTO stocktake_sessions (started_at, status, notes, employee_id)
        VALUES (datetime('now'), ?, ?, ?)
      `).run('مفتوح', notes || null, currentSession.employeeId || null);
      return { success: true, data: { id: res.lastInsertRowid } };
    } catch (err) { return { success: false, error: err.message }; }
  });

  // Save or update a counted item within a stocktake session
  ipcMain.handle('stocktake:saveCount', (_, sessionId, serviceId, countedQty) => {
    try {
      const srv = db.prepare('SELECT id, quantity FROM services WHERE id = ?').get(serviceId);
      if (!srv) return { success: false, error: 'Item not found' };
      const existing = db.prepare('SELECT id FROM stocktake_items WHERE stocktake_id = ? AND service_id = ?').get(sessionId, serviceId);
      if (existing) {
        db.prepare('UPDATE stocktake_items SET counted_quantity = ? WHERE id = ?').run(countedQty, existing.id);
      } else {
        db.prepare(`
          INSERT INTO stocktake_items (stocktake_id, service_id, system_quantity, counted_quantity)
          VALUES (?, ?, ?, ?)
        `).run(sessionId, serviceId, srv.quantity || 0, countedQty);
      }
      return { success: true };
    } catch (err) { return { success: false, error: err.message }; }
  });

  // Complete a stocktake session — apply all variances and lock session
  ipcMain.handle('stocktake:complete', (_, sessionId) => {
    try {
      const completeTx = db.transaction(() => {
        const items = db.prepare(`
          SELECT si.*, s.quantity as current_system_qty
          FROM stocktake_items si
          JOIN services s ON s.id = si.service_id
          WHERE si.stocktake_id = ?
        `).all(sessionId);

        for (const item of items) {
          const variance = (item.counted_quantity || 0) - (item.system_quantity || 0);
          if (variance !== 0) {
            db.prepare('UPDATE services SET quantity = ? WHERE id = ?').run(item.counted_quantity, item.service_id);
            db.prepare(`
              INSERT INTO inventory_movements (service_id, movement_type, quantity_change, quantity_after, reference_type, reference_id, notes, employee_id)
              VALUES (?, 'stocktake_adjustment', ?, ?, 'stocktake', ?, ?, ?)
            `).run(
              item.service_id, variance, item.counted_quantity,
              sessionId,
              `تسوية جرد — فرق: ${variance > 0 ? '+' : ''}${variance}`,
              currentSession.employeeId || null
            );
            db.prepare('UPDATE stocktake_items SET variance = ? WHERE id = ?').run(variance, item.id);
          }
        }

        db.prepare(`
          UPDATE stocktake_sessions SET status = 'مكتمل', completed_at = datetime('now') WHERE id = ?
        `).run(sessionId);
      });
      completeTx();
      return { success: true };
    } catch (err) { return { success: false, error: err.message }; }
  });

  // List stocktake sessions
  ipcMain.handle('stocktake:list', () => {
    try {
      const rows = db.prepare(`
        SELECT ss.*,
               ss.started_at as start_date,
               ss.completed_at as end_date,
               (SELECT COUNT(*) FROM stocktake_items si WHERE si.stocktake_id = ss.id) as item_count
        FROM stocktake_sessions ss
        ORDER BY ss.started_at DESC
      `).all();
      return { success: true, data: rows };
    } catch (err) { return { success: false, error: err.message }; }
  });

  // Get full stocktake session report
  ipcMain.handle('stocktake:getReport', (_, sessionId) => {
    try {
      const session = db.prepare(`
        SELECT *, started_at as start_date, completed_at as end_date
        FROM stocktake_sessions WHERE id = ?
      `).get(sessionId);
      if (!session) return { success: false, error: 'Session not found' };
      const items = db.prepare(`
        SELECT si.*, s.name as service_name, s.barcode, c.name as category_name
        FROM stocktake_items si
        JOIN services s ON s.id = si.service_id
        LEFT JOIN service_categories c ON c.id = s.category_id
        WHERE si.stocktake_id = ?
        ORDER BY c.name, s.name
      `).all(sessionId);
      return { success: true, data: { session, items } };
    } catch (err) { return { success: false, error: err.message }; }
  });

}

// ─── WhatsApp Messages & Conversations Database Functions ────────────────────
function normalizePhone(p) {
  if (!p) return '';
  return String(p).replace(/[\s\+\-\(\)]/g, '');
}

function getWhatsAppConversations(searchQuery = '') {
  try {
    let sql = `
      SELECT 
        m.phone,
        COALESCE(c.name, m.sender_name, m.phone) AS display_name,
        m.message_body AS last_message,
        m.direction AS last_direction,
        m.message_type AS last_type,
        m.created_at AS last_time,
        COALESCE(u.unread_count, 0) AS unread_count
      FROM whatsapp_messages m
      INNER JOIN (
        SELECT phone, MAX(id) AS max_id
        FROM whatsapp_messages
        GROUP BY phone
      ) latest ON m.id = latest.max_id
      LEFT JOIN customers c ON (
        c.phone = m.phone OR 
        REPLACE(REPLACE(REPLACE(c.phone, ' ', ''), '+', ''), '-', '') = REPLACE(REPLACE(REPLACE(m.phone, ' ', ''), '+', ''), '-', '') OR
        (LENGTH(m.phone) >= 10 AND c.phone LIKE '%' || SUBSTR(m.phone, -10))
      )
      LEFT JOIN (
        SELECT phone, COUNT(*) AS unread_count
        FROM whatsapp_messages
        WHERE direction = 'inbound' AND is_read = 0
        GROUP BY phone
      ) u ON m.phone = u.phone
    `;

    const params = [];
    if (searchQuery && searchQuery.trim()) {
      const q = `%${searchQuery.trim()}%`;
      sql += ` WHERE (c.name LIKE ? OR m.sender_name LIKE ? OR m.phone LIKE ? OR m.message_body LIKE ?) `;
      params.push(q, q, q, q);
    }

    sql += ` ORDER BY m.id DESC LIMIT 100`;

    const rows = db.prepare(sql).all(...params);
    return { success: true, data: rows };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function getWhatsAppMessages(phone) {
  try {
    if (!phone) return { success: false, error: 'رقم الهاتف مطلوب' };
    const clean = normalizePhone(phone);
    const suffix = clean.length >= 10 ? clean.slice(-10) : clean;

    const rows = db.prepare(`
      SELECT * FROM whatsapp_messages 
      WHERE phone = ? OR phone LIKE '%' || ?
      ORDER BY id ASC
    `).all(phone, suffix);

    return { success: true, data: rows };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function saveWhatsAppMessage({ wa_message_id, phone, sender_name, direction, message_type = 'text', message_body, media_url = null, status = 'received', is_read = 0 }) {
  try {
    if (!phone) return { success: false, error: 'رقم الهاتف مطلوب' };
    const stmt = db.prepare(`
      INSERT OR REPLACE INTO whatsapp_messages 
      (wa_message_id, phone, sender_name, direction, message_type, message_body, media_url, status, is_read, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
    `);
    const info = stmt.run(
      wa_message_id || null,
      String(phone).trim(),
      sender_name || null,
      direction || 'inbound',
      message_type || 'text',
      message_body || '',
      media_url || null,
      status || (direction === 'outbound' ? 'sent' : 'received'),
      is_read ? 1 : 0
    );
    return { success: true, id: info.lastInsertRowid };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function markWhatsAppConversationAsRead(phone) {
  try {
    if (!phone) return { success: false, error: 'رقم الهاتف مطلوب' };
    const clean = normalizePhone(phone);
    const suffix = clean.length >= 10 ? clean.slice(-10) : clean;

    db.prepare(`
      UPDATE whatsapp_messages 
      SET is_read = 1 
      WHERE direction = 'inbound' AND (phone = ? OR phone LIKE '%' || ?)
    `).run(phone, suffix);

    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function getWhatsAppUnreadTotal() {
  try {
    const row = db.prepare(`
      SELECT COUNT(*) AS total 
      FROM whatsapp_messages 
      WHERE direction = 'inbound' AND is_read = 0
    `).get();
    return { success: true, total: row ? row.total : 0 };
  } catch (err) {
    return { success: false, total: 0, error: err.message };
  }
}

function deleteWhatsAppConversation(phone) {
  try {
    if (!phone) return { success: false, error: 'رقم الهاتف مطلوب' };
    const clean = normalizePhone(phone);
    const suffix = clean.length >= 10 ? clean.slice(-10) : clean;

    const info = db.prepare(`
      DELETE FROM whatsapp_messages 
      WHERE phone = ? OR phone LIKE '%' || ?
    `).run(phone, suffix);

    return { success: true, deletedCount: info.changes };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

function deleteWhatsAppMessage(id) {
  try {
    if (!id) return { success: false, error: 'معرف الرسالة مطلوب' };
    const info = db.prepare('DELETE FROM whatsapp_messages WHERE id = ?').run(id);
    return { success: true, deletedCount: info.changes };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

module.exports = { 
  getDb, 
  setupIpcHandlers, 
  generateInvoiceNumber, 
  addTreasuryEntry, 
  getTreasuryBalance, 
  createBackup, 
  copyBackupToExternal, 
  getExternalBackupPath, 
  selectiveReset,
  getWhatsAppConversations,
  getWhatsAppMessages,
  saveWhatsAppMessage,
  markWhatsAppConversationAsRead,
  getWhatsAppUnreadTotal,
  deleteWhatsAppConversation,
  deleteWhatsAppMessage
};

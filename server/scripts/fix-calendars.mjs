/**
 * Creates local calendars for existing offices and assigns appointments to them.
 */
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const Database = require('better-sqlite3');
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = path.resolve(__dirname, '../data/osteo.db');

const db = new Database(DB_PATH);

const offices = db.prepare('SELECT id, name FROM offices ORDER BY id').all();
console.log('Offices:', offices.map(o => o.id + ' ' + o.name));

const colors = ['#4d92d1', '#5d8f5a', '#d17d4d', '#9a5dd1'];

for (const [i, o] of offices.entries()) {
  const existing = db.prepare('SELECT id FROM local_calendars WHERE office_id = ?').get(o.id);
  if (!existing) {
    db.prepare(
      `INSERT INTO local_calendars (name, description, color_hex, is_visible_to_all, visible_user_ids, office_id, display_order)
       VALUES (?, ?, ?, 1, '[]', ?, ?)`
    ).run(o.name, `Agenda du cabinet ${o.name}`, colors[i % colors.length], o.id, i + 1);
    console.log(`Created calendar for office ${o.id}: ${o.name}`);
  } else {
    console.log(`Calendar already exists for office ${o.id} (id=${existing.id})`);
  }
}

const cals = db.prepare('SELECT id, office_id, name FROM local_calendars ORDER BY office_id').all();
console.log('All calendars:', JSON.stringify(cals));

// Associate existing appointments to their office calendar
for (const cal of cals) {
  const r = db.prepare(
    'UPDATE appointments SET local_calendar_id = ? WHERE office_id = ? AND local_calendar_id IS NULL'
  ).run(cal.id, cal.office_id);
  console.log(`Office ${cal.office_id}: updated ${r.changes} appointments`);
}

// Remaining (no office) -> first calendar
if (cals.length > 0) {
  const r = db.prepare(
    'UPDATE appointments SET local_calendar_id = ? WHERE local_calendar_id IS NULL'
  ).run(cals[0].id);
  console.log(`Assigned ${r.changes} remaining appointments to calendar ${cals[0].id}`);
}

const total = db.prepare('SELECT COUNT(*) AS n FROM appointments WHERE local_calendar_id IS NOT NULL').get();
console.log(`Total appointments with calendar: ${total.n}`);

db.close();
console.log('Done.');

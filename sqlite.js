
import DatabaseLib from 'better-sqlite3';

export class Database {
  constructor(fp){
    this.db = new DatabaseLib(fp);
  }
  migrate(){
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reservations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        salon_id TEXT,
        salon_name TEXT,
        item TEXT,
        price REAL,
        time_iso TEXT,
        contact_name TEXT,
        contact_email TEXT,
        contact_phone TEXT,
        status TEXT,
        stripe_session_id TEXT,
        stripe_payment_intent TEXT,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      );
      CREATE INDEX IF NOT EXISTS idx_res_status ON reservations(status);
      CREATE INDEX IF NOT EXISTS idx_res_created ON reservations(created_at);
    `);
  }
  createReservation(obj){
    const stmt = this.db.prepare(`INSERT INTO reservations
      (salon_id, salon_name, item, price, time_iso, contact_name, contact_email, contact_phone, status)
      VALUES (@salon_id, @salon_name, @item, @price, @time_iso, @contact_name, @contact_email, @contact_phone, @status)`);
    const info = stmt.run(obj);
    return String(info.lastInsertRowid);
  }
  getReservation(id){
    return this.db.prepare(`SELECT * FROM reservations WHERE id = ?`).get(id);
  }
  listReservations({status, q, limit=200, offset=0}){
    let sql = `SELECT * FROM reservations`;
    const cond = [];
    const params = [];
    if(status){ cond.push(`status = ?`); params.push(status); }
    if(q){
      cond.push(`(item LIKE ? OR salon_name LIKE ? OR contact_name LIKE ? OR contact_email LIKE ? OR contact_phone LIKE ?)`);
      params.push(`%${q}%`,`%${q}%`,`%${q}%`,`%${q}%`,`%${q}%`);
    }
    if(cond.length) sql += ` WHERE ` + cond.join(' AND ');
    sql += ` ORDER BY created_at DESC LIMIT ? OFFSET ?`;
    params.push(limit, offset);
    return this.db.prepare(sql).all(...params);
  }
  updateReservationStatus(id, status){
    const info = this.db.prepare(`UPDATE reservations SET status = ?, updated_at = datetime('now') WHERE id = ?`).run(status, id);
    return info.changes > 0;
  }
  attachStripeSession(id, session_id){
    const info = this.db.prepare(`UPDATE reservations SET stripe_session_id = ?, updated_at = datetime('now') WHERE id = ?`).run(session_id, id);
    return info.changes > 0;
  }
  attachPaymentIntent(id, pi){
    const info = this.db.prepare(`UPDATE reservations SET stripe_payment_intent = ?, updated_at = datetime('now') WHERE id = ?`).run(pi, id);
    return info.changes > 0;
  }
}

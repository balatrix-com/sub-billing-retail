const pool = require('../config/database');

class RecRateCard {
  static async getById(id) {
    const query = 'SELECT * FROM rec_rate_card WHERE id = $1;';
    try {
      const result = await pool.query(query, [id]);
      return result.rows[0] || null;
    } catch (err) {
      throw new Error(`Failed to fetch rec_rate_card: ${err.message}`);
    }
  }

  static async getAll() {
    const query = 'SELECT * FROM rec_rate_card ORDER BY id ASC;';
    try {
      const result = await pool.query(query);
      return result.rows;
    } catch (err) {
      throw new Error(`Failed to fetch recording rate cards: ${err.message}`);
    }
  }

  static async create(data) {
    const { id, name, currency, rate_per_min, retention_period } = data;
    
    let finalId = id;
    if (!finalId) {
      try {
        const maxRes = await pool.query('SELECT COALESCE(MAX(id), 0) as max_id FROM rec_rate_card;');
        finalId = maxRes.rows[0].max_id + 1;
      } catch (err) {
        throw new Error(`Failed to generate new ID: ${err.message}`);
      }
    }
    
    const query = `
      INSERT INTO rec_rate_card (id, name, currency, rate_per_min, retention_period)
      VALUES ($1, $2, $3, $4, $5)
      RETURNING *;
    `;
    const values = [finalId, name, currency, rate_per_min, retention_period];
    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (err) {
      throw new Error(`Failed to create rec_rate_card: ${err.message}`);
    }
  }

  static async update(id, data) {
    const fields = [];
    const values = [];
    let i = 1;

    for (const [key, value] of Object.entries(data)) {
      if (key === 'id') continue;
      fields.push(`${key} = $${i++}`);
      values.push(value);
    }

    if (fields.length === 0) return this.getById(id);

    values.push(id);
    const query = `
      UPDATE rec_rate_card
      SET ${fields.join(', ')}
      WHERE id = $${i}
      RETURNING *;
    `;

    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (err) {
      throw new Error(`Failed to update rec_rate_card: ${err.message}`);
    }
  }

  static async getCustomerMappings() {
    const query = `
      SELECT c.customer_id, c.admin_email as customer_email, cr.rec_rc_id, r.name as rec_ratecard_name
      FROM customers c
      LEFT JOIN customer_rec_rc cr ON c.customer_id = cr.cust_id
      LEFT JOIN rec_rate_card r ON cr.rec_rc_id = r.id
      ORDER BY c.customer_id ASC;
    `;
    try {
      const result = await pool.query(query);
      return result.rows;
    } catch (err) {
      throw new Error(`Failed to fetch recording rate card mappings: ${err.message}`);
    }
  }

  static async getCustomerRateCard(custId) {
    const query = `
      SELECT cr.cust_id, cr.rec_rc_id, r.*
      FROM customer_rec_rc cr
      LEFT JOIN rec_rate_card r ON cr.rec_rc_id = r.id
      WHERE cr.cust_id = $1;
    `;
    try {
      const result = await pool.query(query, [custId]);
      return result.rows[0] || null;
    } catch (err) {
      throw new Error(`Failed to fetch customer rec_rate_card: ${err.message}`);
    }
  }

  static async updateCustomerRateCard(custId, recRcId) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM customer_rec_rc WHERE cust_id = $1', [custId]);
      const insertQuery = `
        INSERT INTO customer_rec_rc (cust_id, rec_rc_id)
        VALUES ($1, $2)
        RETURNING *;
      `;
      const result = await client.query(insertQuery, [custId, recRcId]);
      await client.query('COMMIT');
      return result.rows[0];
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Failed to update customer rec_rate_card: ${err.message}`);
    } finally {
      client.release();
    }
  }
}

module.exports = RecRateCard;

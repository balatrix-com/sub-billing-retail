const pool = require('../config/database');

class RateCard {
  static async getAll() {
    const query = 'SELECT * FROM rate_cards ORDER BY ratecard_id ASC;';
    try {
      const result = await pool.query(query);
      return result.rows;
    } catch (err) {
      throw new Error(`Failed to fetch rate cards: ${err.message}`);
    }
  }

  static async getById(id) {
    const query = 'SELECT * FROM rate_cards WHERE ratecard_id = $1;';
    try {
      const result = await pool.query(query, [id]);
      return result.rows[0] || null;
    } catch (err) {
      throw new Error(`Failed to fetch rate card: ${err.message}`);
    }
  }

  static async create(data) {
    const {
      name, currency, country,
      in_rate_per_min, in_initial_increment_sec, in_increment_sec,
      ob_rate_per_min, ob_initial_increment_sec, ob_increment_sec
    } = data;

    const query = `
      INSERT INTO rate_cards (
        name, currency, country,
        in_rate_per_min, in_initial_increment_sec, in_increment_sec,
        ob_rate_per_min, ob_initial_increment_sec, ob_increment_sec
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *;
    `;

    const values = [
      name, currency || 'USD', country || null,
      in_rate_per_min || 0, in_initial_increment_sec || 60, in_increment_sec || 60,
      ob_rate_per_min || 0, ob_initial_increment_sec || 60, ob_increment_sec || 60
    ];

    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (err) {
      throw new Error(`Failed to create rate card: ${err.message}`);
    }
  }

  static async update(id, data) {
    const fields = [];
    const values = [];
    let i = 1;

    for (const [key, value] of Object.entries(data)) {
      if (key === 'ratecard_id' || key === 'created_at' || key === 'updated_at') continue;
      fields.push(`${key} = $${i++}`);
      values.push(value);
    }

    if (fields.length === 0) return this.getById(id);

    values.push(id);
    const query = `
      UPDATE rate_cards
      SET ${fields.join(', ')}
      WHERE ratecard_id = $${i}
      RETURNING *;
    `;

    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (err) {
      throw new Error(`Failed to update rate card: ${err.message}`);
    }
  }

  static async getCustomerMappings() {
    const query = `
      SELECT c.customer_id, c.admin_email as customer_email, cr.ratecard_id, rc.name as ratecard_name
      FROM customers c
      LEFT JOIN customer_ratecard cr ON c.customer_id = cr.customer_id
      LEFT JOIN rate_cards rc ON cr.ratecard_id = rc.ratecard_id
      ORDER BY c.customer_id ASC;
    `;
    try {
      const result = await pool.query(query);
      return result.rows;
    } catch (err) {
      throw new Error(`Failed to fetch mappings: ${err.message}`);
    }
  }

  static async updateCustomerMapping(customerId, ratecardId) {
    const query = `
      INSERT INTO customer_ratecard (customer_id, ratecard_id, updated_at)
      VALUES ($1, $2, now())
      ON CONFLICT (customer_id)
      DO UPDATE SET ratecard_id = EXCLUDED.ratecard_id, updated_at = now()
      RETURNING *;
    `;
    try {
      const result = await pool.query(query, [customerId, ratecardId]);
      return result.rows[0];
    } catch (err) {
      throw new Error(`Failed to update mapping: ${err.message}`);
    }
  }
}

module.exports = RateCard;

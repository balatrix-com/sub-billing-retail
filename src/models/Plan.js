const pool = require('../config/database');

class Plan {
  static async create(planData) {
    const {
      plan_id,
      name,
      amount,
      currency,
      validity_months,
      rate_card_id = null,
      tfns = 0,
      dids = 0,
      free_mins = 0,
      extensions = 0,
      monitoring_per_user = 0,
      metadata = {},
      system_plan_id = null,
      setup_fees = 0
    } = planData;

    const query = `
      INSERT INTO plans (
        plan_id, name, amount, currency, validity_months, rate_card_id,
        tfns, dids, free_mins, extensions, monitoring_per_user, metadata,
        system_plan_id, setup_fees
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      RETURNING *;
    `;

    const values = [
      plan_id, name, amount, currency, validity_months, rate_card_id,
      tfns, dids, free_mins, extensions, monitoring_per_user, 
      JSON.stringify(metadata), system_plan_id, setup_fees
    ];

    try {
      const result = await pool.query(query, values);
      return result.rows[0];
    } catch (err) {
      throw new Error(`Failed to create plan: ${err.message}`);
    }
  }

  static async findById(planId) {
    const query = 'SELECT * FROM plans WHERE plan_id = $1;';
    try {
      const result = await pool.query(query, [planId]);
      return result.rows[0] || null;
    } catch (err) {
      throw new Error(`Failed to fetch plan: ${err.message}`);
    }
  }

  static async getAll() {
    const query = 'SELECT * FROM plans ORDER BY created_at DESC;';
    try {
      const result = await pool.query(query);
      return result.rows;
    } catch (err) {
      throw new Error(`Failed to fetch plans: ${err.message}`);
    }
  }

  static async update(planId, updates) {
    const allowedFields = [
      'name', 'amount', 'validity_months', 'rate_card_id',
      'tfns', 'dids', 'free_mins', 'extensions', 'monitoring_per_user',
      'metadata', 'system_plan_id', 'setup_fees'
    ];
    const updateKeys = Object.keys(updates).filter(key => allowedFields.includes(key));

    if (updateKeys.length === 0) {
      throw new Error('No valid fields to update');
    }

    const updateFields = updateKeys
      .map((key, index) => {
        if (key === 'metadata') {
          return `${key} = $${index + 1}::jsonb`;
        }
        return `${key} = $${index + 1}`;
      })
      .join(', ');

    const values = updateKeys.map(key => {
      if (key === 'metadata' && typeof updates[key] === 'object') {
        return JSON.stringify(updates[key]);
      }
      return updates[key];
    });
    values.push(planId);

    const query = `
      UPDATE plans
      SET ${updateFields}
      WHERE plan_id = $${values.length}
      RETURNING *;
    `;

    try {
      const result = await pool.query(query, values);
      return result.rows[0] || null;
    } catch (err) {
      throw new Error(`Failed to update plan: ${err.message}`);
    }
  }

  static async countSubscriptionsByStatus(planId) {
    const query = `
      SELECT 
        COUNT(*) FILTER (WHERE status = 'active')::int    as active,
        COUNT(*) FILTER (WHERE status = 'cancelled')::int as cancelled,
        COUNT(*) FILTER (WHERE status = 'suspended')::int as suspended,
        COUNT(*)::int                                      as total
      FROM subscriptions 
      WHERE plan_id = $1;
    `;
    try {
      const result = await pool.query(query, [planId]);
      return result.rows[0];
    } catch (err) {
      throw new Error(`Failed to count subscriptions: ${err.message}`);
    }
  }

  static async delete(planId) {
    try {
      const counts = await this.countSubscriptionsByStatus(planId);

      // Block 1: Active subscriptions — must be cancelled/switched first
      if (counts.active > 0) {
        const err = new Error(
          `Cannot delete plan "${planId}": ${counts.active} active subscription(s) still reference it. Cancel or switch those subscriptions first.`
        );
        err.statusCode = 409;
        throw err;
      }

      // Block 2: Historical subscriptions (cancelled/suspended) — plan data needed for billing history
      if (counts.total > 0) {
        const err = new Error(
          `Cannot delete plan "${planId}": ${counts.total} subscription(s) (${counts.cancelled} cancelled, ${counts.suspended} suspended) reference it for billing history. The plan data is needed for invoices and audit records.`
        );
        err.statusCode = 409;
        throw err;
      }

      // Safe to delete — no subscriptions ever used this plan
      const query = 'DELETE FROM plans WHERE plan_id = $1 RETURNING *;';
      const result = await pool.query(query, [planId]);
      return result.rows[0] || null;
    } catch (err) {
      if (err.statusCode) throw err;
      throw new Error(`Failed to delete plan: ${err.message}`);
    }
  }
}

module.exports = Plan;

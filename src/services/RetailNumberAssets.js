const { v4: uuidv4 } = require('uuid');

const numberTypes = {
  TFN: { table: 'tfn_assets', column: 'tfn_number', nameColumn: 'tfn_name' },
  DID: { table: 'did_assets', column: 'did_number', nameColumn: 'did_name' }
};

function httpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizedNumbers(assets) {
  const tfns = [...new Set((Array.isArray(assets?.tfns) ? assets.tfns : []).map(value => String(value).trim()).filter(Boolean))];
  const dids = [...new Set((Array.isArray(assets?.dids) ? assets.dids : []).map(value => String(value).trim()).filter(Boolean))];
  if (tfns.some(number => dids.includes(number))) {
    throw httpError('A number cannot be both a DID and TFN', 400);
  }
  for (const number of [...tfns, ...dids]) {
    if (!/^\+[1-9]\d{6,14}$/.test(number)) {
      throw httpError(`Invalid E.164 number: ${number}`, 400);
    }
  }
  return { TFN: tfns, DID: dids };
}

function createRetailNumberAssets(pool) {
  async function findSubscription(client, identifier, activeOnly) {
    if (!identifier) throw httpError('Subscription identifier is required', 400);
    const result = await client.query(`
      SELECT s.id, s.subscription_id, s.customer_id, s.plan_id, p.numbers
      FROM subscriptions s JOIN plans p ON p.plan_id = s.plan_id
      WHERE (s.subscription_id = $1 OR s.customer_id = $1 OR s.id::text = $1)
        ${activeOnly ? "AND s.status = 'active'" : ''}
      ORDER BY s.created_at DESC LIMIT 1 FOR UPDATE OF s
    `, [identifier]);
    if (!result.rows.length) throw httpError('Subscription not found', 404);
    return result.rows[0];
  }

  async function countAssigned(client, customerId) {
    const result = await client.query(`
      SELECT (
        (SELECT COUNT(*) FROM tfn_assets a JOIN subscriptions s ON s.id = a.subscription_id
         WHERE a.customer_id = $1 AND a.tfn_number IS NOT NULL AND a.status = 'active' AND s.status = 'active') +
        (SELECT COUNT(*) FROM did_assets a JOIN subscriptions s ON s.id = a.subscription_id
         WHERE a.customer_id = $1 AND a.did_number IS NOT NULL AND a.status = 'active' AND s.status = 'active')
      )::int AS used
    `, [customerId]);
    return Number(result.rows[0].used);
  }

  async function syncAssets(identifier, assets) {
    const numbers = normalizedNumbers(assets);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Lock the selected subscription and then the customer's pooled quota.
      const subscription = await findSubscription(client, identifier, true);
      // A customer may briefly have more than one active subscription during a
      // plan switch, so serialize their pooled number quota across both rows.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`customer-numbers:${subscription.customer_id}`]);
      let used = await countAssigned(client, subscription.customer_id);
      const limit = Number(subscription.numbers);

      for (const type of ['TFN', 'DID']) {
        const { table, column, nameColumn } = numberTypes[type];
        const other = numberTypes[type === 'TFN' ? 'DID' : 'TFN'];
        for (const number of numbers[type]) {
          // The number lock also serializes attempts by different customers.
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`number:${number}`]);
          const opposite = await client.query(`SELECT id FROM ${other.table} WHERE ${other.column} = $1 LIMIT 1`, [number]);
          if (opposite.rows.length) throw httpError(`${number} already exists as the other number type`, 409);

          const existing = await client.query(`
            SELECT a.id, a.subscription_id, a.customer_id, a.status, s.status AS subscription_status
            FROM ${table} a JOIN subscriptions s ON s.id = a.subscription_id
            WHERE a.${column} = $1 FOR UPDATE OF a
          `, [number]);
          const row = existing.rows[0];
          if (row && row.customer_id !== subscription.customer_id) {
            throw httpError(`${number} is assigned to another customer`, 409);
          }
          if (row && row.subscription_id !== subscription.id && row.subscription_status === 'active') {
            throw httpError(`${number} belongs to another active subscription`, 409);
          }
          if (row?.subscription_id === subscription.id && row.status === 'active') continue;
          if (used >= limit) throw httpError(`Numbers quota reached (${used}/${limit})`, 409);

          if (row) {
            await client.query(`UPDATE ${table} SET subscription_id = $1, customer_id = $2, status = 'active', updated_at = now() WHERE id = $3`,
              [subscription.id, subscription.customer_id, row.id]);
          } else {
            const placeholder = await client.query(`
              SELECT id FROM ${table} WHERE subscription_id = $1 AND ${column} IS NULL AND status = 'unassigned'
              ORDER BY created_at ASC LIMIT 1 FOR UPDATE
            `, [subscription.id]);
            if (placeholder.rows.length) {
              await client.query(`UPDATE ${table} SET ${column} = $1, status = 'active', updated_at = now() WHERE id = $2`,
                [number, placeholder.rows[0].id]);
            } else {
              await client.query(`
                INSERT INTO ${table} (id, customer_id, subscription_id, source_type, source_id,
                  subscription_addon_id, ${column}, ${nameColumn}, status, assigned_date, metadata)
                VALUES ($1, $2, $3, 'plan', $4, null, $5, $6, 'active', now(), '{}'::jsonb)
              `, [uuidv4(), subscription.customer_id, subscription.id, subscription.plan_id, number, `${type} ${number}`]);
            }
          }
          used++;
        }
      }
      await client.query('COMMIT');
      return { success: true, used, limit };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function unassignAssets(identifier, assets) {
    const numbers = normalizedNumbers(assets);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const subscription = await findSubscription(client, identifier, false);
      for (const type of ['TFN', 'DID']) {
        const { table, column } = numberTypes[type];
        for (const number of numbers[type]) {
          await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`number:${number}`]);
          const result = await client.query(`
            UPDATE ${table} SET ${column} = NULL, status = 'unassigned', updated_at = now()
            WHERE subscription_id = $1 AND ${column} = $2
          `, [subscription.id, number]);
          if (result.rowCount !== 1) {
            throw httpError(`${number} is not assigned to this subscription in sub-billing`, 409);
          }
        }
      }
      await client.query('COMMIT');
      return { success: true };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  return { syncAssets, unassignAssets };
}

module.exports = { createRetailNumberAssets };

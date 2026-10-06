const { pool, readonlyPool } = require('../config/database');

/**
 * Resolve a date preset into a { startDate, endDate } range (UTC).
 * @param {string} preset  - today | yesterday | last7days | lastMonth | last30days
 * @returns {{ startDate: Date, endDate: Date }}
 */
function resolveDatePreset(preset) {
  const now = new Date();

  // Helper: start of a day (00:00:00.000)
  const startOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  // Helper: end of a day (23:59:59.999)
  const endOf = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999);

  switch (preset) {
    case 'today':
      return { startDate: startOf(now), endDate: endOf(now) };

    case 'yesterday': {
      const yesterday = new Date(now);
      yesterday.setDate(now.getDate() - 1);
      return { startDate: startOf(yesterday), endDate: endOf(yesterday) };
    }

    case 'last7days': {
      const weekAgo = new Date(now);
      weekAgo.setDate(now.getDate() - 6);
      return { startDate: startOf(weekAgo), endDate: endOf(now) };
    }

    case 'lastMonth': {
      // Full previous calendar month
      const firstOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastOfPrevMonth = new Date(firstOfThisMonth.getTime() - 1);
      const firstOfPrevMonth = new Date(lastOfPrevMonth.getFullYear(), lastOfPrevMonth.getMonth(), 1);
      return { startDate: startOf(firstOfPrevMonth), endDate: endOf(lastOfPrevMonth) };
    }

    case 'last30days': {
      const thirtyAgo = new Date(now);
      thirtyAgo.setDate(now.getDate() - 29);
      return { startDate: startOf(thirtyAgo), endDate: endOf(now) };
    }

    default:
      return null; // no preset matched
  }
}

class CdrService {
  /**
   * Get CDRs for a specific customer with optional filtering and pagination
   * @param {string} customerId 
   * @param {Object} filters { startDate, endDate, limit, offset }
   * @returns {Promise<Object>} { data: Array, total: number }
   */
  static async getCdrsByCustomerId(customerId, filters = {}) {
    const { startDate, endDate, limit = 50, offset = 0 } = filters;
    let baseQuery = `
      FROM cdr
      WHERE customer_id = $1
    `;
    
    const params = [customerId];
    let paramCount = 1;

    if (startDate) {
      paramCount++;
      baseQuery += ` AND start_time >= $${paramCount}`;
      params.push(startDate);
    }

    if (endDate) {
      paramCount++;
      baseQuery += ` AND start_time <= $${paramCount}`;
      params.push(endDate);
    }

    const countQuery = `SELECT COUNT(*) as count ${baseQuery}`;
    const countParams = [...params];
    
    let dataQuery = `
      SELECT 
        call_uuid,
        caller, 
        callee, 
        direction as call_type,
        duration_sec,
        dest_value,
        COALESCE(billed_amount, 0) as billed_amount,
        billed_amount as bill_amount,
        COALESCE(recording_amount, 0) as recording_amount,
        (COALESCE(billed_amount, 0) + COALESCE(recording_amount, 0)) as total_amount,
        dest_type,
        billsec,
        call_status as status,
        recording as has_recording,
        start_time as created_at
      ${baseQuery}
      ORDER BY created_at DESC
    `;

    if (limit && limit !== 'all') {
      paramCount++;
      dataQuery += ` LIMIT $${paramCount}`;
      params.push(limit);

      paramCount++;
      dataQuery += ` OFFSET $${paramCount}`;
      params.push(offset);
    }
    
    try {
      const [countResult, dataResult] = await Promise.all([
        readonlyPool.query(countQuery, countParams),
        readonlyPool.query(dataQuery, params)
      ]);

      return {
        data: dataResult.rows,
        total: parseInt(countResult.rows[0].count)
      };
    } catch (err) {
      throw new Error(`Failed to fetch CDRs: ${err.message}`);
    }
  }

  /**
   * Get all CDRs with optional filtering and pagination in ascending order
   * @param {Object} filters { search, startDate, endDate, limit, offset }
   * @returns {Promise<Object>} { data: Array, total: number }
   */
  static async getAllCdrs(filters = {}) {
    const { search, startDate, endDate, limit = 50, offset = 0 } = filters;
    let baseQuery = `
      FROM cdr
      WHERE 1=1
    `;
    
    const params = [];
    let paramCount = 0;

    if (search) {
      paramCount++;
      baseQuery += ` AND (caller LIKE $${paramCount} OR callee LIKE $${paramCount})`;
      params.push(`%${search}%`);
    }

    if (startDate) {
      paramCount++;
      baseQuery += ` AND start_time >= $${paramCount}`;
      params.push(startDate);
    }

    if (endDate) {
      paramCount++;
      baseQuery += ` AND start_time <= $${paramCount}`;
      params.push(endDate);
    }

    const countQuery = `SELECT COUNT(*) as count ${baseQuery}`;
    const countParams = [...params];
    
    let dataQuery = `
      SELECT 
        call_uuid,
        caller, 
        callee, 
        direction as call_type,
        duration_sec,
        dest_value,
        COALESCE(billed_amount, 0) as billed_amount,
        billed_amount as bill_amount,
        COALESCE(recording_amount, 0) as recording_amount,
        (COALESCE(billed_amount, 0) + COALESCE(recording_amount, 0)) as total_amount,
        dest_type,
        billsec,
        call_status as status,
        recording as has_recording,
        start_time as created_at
      ${baseQuery}
      ORDER BY created_at ASC
    `;

    if (limit && limit !== 'all') {
      paramCount++;
      dataQuery += ` LIMIT $${paramCount}`;
      params.push(limit);

      paramCount++;
      dataQuery += ` OFFSET $${paramCount}`;
      params.push(offset);
    }
    
    try {
      const [countResult, dataResult] = await Promise.all([
        readonlyPool.query(countQuery, countParams),
        readonlyPool.query(dataQuery, params)
      ]);

      return {
        data: dataResult.rows,
        total: parseInt(countResult.rows[0].count)
      };
    } catch (err) {
      throw new Error(`Failed to fetch all CDRs: ${err.message}`);
    }
  }
}

module.exports = CdrService;

const pool = require('../config/database');
const RecordingGateService = require('../services/RecordingGateService');

class Customer {
  // Generate customer ID based on country with global sequence
  static async generateCustomerId(country) {
    try {
      const prefix = country === 'CAD' ? 'C' : 'U';
      
      // Get the highest numeric part from ALL customer_ids (global sequence)
      const query = `
        SELECT customer_id FROM customers 
        WHERE customer_id ~ '^[CU][0-9]+$'
        ORDER BY CAST(SUBSTRING(customer_id FROM 2) AS INTEGER) DESC 
        LIMIT 1;
      `;
      
      const result = await pool.query(query);
      
      let nextNumber = 1;
      if (result.rows.length > 0) {
        const lastId = result.rows[0].customer_id;
        const currentNumber = parseInt(lastId.substring(1));
        nextNumber = currentNumber + 1;
      }
      
      // Format with leading zeros (4 digits)
      const customerId = `${prefix}${String(nextNumber).padStart(4, '0')}`;
      return customerId;
    } catch (err) {
      throw new Error(`Failed to generate customer ID: ${err.message}`);
    }
  }

  // Check if email already exists
  static async emailExists(email) {
    try {
      const query = 'SELECT customer_id FROM customers WHERE admin_email = $1;';
      const result = await pool.query(query, [email]);
      return result.rows.length > 0;
    } catch (err) {
      throw new Error(`Failed to check email: ${err.message}`);
    }
  }

  // Auto-assign currency based on country
  static assignCurrency(country) {
    return country === 'CAD' ? 'cad' : 'usd';
  }

  static async create(customerData) {
    const {
      fr_cusid,
      customer_type,
      company_name,
      company_tax_id,
      first_name,
      last_name,
      admin_email,
      phone,
      address_st,
      city,
      state,
      country,
      credit_limit = 0,
      customer_id: provided_id
    } = customerData;

    const client = await pool.connect();

    try {
      // Start transaction
      await client.query('BEGIN');

      // Check for duplicate email
      const emailExists = await this.emailExists(admin_email);
      if (emailExists) {
        await client.query('ROLLBACK');
        throw new Error("Email already exists");
      }

      // Use provided ID or generate one
      const customer_id = provided_id || await this.generateCustomerId(country);

      // Assign currency based on country
      const currency = this.assignCurrency(country);

      // Insert customer
      const customerQuery = `
        INSERT INTO customers (
          customer_id, fr_cusid, customer_type, company_name, company_tax_id,
          first_name, last_name, admin_email, phone, address_st, city, state, country, currency
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        RETURNING *;
      `;

      const customerValues = [
        customer_id, fr_cusid || customer_id, customer_type, company_name || null, company_tax_id || null,
        first_name || null, last_name || null, admin_email, phone || null, address_st, city, state, country, currency
      ];

      const customerResult = await client.query(customerQuery, customerValues);
      const customer = customerResult.rows[0];

      // Insert wallet with uppercase currency for wallet table
      const initialBalance = 0;
      const initialFreeSeconds = 0;

      const walletQuery = `
        INSERT INTO customer_wallets (
          customer_id, currency, fiat_balance, free_seconds, credit_limit
        ) VALUES ($1, $2, $3, $4, $5)
        RETURNING *;
      `;

      const walletValues = [
        customer_id, 
        currency.toUpperCase(), 
        initialBalance, 
        initialFreeSeconds, 
        Number(credit_limit) || 0
      ];

      const walletResult = await client.query(walletQuery, walletValues);
      const wallet = walletResult.rows[0];

      // Commit transaction
      await client.query('COMMIT');

      await RecordingGateService.sync(customer_id, wallet);

      // Standard call rate cards are intentionally not assigned in the
      // recording-only billing model. Keep a null field for API compatibility.
      return {
        ...customer,
        wallet,
        ratecard: null
      };
    } catch (err) {
      await client.query('ROLLBACK');
      throw new Error(`Failed to create customer: ${err.message}`);
    } finally {
      client.release();
    }
  }

  static async findById(customerId) {
    const query = 'SELECT * FROM customers WHERE customer_id = $1;';
    try {
      const result = await pool.query(query, [customerId]);
      return result.rows[0] || null;
    } catch (err) {
      throw new Error(`Failed to fetch customer: ${err.message}`);
    }
  }

  static async findByEmail(email) {
    const query = 'SELECT * FROM customers WHERE admin_email = $1;';
    try {
      const result = await pool.query(query, [email]);
      return result.rows[0] || null;
    } catch (err) {
      throw new Error(`Failed to fetch customer: ${err.message}`);
    }
  }

  static async getAll() {
    const query = 'SELECT * FROM customers ORDER BY created_at DESC;';
    try {
      const result = await pool.query(query);
      return result.rows;
    } catch (err) {
      throw new Error(`Failed to fetch customers: ${err.message}`);
    }
  }

  static async update(customerId, updates) {
    const allowedFields = [
      'customer_type', 'company_name', 'company_tax_id',
      'first_name', 'last_name', 'admin_email', 'phone',
      'address_st', 'city', 'state', 'country'
    ];

    const customerUpdates = {};
    for (const key of allowedFields) {
      if (updates[key] !== undefined) {
        customerUpdates[key] = updates[key];
      }
    }

    let updatedCustomer = null;

    if (Object.keys(customerUpdates).length > 0) {
      const updateFields = Object.keys(customerUpdates)
        .map((key, index) => `${key} = $${index + 1}`)
        .join(', ');

      const values = Object.values(customerUpdates);
      values.push(customerId);

      const query = `
        UPDATE customers
        SET ${updateFields}, updated_at = now()
        WHERE customer_id = $${values.length}
        RETURNING *;
      `;

      try {
        const result = await pool.query(query, values);
        updatedCustomer = result.rows[0] || null;
      } catch (err) {
        throw new Error(`Failed to update customer: ${err.message}`);
      }
    } else {
      updatedCustomer = await this.findById(customerId);
    }

    if (!updatedCustomer) {
      return null;
    }

    // Update credit limit if provided
    if (updates.credit_limit !== undefined && updates.credit_limit !== null && !isNaN(Number(updates.credit_limit))) {
      try {
        const walletQuery = `
          UPDATE customer_wallets 
          SET credit_limit = $1, updated_at = NOW() 
          WHERE customer_id = $2 
          RETURNING *;
        `;
        const walletResult = await pool.query(walletQuery, [Number(updates.credit_limit), customerId]);
        await RecordingGateService.sync(customerId, walletResult.rows[0]);
      } catch (walletErr) {
        console.error(`Failed to update credit limit for ${customerId}:`, walletErr.message);
      }
    }

    const wallet = await this.getWallet(customerId);
    return {
      ...updatedCustomer,
      credit_limit: wallet?.credit_limit ?? 0,
      wallet
    };
  }

  static async delete(customerId) {
    const query = 'DELETE FROM customers WHERE customer_id = $1 RETURNING *;';
    try {
      const result = await pool.query(query, [customerId]);
      return result.rows[0] || null;
    } catch (err) {
      throw new Error(`Failed to delete customer: ${err.message}`);
    }
  }

  static async getWallet(customerId) {
    const query = 'SELECT * FROM customer_wallets WHERE customer_id = $1;';
    try {
      const result = await pool.query(query, [customerId]);
      if (!result.rows[0]) return null;
      
      const w = result.rows[0];
      const fiat = Number(w.fiat_balance || 0);
      const limit = Number(w.credit_limit || 0);
      const used = Number(w.credit_used || 0);
      const availablePurchasingPower = fiat + Math.max(0, limit - used);

      return {
        ...w,
        fiat_balance: fiat,
        credit_limit: limit,
        credit_used: used,
        available_purchasing_power: availablePurchasingPower
      };
    } catch (err) {
      throw new Error(`Failed to fetch customer wallet: ${err.message}`);
    }
  }
}

module.exports = Customer;

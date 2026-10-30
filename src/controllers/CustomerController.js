const CustomerModel = require('../models/Customer');

class CustomerController {
  // Create a new customer
  static async createCustomer(req, res) {
    try {
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
        credit_limit,
        customer_id
      } = req.body;

      const customer = await CustomerModel.create({
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
        credit_limit,
        customer_id
      });

      // For demo accounts, ensure subscription is initialized
      const isDemo = (customer_id && customer_id.startsWith('T')) || (fr_cusid && fr_cusid.startsWith('T'));
      if (isDemo) {
        try {
          console.log(`[Demo] Initializing subscription for ${customer.customer_id}`);
          const SubscriptionModel = require('../models/Subscription');
          const existingSubs = await SubscriptionModel.findByCustomerId(customer.customer_id);
          if (existingSubs.length === 0) {
            await SubscriptionModel.create({
              customer_id: customer.customer_id,
              plan_id: 'demo_plan_35',
              status: 'active',
              override_balance_check: true
            });
            console.log(`[Demo] Auto-subscription created for ${customer.customer_id}`);
          }
        } catch (subErr) {
          console.error(`[CustomerController] Failed to create auto-subscription for demo ${customer.customer_id}:`, subErr.message);
        }
      }

      // Trigger cache refresh in the billing system
      try {
        const cacheUrl = process.env.BILLING_CACHE_REFRESH_URL;

        if (cacheUrl) {
          console.log(`[CustomerController] Triggering cache refresh at ${cacheUrl}`);
          const http = cacheUrl.startsWith('https') ? require('https') : require('http');
          const req = http.request(cacheUrl, { method: 'POST' }, (res) => {
            console.log(`[CustomerController] Cache refresh response: ${res.statusCode}`);
            res.on('data', () => {}); // Consume data to free memory
          });
          req.on('error', (err) => {
            console.error('[CustomerController] Cache refresh failed:', err.message);
          });
          req.end();
        }
      } catch (err) {
        console.error('Error triggering cache refresh:', err.message);
      }

      res.status(201).json({
        success: true,
        message: 'Customer created successfully',
        data: customer
      });
    } catch (error) {
      console.error('[CustomerController] Create failed:', error);
      res.status(400).json({
        success: false,
        message: error.message
      });
    }
  }

  // Get customer by ID
  static async getCustomer(req, res) {
    try {
      const { customerId } = req.params;
      const customer = await CustomerModel.findById(customerId);

      if (!customer) {
        return res.status(404).json({
          success: false,
          message: 'Customer not found'
        });
      }

      const wallet = await CustomerModel.getWallet(customerId);

      res.status(200).json({
        success: true,
        data: {
          ...customer,
          credit_limit: wallet?.credit_limit ?? 0,
          wallet
        }
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }

  // Update customer
  static async updateCustomer(req, res) {
    try {
      const { customerId } = req.params;
      const updateData = req.body;

      const customer = await CustomerModel.update(customerId, updateData);

      if (!customer) {
        return res.status(404).json({
          success: false,
          message: 'Customer not found'
        });
      }

      res.status(200).json({
        success: true,
        message: 'Customer updated successfully',
        data: customer
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }

  // Delete customer
  static async deleteCustomer(req, res) {
    return res.status(410).json({ success: false, message: 'Customer removal must be requested from the PBX archive workflow to coordinate telecom teardown and preserve history' });
  }

  // Get all customers
  static async getAllCustomers(req, res) {
    try {
      const customers = await CustomerModel.getAll();

      res.status(200).json({
        success: true,
        data: customers
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }

  // Get credit limit
  static async getCreditLimit(req, res) {
    try {
      const { customerId } = req.params;
      const WalletService = require('../services/WalletService');
      const wallet = await WalletService.getBalance(customerId);

      if (!wallet) {
        return res.status(404).json({
          success: false,
          message: 'Wallet not found for customer'
        });
      }

      res.status(200).json({
        success: true,
        data: {
          customer_id: customerId,
          credit_limit: parseFloat(wallet.credit_limit || 0),
          currency: wallet.currency
        }
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }

  // Update credit limit
  static async updateCreditLimit(req, res) {
    try {
      const { customerId } = req.params;
      const { credit_limit } = req.body;
      
      if (credit_limit === undefined || isNaN(Number(credit_limit))) {
        return res.status(400).json({
          success: false,
          message: 'Valid credit_limit is required'
        });
      }

      const WalletService = require('../services/WalletService');
      const wallet = await WalletService.updateCreditLimit(customerId, Number(credit_limit));

      res.status(200).json({
        success: true,
        message: 'Credit limit updated successfully',
        data: wallet
      });
    } catch (error) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    }
  }
}

module.exports = CustomerController;

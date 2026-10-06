require('dotenv').config();

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const pool = require('./config/database');
const routes = require('./routes');
const AssetService = require('./services/AssetService');
const BillingService = require('./services/BillingService');
const paymentRoutes = require('./routes/paymentRoutes');

const app = express();
const PORT = process.env.PORT || 5000;

// View engine setup
app.set('view engine', 'ejs');
app.set('views', './src/views');

// Static files
app.use(express.static('./src/public'));

// Middleware
app.use(helmet({
  contentSecurityPolicy: false, // Disable CSP for development
}));
app.use(morgan('combined'));
app.use(cors());

// Parse JSON for all other routes
app.use(express.json({
  verify: (req, res, buf) => {
    req.rawBody = buf;
  }
}));
app.use(express.urlencoded({ extended: true }));

// Dedicated trace for Stripe webhook requests
app.use('/api/payments/webhook/stripe', (req, res, next) => {
  console.log('[server] Incoming webhook request:', {
    method: req.method,
    path: req.originalUrl,
    ip: req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown',
    contentType: req.headers['content-type'],
    contentLength: req.headers['content-length'],
    hasStripeSignature: !!req.headers['stripe-signature'],
    rawBodyLength: req.rawBody?.length || 0
  });
  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'OK', message: 'Subscription Billing API is running' });
});

// Database connection check
app.get('/api/db-check', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({
      status: 'Connected to database',
      timestamp: result.rows[0].now
    });
  } catch (err) {
    res.status(500).json({
      status: 'Database connection failed',
      error: err.message
    });
  }
});

// Admin dashboard
app.get('/', (req, res) => {
  res.render('index');
});

// Payment routes
app.use('/api/payments', paymentRoutes);

// Use all routes
app.use('/', routes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    success: false,
    message: 'Route not found'
  });
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({
    message: 'An error occurred',
    error: process.env.NODE_ENV === 'development' ? err.message : 'Internal Server Error'
  });
});

// Initialize services
AssetService.initialize();
BillingService.initialize();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Subscription Billing API running on http://0.0.0.0:${PORT}`);
  console.log(`✓ Environment: ${process.env.NODE_ENV || 'development'}`);
});

// Reload trigger for new port binding
module.exports = app;

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const express = require('express');

test('SubscriptionLifecycle source code does not reference customer_ratecard', () => {
  const lifecycleSource = fs.readFileSync(
    path.join(__dirname, '../src/services/SubscriptionLifecycle.js'),
    'utf8'
  );
  assert.equal(
    lifecycleSource.includes('customer_ratecard'),
    false,
    'SubscriptionLifecycle should not execute any queries against customer_ratecard'
  );
});

test('subscriptionController source code does not reference targetRateCardId or ratecard_pro', () => {
  const subControllerSource = fs.readFileSync(
    path.join(__dirname, '../src/controllers/subscriptionController.js'),
    'utf8'
  );
  assert.equal(
    subControllerSource.includes('targetRateCardId'),
    false,
    'subscriptionController should not set targetRateCardId'
  );
  assert.equal(
    subControllerSource.includes('ratecard_pro'),
    false,
    'subscriptionController should not default to ratecard_pro'
  );
});

test('Main router exposes rec-rate-cards and retires standard rate-cards', () => {
  const router = require('../src/routes/index');
  const app = express();
  app.use(router);

  // Inspect registered layer paths
  const registeredPaths = [];
  router.stack.forEach((layer) => {
    if (layer.route && layer.route.path) {
      registeredPaths.push(layer.route.path);
    } else if (layer.name === 'router' && layer.regexp) {
      registeredPaths.push(layer.regexp.toString());
    }
  });

  const hasStandardRateCards = registeredPaths.some(p => 
    (p.includes('rate-cards') || p.includes('ratecards')) && !p.includes('rec-rate-cards')
  );
  const hasRecRateCards = registeredPaths.some(p => p.includes('rec-rate-cards'));

  assert.equal(hasStandardRateCards, false, 'Standard /api/rate-cards route should not be registered');
  assert.equal(hasRecRateCards, true, 'Recording /api/rec-rate-cards route MUST remain registered');
});

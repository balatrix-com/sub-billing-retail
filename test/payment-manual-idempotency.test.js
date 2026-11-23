const test = require('node:test');
const assert = require('node:assert/strict');
const pool = require('../src/config/database');
const PaymentService = require('../src/services/PaymentService');
const RecordingGateService = require('../src/services/RecordingGateService');

test('a repeated manual payment credits once and rejects conflicting details', async () => {
  const originalConnect = pool.connect;
  const originalCredit = PaymentService.creditWallet;
  const originalSync = RecordingGateService.sync;
  let payment;
  let credits = 0;
  let transactions = 0;
  const client = {
    release() {},
    async query(sql, params) {
      if (sql.includes('SELECT customer_id FROM customers')) return { rows: [{ customer_id: 'U1047' }] };
      if (sql.includes('INSERT INTO payments (')) {
        if (payment) return { rows: [] };
        payment = {
          payment_id: params[1], customer_id: params[3], amount: params[4],
          currency: params[5], status: params[6], payment_method: params[7], gateway: params[8],
        };
        return { rows: [payment] };
      }
      if (sql.includes('SELECT payment_id, customer_id, amount')) return { rows: [payment] };
      if (sql.includes('INSERT INTO payment_transactions')) transactions++;
      return { rows: [] };
    },
  };
  pool.connect = async () => client;
  PaymentService.creditWallet = async () => { credits++; return { balance: 100 }; };
  RecordingGateService.sync = async () => {};
  const input = { customer_id: 'U1047', amount: 100, currency: 'usd', tx_id: 'onboarding-funding:U1047', payment_type: 'pbx_admin_adjust' };
  try {
    const first = await PaymentService.recordManualPayment(input);
    const retry = await PaymentService.recordManualPayment(input);
    assert.equal(retry.payment_id, first.payment_id);
    assert.equal(retry.replayed, true);
    assert.equal(credits, 1);
    assert.equal(transactions, 1);
    await assert.rejects(PaymentService.recordManualPayment({ ...input, amount: 101 }), /different payment/);
    assert.equal(credits, 1);
  } finally {
    pool.connect = originalConnect;
    PaymentService.creditWallet = originalCredit;
    RecordingGateService.sync = originalSync;
  }
});

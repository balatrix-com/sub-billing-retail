const router = require('express').Router();
const pool = require('../config/database');
const { createSubscriptionLifecycle, serviceAuth } = require('../services/SubscriptionLifecycle');
const lifecycle = createSubscriptionLifecycle(pool);
router.use(serviceAuth);
const handle = fn => async (req, res) => {
  try { res.json({ success: true, data: await fn(req) }); }
  catch (e) { res.status(e.statusCode || 500).json({ success: false, message: e.message }); }
};
router.get('/customer/:customerId', handle(r => lifecycle.list(r.params.customerId)));
router.post('/activate', handle(r => lifecycle.activate(r.body, r.body.actor_id)));
router.post('/quote', handle(r => lifecycle.quote(r.body)));
router.get('/:id', handle(r => lifecycle.subscription(r.params.id)));
router.get('/:id/assets', handle(r => lifecycle.assets(r.params.id)));
router.get('/:id/history', handle(r => lifecycle.history(r.params.id)));
router.post('/:id/renew', handle(r => lifecycle.renew(r.params.id, r.body.operation_key, r.body.actor_id)));
router.patch('/:id/auto-renew', handle(r => lifecycle.autoRenew(r.params.id, r.body.auto_renew, r.body.actor_id)));
router.post('/:id/freeze', handle(r => lifecycle.transition(r.params.id, 'freeze', r.body.actor_id)));
router.post('/:id/cancel', handle(r => lifecycle.transition(r.params.id, 'cancel', r.body.actor_id)));
router.post('/:id/release', handle(r => lifecycle.transition(r.params.id, 'release', r.body.actor_id)));
router.post('/assets/reassign', handle(r => lifecycle.move(r.body, r.body.actor_id)));
router.post('/monitoring/assign', handle(r => lifecycle.assignMonitoring(r.body, r.body.actor_id)));
router.post('/monitoring/unassign', handle(r => lifecycle.unassignMonitoring(r.body.user_id, r.body.customer_id)));
router.post('/monitoring/transfer', handle(r => lifecycle.transferMonitoring(r.body, r.body.actor_id)));
router.post('/extensions/assign',handle(r=>lifecycle.assignExtension(r.body,r.body.actor_id)));
router.post('/extensions/unassign',handle(r=>lifecycle.unassignExtension(r.body,r.body.actor_id)));
module.exports = router;

const router = require('express').Router();
const { serviceAuth } = require('../services/SubscriptionLifecycle');
const { createCustomerLifecycle } = require('../services/CustomerLifecycleService');
const lifecycle = createCustomerLifecycle(require('../config/database'));
router.use(serviceAuth);
router.post('/:customerId/archive', async (req, res) => {
  try { res.json({ success: true, data: await lifecycle.archive(req.params.customerId, req.body.actor_id) }); }
  catch (error) { res.status(error.statusCode || 500).json({ success: false, message: error.message }); }
});
router.post('/:customerId/release-numbers', async (req, res) => {
  if (req.body.provider_confirmed !== true || !String(req.body.reason || '').trim()) return res.status(400).json({ message: 'Provider confirmation and reason are required' });
  try { res.json({ success: true, data: await lifecycle.releaseNumbers(req.params.customerId, req.body.actor_id, req.body.reason) }); }
  catch (error) { res.status(error.statusCode || 500).json({ success: false, message: error.message }); }
});
module.exports = router;

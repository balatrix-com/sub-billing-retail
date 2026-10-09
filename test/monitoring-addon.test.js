const test = require('node:test');
const assert = require('node:assert/strict');
const { isPlanLimitedAddon } = require('../src/services/PlanLimitedAddons');

test('monitoring extension bundles remain purchasable', () => {
  assert.equal(isPlanLimitedAddon({ addon_id: 'addon_monitor_2', resource_type: 'monitoring_extension' }), false);
  assert.equal(isPlanLimitedAddon({ addon_id: 'monitoring_extension_1', resource_type: 'monitoring_extension' }), false);
});

test('number bundles remain excluded', () => {
  assert.equal(isPlanLimitedAddon({ addon_id: 'addon_tfn_1', resource_type: 'tfn' }), true);
  assert.equal(isPlanLimitedAddon({ addon_id: 'addon_did_1', resource_type: 'did' }), true);
});

ALTER TABLE subscription_addons_catalog
  DROP CONSTRAINT IF EXISTS subscription_addons_catalog_resource_type_check;

ALTER TABLE subscription_addons_catalog
  ADD CONSTRAINT subscription_addons_catalog_resource_type_check
  CHECK (resource_type IN ('extension', 'tfn', 'did', 'supervisor', 'storage', 'monitoring_extension'));

function isPlanLimitedAddon(addon) {
  const type = String(addon?.resource_type || addon?.catalog_resource_type || addon?.addon_type || '').toUpperCase();
  if (['TFN', 'DID', 'TOLL_FREE', 'TOLL-FREE', 'NUMBER', 'NUMBERS'].includes(type)) {
    return true;
  }
  return /(^|[_-])(TFN|DID|TOLL|NUMBER)([_-]|$)/i.test(String(addon?.addon_id || ''));
}

module.exports = { isPlanLimitedAddon };

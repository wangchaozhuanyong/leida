const { preferenceDefaults } = require('./model');
const preferenceKey = 'moyao-mini-preferences', readKey = 'moyao-mini-read-notices';
function createPreferences(wxApi) {
  let preferences = { ...preferenceDefaults }, read = [], error = '';
  try {
    const stored = wxApi.getStorageSync(preferenceKey), seen = wxApi.getStorageSync(readKey);
    if (stored && typeof stored === 'object') Object.keys(preferenceDefaults).forEach(key => { if (typeof stored[key] === 'boolean') preferences[key] = stored[key]; });
    if (Array.isArray(seen)) read = [...new Set(seen.filter(value => typeof value === 'string'))];
  } catch (_) { error = '未能读取本机设置，本次使用默认偏好。'; }
  return {
    snapshot() { return { preferences: { ...preferences }, read: read.slice(), error }; },
    set(key, value) {
      if (!Object.prototype.hasOwnProperty.call(preferenceDefaults, key) || typeof value !== 'boolean') return;
      preferences = { ...preferences, [key]: value };
      try { wxApi.setStorageSync(preferenceKey, preferences); error = ''; } catch (_) { error = '本机无法保存设置，本次打开仍可使用。'; }
    },
    markRead(ids) {
      read = [...new Set([...read, ...ids.filter(value => typeof value === 'string')])];
      try { wxApi.setStorageSync(readKey, read); error = ''; } catch (_) { error = '已读记录只在本次打开期间生效。'; }
    }
  };
}
module.exports = { createPreferences };

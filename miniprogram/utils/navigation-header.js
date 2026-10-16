function navigationMetrics(wxApi) {
  let windowInfo = {};
  let menu = null;
  try {
    if (typeof wxApi.getWindowInfo === 'function') windowInfo = wxApi.getWindowInfo() || {};
  } catch (_) { /* Older clients can still provide the legacy window metrics. */ }
  if (!Number.isFinite(windowInfo.statusBarHeight)) {
    try {
      if (typeof wxApi.getSystemInfoSync === 'function') windowInfo = wxApi.getSystemInfoSync() || windowInfo;
    } catch (_) { /* Keep the title usable when the device API is unavailable. */ }
  }
  try {
    if (typeof wxApi.getMenuButtonBoundingClientRect === 'function') menu = wxApi.getMenuButtonBoundingClientRect();
  } catch (_) { /* A missing capsule measurement uses a reserved right inset. */ }
  const width = Number.isFinite(windowInfo.windowWidth) && windowInfo.windowWidth > 0 ? windowInfo.windowWidth : 375;
  const statusBarHeight = Number.isFinite(windowInfo.statusBarHeight) && windowInfo.statusBarHeight >= 0 ? windowInfo.statusBarHeight : 20;
  const validMenu = menu && Number.isFinite(menu.left) && menu.left > width / 2 && menu.left < width
    && Number.isFinite(menu.top) && menu.top >= statusBarHeight && menu.top - statusBarHeight <= 24
    && Number.isFinite(menu.height) && menu.height > 0 && menu.height <= 48;
  const barHeight = validMenu ? Math.max(44, Math.min(64, menu.height + (menu.top - statusBarHeight) * 2)) : 44;
  const rightInset = validMenu ? width - menu.left + 12 : 108;
  return { statusBarHeight, barHeight, totalHeight: statusBarHeight + barHeight, rightInset };
}

function returnFromPage(wxApi, pages, complete) {
  const home = () => wxApi.switchTab({ url: '/pages/home/index', complete });
  if (Array.isArray(pages) && pages.length > 1) {
    wxApi.navigateBack({ delta: 1, success: complete, fail: home });
  } else home();
}

module.exports = { navigationMetrics, returnFromPage };

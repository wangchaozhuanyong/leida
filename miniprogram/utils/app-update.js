/** Offer a downloaded WeChat package once; never interrupt a hidden app. */
function createAppUpdate(wxApi) {
  let ready = false, visible = false, prompted = false;
  let manager;
  const offer = () => {
    if (!ready || !visible || prompted || typeof wxApi.showModal !== 'function') return;
    prompted = true;
    try {
      wxApi.showModal({
        title: '发现新版本',
        content: '新版已下载完成，是否重启小程序更新？建议先完成当前操作。',
        confirmText: '立即更新', cancelText: '稍后',
        success(result) {
          if (result.confirm && visible) {
            try { manager.applyUpdate(); } catch (_) { /* Keep the current package usable. */ }
          }
        },
      });
    } catch (_) { /* Updating is optional; navigation must remain usable. */ }
  };
  try {
    manager = typeof wxApi.getUpdateManager === 'function' ? wxApi.getUpdateManager() : undefined;
    if (manager && typeof manager.onUpdateReady === 'function' && typeof manager.applyUpdate === 'function') {
      manager.onUpdateReady(() => { ready = true; offer(); });
    }
  } catch (_) { /* Older WeChat versions may not expose the manager. */ }
  return { show() { visible = true; offer(); }, hide() { visible = false; } };
}
module.exports = { createAppUpdate };

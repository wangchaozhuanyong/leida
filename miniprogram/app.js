const config = require('./config');
const { createClient } = require('./utils/client');
const { createPreferences } = require('./utils/preferences');
const { createTransport } = require('./utils/transport');
const { createWechatReader } = require('./utils/wechat');
const { createEntryNavigation } = require('./utils/entry-navigation');
App({
  onLaunch() { this.entryNavigation=createEntryNavigation(wx);this.client = createClient({ wxApi: wx, config }); this.preferences = createPreferences(wx); this.publicApi=createTransport(wx,config); this.wechat=createWechatReader({wxApi:wx,config}); },
  onShow(options) { this.entryNavigation?.show(options);if (this.client) void this.client.start(); },
  onHide() { this.entryNavigation?.hide();if (this.client) this.client.stop(); }
});

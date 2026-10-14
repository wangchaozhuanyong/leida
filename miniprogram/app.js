const config = require('./config');
const { createClient } = require('./utils/client');
const { createPreferences } = require('./utils/preferences');
const { createTransport } = require('./utils/transport');
const { createWechatReader } = require('./utils/wechat');
App({
  onLaunch() { this.client = createClient({ wxApi: wx, config }); this.preferences = createPreferences(wx); this.publicApi=createTransport(wx,config); this.wechat=createWechatReader({wxApi:wx,config}); },
  onShow() { if (this.client) void this.client.start(); },
  onHide() { if (this.client) this.client.stop(); }
});

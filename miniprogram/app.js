const config = require('./config');
const { createClient } = require('./utils/client');
const { createPreferences } = require('./utils/preferences');
const { createTransport } = require('./utils/transport');
const { createWechatReader } = require('./utils/wechat');
const { createEntryNavigation } = require('./utils/entry-navigation');
const { createAppUpdate } = require('./utils/app-update');
App({
  onLaunch() { this.appUpdate=createAppUpdate(wx);this.entryNavigation=createEntryNavigation(wx);this.client = createClient({ wxApi: wx, config }); this.preferences = createPreferences(wx); this.publicApi=createTransport(wx,config); this.wechat=createWechatReader({wxApi:wx,config}); },
  onShow(options) { this.entryNavigation?.show(options);this.appUpdate?.show();if (this.client) void this.client.start();if(this.wechat)void this.wechat.warmup(); },
  onHide() { this.appUpdate?.hide();this.entryNavigation?.hide();if (this.client) this.client.stop(); }
});

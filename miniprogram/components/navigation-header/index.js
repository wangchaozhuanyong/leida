const { navigationMetrics, returnFromPage } = require('../../utils/navigation-header');

Component({
  properties: {
    title: { type: String, value: '模钥重置雷达' },
    brand: { type: Boolean, value: false },
    back: { type: Boolean, value: false }
  },
  data: navigationMetrics(typeof wx === 'undefined' ? {} : wx),
  lifetimes: {
    attached() { this.updateMetrics(); }
  },
  pageLifetimes: {
    resize() { this.updateMetrics(); }
  },
  methods: {
    updateMetrics() {
      const next = navigationMetrics(wx);
      if (Object.keys(next).some(key => this.data[key] !== next[key])) this.setData(next);
    },
    goBack() {
      if (this._returning) return;
      this._returning = true;
      returnFromPage(wx, getCurrentPages(), () => { this._returning = false; });
    }
  }
});

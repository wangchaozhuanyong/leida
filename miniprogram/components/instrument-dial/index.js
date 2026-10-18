const { drawDial } = require('../../utils/dial');
Component({
  properties: { model: Object },
  lifetimes: {
    attached() { this._alive = true; },
    ready() { this.draw(); },
    detached() { this._alive = false; this._drawing = false; }
  },
  pageLifetimes: {
    show() { this._drawKey = undefined; this.draw(); },
    resize() { this._drawKey = undefined; this.draw(); }
  },
  observers: { model() { this.draw(); } },
  methods: {
    draw() {
      if (!this._alive || this._drawing || !this.data.model || typeof wx.createSelectorQuery !== 'function') return;
      const model=this.data.model;
      const geometryKey=JSON.stringify(model.scheduled?[model.startAngle,model.endAngle,model.sweep]:['idle']);
      if(this._drawKey===geometryKey)return;
      this._drawing = true;
      wx.createSelectorQuery().in(this).select('#dial-face').fields({ node: true, size: true }, result => {
        this._drawing = false;
        if (!this._alive || !result || !result.node || !result.width) return;
        const canvas = result.node, size = result.width;
        const info = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : {};
        const ratio = Math.max(1, Math.min(3, info.pixelRatio || 1));
        canvas.width = size * ratio; canvas.height = size * ratio;
        const ctx = canvas.getContext('2d'); if (!ctx) return;
        ctx.scale(ratio, ratio); drawDial(ctx, size, this.data.model);this._drawKey=geometryKey;
      }).exec();
    }
  }
});

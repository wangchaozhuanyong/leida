const { drawNeuralArt, drawNeuralSphere } = require('../../utils/neural-art');

Component({
  properties: {
    variant: { type: String, value: 'radar' },
    active: { type: Boolean, value: true, observer() { this.syncMotion(); } }
  },
  data: { ready: false },
  lifetimes: {
    attached() {
      this._alive = true;
      this._pageVisible = true;
      this._inViewport = false;
      this._time = 1.4;
    },
    ready() {
      if (!this._alive) return;
      this.observeVisibility();
      this.prepareCanvas();
    },
    detached() {
      this._alive = false;
      this.stopMotion();
      if (this._intersection) this._intersection.disconnect();
      this._intersection = null;
      this._canvas = null;
      this._context = null;
    }
  },
  pageLifetimes: {
    show() { this._pageVisible = true; if (this._canvas) this.prepareCanvas(); },
    hide() { this._pageVisible = false; this.stopMotion(); },
    resize() { this.prepareCanvas(); }
  },
  methods: {
    observeVisibility() {
      if (!this._alive || typeof this.createIntersectionObserver !== 'function') return;
      try {
        this._intersection = this.createIntersectionObserver({ thresholds: [0] });
        this._intersection.relativeToViewport().observe('.neural-art', entry => {
          if (!this._alive) return;
          this._inViewport = entry.intersectionRatio > 0;
          this.syncMotion();
        });
      } catch (_) { this._inViewport = false; }
    },
    prepareCanvas() {
      if (!this._alive || this._failed || this._measuring || typeof this.createSelectorQuery !== 'function') return;
      this._measuring = true;
      try {
        const query = this.createSelectorQuery();
        query.select('#neural-canvas').fields({ node: true, size: true });
        query.select('#motion-preference').boundingClientRect();
        query.exec(results => {
          this._measuring = false;
          if (!this._alive || this._failed) return;
          const result = results && results[0];
          if (!result || !result.node || !result.width || !result.height) return;
          try {
            this.stopMotion();
            const canvas = result.node;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;
            const info = typeof wx.getWindowInfo === 'function' ? wx.getWindowInfo() : {};
            const ratio = Math.max(1, Math.min(1.6, info.pixelRatio || 1));
            const sphere=this.properties?.variant==='sphere';
            const width = Math.min(sphere?480:170, result.width), height = Math.min(sphere?360:170, result.height);
            const pixelWidth = Math.round(width * ratio), pixelHeight = Math.round(height * ratio);
            if (canvas.width !== pixelWidth || canvas.height !== pixelHeight || canvas !== this._canvas) {
              canvas.width = pixelWidth; canvas.height = pixelHeight;
              ctx.scale(ratio, ratio);
            }
            this._canvas = canvas; this._context = ctx;
            this._width = width; this._height = height;
            // Read the CSS preference once per show/resize; no per-frame bridge work.
            this._motionAllowed = !!(results[1] && results[1].width > 0);
            this.drawArt(ctx, width, height);
            if (!this.data.ready) this.setData({ ready: true });
            this.syncMotion();
          } catch (_) { this.onCanvasError(); }
        });
      } catch (_) { this._measuring = false; this.onCanvasError(); }
    },
    drawArt(ctx, width, height) {
      const draw=this.properties?.variant==='sphere'?drawNeuralSphere:drawNeuralArt;
      draw(ctx,width,height,this._time);
    },
    syncMotion() {
      this.stopMotion();
      if (this.properties?.active===false || !this._alive || this._failed || !this._pageVisible || !this._inViewport || !this._motionAllowed || !this._canvas || typeof this._canvas.requestAnimationFrame !== 'function' || typeof this._canvas.cancelAnimationFrame !== 'function') return;
      const generation = this._motionGeneration;
      this._lastFrame = null;
      const loop = timestamp => {
        if (generation !== this._motionGeneration) return;
        this._frame = null;
        if (this.properties?.active===false || !this._alive || !this._pageVisible || !this._inViewport || !this._motionAllowed || this._failed) return;
        const now = Number.isFinite(timestamp) ? timestamp : Date.now();
        if (this._lastFrame == null || now - this._lastFrame >= 1000 / 24) {
          this._time += this._lastFrame != null ? Math.min((now - this._lastFrame) / 1000, .1) : 0;
          this._lastFrame = now;
          try { this.drawArt(this._context, this._width, this._height); }
          catch (_) { this.onCanvasError(); return; }
        }
        try { this._frame = this._canvas.requestAnimationFrame(loop); }
        catch (_) { this.onCanvasError(); }
      };
      try { this._frame = this._canvas.requestAnimationFrame(loop); }
      catch (_) { this.onCanvasError(); }
    },
    stopMotion() {
      this._motionGeneration = (this._motionGeneration || 0) + 1;
      if (this._frame != null && this._canvas && typeof this._canvas.cancelAnimationFrame === 'function') {
        try { this._canvas.cancelAnimationFrame(this._frame); }
        catch (_) { /* A disposed native canvas must not block navigation. */ }
      }
      this._frame = null;
    },
    onCanvasError() {
      this._failed = true;
      this.stopMotion();
      if (this._alive && this.data.ready) this.setData({ ready: false });
    }
  }
});

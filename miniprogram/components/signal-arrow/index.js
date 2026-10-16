Component({
  data: { animated: false },
  lifetimes: {
    attached() { this._alive = true; this._pageVisible = true; this._inViewport = false; this._motionAllowed = false; },
    ready() {
      if (!this._alive) return;
      try {
        this._intersection = this.createIntersectionObserver({ thresholds: [0] });
        this._intersection.relativeToViewport().observe('.signal-arrow', entry => {
          if (!this._alive) return;
          this._inViewport = entry.intersectionRatio > 0; this.syncMotion();
        });
      } catch (_) { this._inViewport = false; }
      this.readPreference();
    },
    detached() { this._alive = false; if (this._intersection) this._intersection.disconnect(); this._intersection = null; }
  },
  pageLifetimes: {
    show() { this._pageVisible = true; this.readPreference(); },
    hide() { this._pageVisible = false; this.syncMotion(); },
    resize() { this.readPreference(); }
  },
  methods: {
    readPreference() {
      if (!this._alive || typeof this.createSelectorQuery !== 'function') return;
      const generation = (this._preferenceGeneration || 0) + 1; this._preferenceGeneration = generation;
      try {
        this.createSelectorQuery().select('#motion-preference').boundingClientRect().exec(result => {
          if (!this._alive || generation !== this._preferenceGeneration) return;
          this._motionAllowed = !!(result && result[0] && result[0].width > 0); this.syncMotion();
        });
      } catch (_) { this._motionAllowed = false; this.syncMotion(); }
    },
    syncMotion() {
      if (!this._alive) return;
      const animated = !!(this._pageVisible && this._inViewport && this._motionAllowed);
      if (animated !== this.data.animated) this.setData({ animated });
    }
  }
});

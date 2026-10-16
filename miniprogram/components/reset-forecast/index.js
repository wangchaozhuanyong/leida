const { cadenceModel } = require('../../utils/cadence');
Component({
  properties: { forecasts: { type: Object, value: null }, now: { type: String, value: '' }, snapshot: { type: Object, value: null }, initialTarget: { type: String, value: 'automatic_reset' } },
  data: { target: 'automatic_reset', view: cadenceModel(null, '') },
  observers: { 'forecasts,now,snapshot': function () { this.refresh(); }, initialTarget: function (target) { if (['automatic_reset','banked_reset'].includes(target) && target !== this.data.target) this.setData({ target }, () => this.refresh()); } },
  methods: {
    refresh() {
      const snapshot=this.properties.snapshot, target=snapshot && snapshot.target || this.data.target;
      const view = cadenceModel(this.properties.forecasts, this.properties.now, target, snapshot);
      const signature = JSON.stringify(view);
      if (signature !== this._signature) { this._signature = signature; this.setData({ view }); }
    },
    selectTarget(event) {
      const target = event.currentTarget.dataset.target;
      if (!['automatic_reset', 'banked_reset'].includes(target) || target === this.data.target) return;
      this.setData({ target }, () => this.refresh());
    },
    openDetails() { wx.navigateTo({ url: `/pages/methodology/index?target=${this.data.target}` }); }
  }
});

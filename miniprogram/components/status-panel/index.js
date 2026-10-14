Component({ options: { styleIsolation: 'apply-shared' }, properties: { loading: Boolean, unconfigured: Boolean, error: String }, methods: { retry() { this.triggerEvent('retry'); } } });

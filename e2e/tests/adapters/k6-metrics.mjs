export const metricInstances = [];

export class Rate {
  constructor(name) {
    this.name = name;
    this.values = [];
    metricInstances.push(this);
  }
  add(val) {
    this.values.push(Boolean(val));
  }
  rate() {
    if (this.values.length === 0) return 0;
    return this.values.filter(Boolean).length / this.values.length;
  }
}

export class Trend {
  constructor(name) {
    this.name = name;
    this.values = [];
    metricInstances.push(this);
  }
  add(val) {
    this.values.push(Number(val));
  }
}

export class Counter {
  constructor(name) {
    this.name = name;
    this.count = 0;
    this.values = [];
    metricInstances.push(this);
  }
  add(val = 1) {
    this.count += Number(val);
    this.values.push(Number(val));
  }
}

export class Gauge {
  constructor(name) {
    this.name = name;
    this.value = 0;
    metricInstances.push(this);
  }
  add(val) {
    this.value = Number(val);
  }
}

export function resetMetricsState() {
  for (const m of metricInstances) {
    if (Array.isArray(m.values)) m.values.length = 0;
    if (typeof m.count === 'number') m.count = 0;
    if (typeof m.value === 'number') m.value = 0;
  }
}

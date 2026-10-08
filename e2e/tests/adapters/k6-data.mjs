export class SharedArray {
  constructor(name, fn) {
    this.name = name;
    const res = fn();
    return Array.isArray(res) ? res : [];
  }
}

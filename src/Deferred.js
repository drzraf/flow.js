/**
 * Small idempotent deferred helper.
 */
export default class Deferred {
  constructor() {
    this.settled = false;
    this.promise = new Promise((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
  }

  resolve(value) {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this._resolve(value);
  }

  reject(error) {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this._reject(error);
  }
}

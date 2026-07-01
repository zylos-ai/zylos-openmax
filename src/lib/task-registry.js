export default class TaskRegistry {
  #tasks = new Map();

  /**
   * @param {string} name        Unique task identifier
   * @param {Function} fn        Callback invoked on each tick
   * @param {number} intervalMs  Milliseconds between ticks
   * @param {object} [opts]
   * @param {number}  [opts.delay=0]         Delay before the first tick (ms)
   * @param {boolean} [opts.runOnStart=false] Execute fn immediately when started (after delay)
   */
  register(name, fn, intervalMs, { delay = 0, runOnStart = false } = {}) {
    if (this.#tasks.has(name)) throw new Error(`task "${name}" already registered`);
    this.#tasks.set(name, { fn, intervalMs, delay, runOnStart, timer: null, delayTimer: null });
  }

  start(name) {
    const t = this.#tasks.get(name);
    if (!t || t.timer || t.delayTimer) return;
    const begin = () => {
      t.delayTimer = null;
      if (t.runOnStart) t.fn();
      t.timer = setInterval(t.fn, t.intervalMs);
      t.timer.unref?.();
    };
    if (t.delay > 0) {
      t.delayTimer = setTimeout(begin, t.delay);
      t.delayTimer.unref?.();
    } else {
      begin();
    }
  }

  startAll() {
    for (const name of this.#tasks.keys()) this.start(name);
  }

  stop(name) {
    const t = this.#tasks.get(name);
    if (!t) return;
    if (t.delayTimer) { clearTimeout(t.delayTimer); t.delayTimer = null; }
    if (t.timer) { clearInterval(t.timer); t.timer = null; }
  }

  stopAll() {
    for (const name of this.#tasks.keys()) this.stop(name);
  }

  list() {
    return [...this.#tasks.entries()].map(([name, t]) => ({
      name,
      intervalMs: t.intervalMs,
      running: !!(t.timer || t.delayTimer),
    }));
  }
}

const clock = { now: Date.now, setTimeout, clearTimeout };

function snapshotKey(snapshot) {
  return JSON.stringify([snapshot.sessionID, snapshot.revision, snapshot.model, snapshot.prefix]);
}

/** Owns debounce/cooldown and deferred manual requests, not prediction state. */
export class PredictionScheduler {
  #options;
  #controller;
  #snapshot;
  #run;
  #onFailure;
  #onUnavailable;
  #clock;
  #timer;
  #manual;
  #key;
  #nextRequestAt = 0;
  #serial = 0;
  #disposed = false;

  constructor({ options, controller, snapshot, run, onFailure, onUnavailable, timer = clock }) {
    this.#options = options;
    this.#controller = controller;
    this.#snapshot = snapshot;
    this.#run = run;
    this.#onFailure = onFailure;
    this.#onUnavailable = onUnavailable;
    this.#clock = timer;
  }

  schedule(current) {
    if (this.#disposed) return;
    const blank = current.prefix === '' && current.context !== '[]' && !current.running;
    if (!this.#options.automatic || !this.#controller.needsRequest || !current.requestable
      || (!blank && Array.from(current.prefix.trim()).length < 3)) {
      this.cancelAutomatic();
      return;
    }
    const key = snapshotKey(current);
    if (this.#timer !== undefined && this.#key === key) return;
    this.cancelAutomatic();
    this.#key = key;
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = undefined;
      this.#run(() => {
        const latest = this.#snapshot();
        this.#controller.update(latest);
        if (snapshotKey(latest) !== key || !this.#controller.needsRequest) return;
        this.#request(latest, false);
      });
    }, Math.max(this.#options.debounceMs, this.#nextRequestAt - this.#clock.now()));
  }

  requestManual(sessionID) {
    if (this.#disposed) return;
    this.cancelAutomatic();
    this.#clock.clearTimeout(this.#manual);
    // Let the command palette close and return focus to the prompt first.
    this.#manual = this.#clock.setTimeout(() => {
      this.#manual = undefined;
      this.#run(() => {
        const current = this.#snapshot();
        if (!current.requestable || current.sessionID !== sessionID) {
          this.#onUnavailable();
          return;
        }
        this.#request(current, true);
      });
    }, 100);
  }

  #request(snapshot, manual) {
    this.#nextRequestAt = this.#clock.now() + this.#options.cooldownMs;
    const source = `${manual ? 'manual' : 'prediction'}:${++this.#serial}`;
    void this.#controller.request(snapshot, source, { manual }).catch(this.#onFailure);
  }

  cancelAutomatic() {
    this.#clock.clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  dispose() {
    this.#disposed = true;
    this.cancelAutomatic();
    this.#clock.clearTimeout(this.#manual);
    this.#manual = undefined;
  }
}

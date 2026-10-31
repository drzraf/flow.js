import Deferred from './Deferred.js';

/**
 * One upload session per Flow instance.
 *
 * A session runs one or more cycles. Each cycle reads chunks in order through
 * an async generator and uploads them with a bounded worker pool. There is no
 * recursive scheduling from XHR or event handlers.
 */
export default class UploadSession {
  constructor(flow) {
    this.flow = flow;
    this.finished = false;
    this.cancelled = false;
    this.started = false;
    this._deferred = new Deferred();
    this.promise = this._deferred.promise;
    this._controller = null;
    this._cycle = null;
    this._wake = null;
  }

  start() {
    if (!this.started) {
      this.started = true;
      this.flow.emit('upload-start');
      this._run().catch(error => this._finishWithError(error));
    }
    return this.promise;
  }

  resume() {
    if (this.finished) {
      return this.flow.upload();
    }
    this.flow.emit('upload-resume');
    this.wake();
    return this.promise;
  }

  cancel() {
    if (this.finished) {
      return;
    }
    this.cancelled = true;
    this._abort();
    this.wake();
  }

  wake() {
    if (this._wake) {
      const wake = this._wake;
      this._wake = null;
      wake.resolve();
    }
  }

  _abort() {
    if (this._controller) {
      this._controller.abort();
    }
  }

  async _run() {
    while (!this.finished) {
      if (this.cancelled) {
        return this._finish('cancelled');
      }
      if (this._hasRunnablePending()) {
        await this._runCycle();
        continue;
      }
      if (!this._hasPending()) {
        return this._finish('complete');
      }
      // All remaining chunks belong to paused files. Wait for resume/addFiles.
      await this._waitForWork();
    }
  }

  _hasPending() {
    for (const file of this.flow.files) {
      for (const chunk of file.chunks) {
        if (chunk.state === 'pending') {
          return true;
        }
      }
    }
    return false;
  }

  _hasRunnablePending() {
    for (const file of this.flow.files) {
      if (file.paused || file.error || file.cancelled) {
        continue;
      }
      for (const chunk of file.chunks) {
        if (chunk.state === 'pending') {
          return true;
        }
      }
    }
    return false;
  }

  _waitForWork() {
    if (!this._wake) {
      this._wake = new Deferred();
    }
    return this._wake.promise;
  }

  _runCycle() {
    const controller = new AbortController();
    this._controller = controller;
    const signal = controller.signal;
    const iterator = this._readQueue(signal);
    const concurrency = Math.max(1, this.flow.opts.simultaneousUploads || 1);
    const workers = [];
    for (let i = 0; i < concurrency; i++) {
      workers.push(this._worker(iterator, signal));
    }
    this._cycle = Promise.all(workers).finally(() => {
      if (this._controller === controller) {
        this._controller = null;
      }
      this._cycle = null;
    });
    return this._cycle;
  }

  async _worker(iterator, signal) {
    for await (const item of iterator) {
      if (signal.aborted || this.cancelled) {
        return;
      }
      try {
        await item.chunk.upload(item.payload, signal);
      } catch (error) {
        if (signal.aborted || this.cancelled) {
          return;
        }
        item.chunk.state = 'error';
        item.chunk._responseText = String(error && error.message || error);
        item.chunk.uploadState.resolve({status: 'error', message: item.chunk._responseText});
        item.chunk.event('error', item.chunk._responseText);
      }
    }
  }

  async *_readQueue(signal) {
    for (const chunk of this._nextChunks()) {
      if (signal.aborted || this.cancelled) {
        return;
      }
      const file = chunk.fileObj;
      if (file.paused || file.error || file.cancelled) {
        continue;
      }

      chunk.state = 'reading';
      let payload;
      try {
        payload = await chunk.read(signal);
      } catch (error) {
        if (signal.aborted || this.cancelled) {
          chunk.state = 'pending';
          return;
        }
        chunk.state = 'error';
        chunk._responseText = String(error && error.message || error);
        chunk.uploadState.resolve({status: 'error', message: chunk._responseText});
        chunk.event('error', chunk._responseText);
        continue;
      }

      if (signal.aborted || this.cancelled) {
        chunk.state = 'pending';
        return;
      }
      if (file.paused || file.error || file.cancelled) {
        chunk.state = 'pending';
        continue;
      }

      yield {chunk, payload};
    }
  }

  *_nextChunks() {
    const seen = new Set();

    if (this.flow.opts.prioritizeFirstAndLastChunk) {
      for (const file of this.flow.files) {
        if (file.paused || file.error || file.cancelled) {
          continue;
        }
        const first = file.chunks[0];
        const last = file.chunks[file.chunks.length - 1];
        if (first && first.state === 'pending' && !seen.has(first)) {
          seen.add(first);
          yield first;
        }
        if (last && last !== first && last.state === 'pending' && !seen.has(last)) {
          seen.add(last);
          yield last;
        }
      }
    }

    for (const file of this.flow.files) {
      if (file.paused || file.error || file.cancelled) {
        continue;
      }
      for (const chunk of file.chunks) {
        if (chunk.state === 'pending' && !seen.has(chunk)) {
          seen.add(chunk);
          yield chunk;
        }
      }
    }
  }

  _summary(status) {
    return {
      status,
      files: this.flow.files.map(file => ({
        file,
        status: file.error ? 'error' : (file.isComplete() ? 'complete' : 'pending'),
        error: file.errorMessage || null,
        uploadedBytes: file.sizeUploaded()
      })),
      uploadedBytes: this.flow.sizeUploaded(),
      totalBytes: this.flow.getSize()
    };
  }

  _finish(status) {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this._abort();
    this.wake();
    const summary = this._summary(status);
    if (status === 'complete') {
      this.flow.emit('complete');
    }
    this._deferred.resolve(summary);
  }

  _finishWithError(error) {
    if (this.finished) {
      return;
    }
    this.finished = true;
    this._abort();
    this.wake();
    this.flow.emit('error', error && error.message || String(error));
    this._deferred.resolve(Object.assign(this._summary('complete'), {
      status: 'error',
      error
    }));
  }
}

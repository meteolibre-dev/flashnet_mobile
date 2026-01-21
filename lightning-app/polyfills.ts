import { Buffer } from 'buffer';
import 'text-encoding';

// 1. Buffer
if (typeof global.Buffer === 'undefined') {
  global.Buffer = Buffer;
}

// 2. TextDecoder / TextEncoder
if (typeof global.TextDecoder === 'undefined') {
  const TextEncodingPolyfill = require('text-encoding');
  global.TextDecoder = TextEncodingPolyfill.TextDecoder;
  global.TextEncoder = TextEncodingPolyfill.TextEncoder;
}

// 3. Worker (GeoTIFF checks for this)
if (typeof global.Worker === 'undefined') {
  // @ts-ignore
  global.Worker = class Worker {
    constructor() {
      console.warn('Web Workers are not supported in this environment. GeoTIFF operations will run on the main thread.');
    }
    postMessage() {}
    terminate() {}
    addEventListener() {}
    removeEventListener() {}
  };
}

// 4. FinalizationRegistry
if (typeof global.FinalizationRegistry === 'undefined') {
  global.FinalizationRegistry = class FinalizationRegistry {
    constructor(cleanupCallback) {}
    register(target, heldValue, unregisterToken) {}
    unregister(unregisterToken) {}
  };
}

// 5. WeakRef
if (typeof global.WeakRef === 'undefined') {
  global.WeakRef = class WeakRef {
    constructor(target) {
      this.target = target;
    }
    deref() {
      return this.target;
    }
  };
}

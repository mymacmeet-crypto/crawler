'use strict';
// CloseEvent was added to Node.js in v23.  Older v22 builds lack it, which
// breaks simple-cdp (a dependency of single-file-cli).  This polyfill is
// --require'd into the SingleFile child process to paper over the gap.
if (typeof CloseEvent === 'undefined') {
  global.CloseEvent = class CloseEvent extends Event {
    constructor(type, init = {}) {
      super(type, init);
      this.wasClean = init.wasClean ?? false;
      this.code    = init.code    ?? 0;
      this.reason  = init.reason  ?? '';
    }
  };
}

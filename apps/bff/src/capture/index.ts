/** Capture module (02 §3.2): the only place, with gateway/, that may open network connections. */
export { CaptureHttp, EgressDeniedError, type CapturingHttpOptions } from './capturing-http.js';
export { PollCoalescer } from './coalesce.js';
export { CookieJar } from './cookie-jar.js';
export { generateSelfToken, isSelfCall, SELF_HEADER, stripSelfHeader } from './self-token.js';

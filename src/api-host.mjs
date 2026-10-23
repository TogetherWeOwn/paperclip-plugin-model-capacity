/**
 * Build-time Paperclip API origin pin for the upstream-mode actuator: the
 * ONLY origin that may receive the actuator's API key.
 *
 * Same rule as the lane host (lane-host.mjs): the public default is a
 * non-routable placeholder (RFC 2606 `.invalid` never resolves), so a build
 * that does not pin a real origin cannot send the key anywhere; upstream
 * enforce then fails like any network error and shadow mode (which sends
 * nothing) is unaffected. A deployment pins its public Paperclip origin by
 * replacing THIS ONE FILE when it builds the package. The plugin host refuses
 * loopback and private addresses for plugin fetches, so this is the public
 * origin, not 127.0.0.1.
 */
export const PAPERCLIP_API_BASE_URLS = Object.freeze([
  'https://paperclip-api.invalid',
]);

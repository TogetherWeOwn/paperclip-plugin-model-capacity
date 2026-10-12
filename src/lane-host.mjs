/**
 * Build-time lane host pin: the ONLY origin that may carry the lane key.
 *
 * The public default is a non-routable placeholder (RFC 2606 `.invalid`
 * never resolves), so a build that does not pin a real host cannot send
 * the key anywhere; lane reads fail like any network error and /health
 * reports `degraded`. A deployment pins its host by replacing THIS ONE
 * FILE when it builds the package (see README, "Lane host pin"). The pin
 * stays compile-time on purpose: config can name only an origin listed
 * here, so no config write can redirect the lane key.
 */
export const LANE_BASE_URLS = Object.freeze([
  'https://lane-host.invalid',
]);

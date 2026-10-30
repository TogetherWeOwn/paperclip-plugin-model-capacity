/** Upstream Paperclip MIT schema fixture. Source: packages/shared/src/trust-policy.ts
 * Checkout: /home/ubuntu/build/fs4/upstream-seams-chatpool @ e2cfdc7e0c7a97349846150be4036b033087fe92
 * Source SHA256: 875ee172003a0ea4a9d4eeabc4ea191eadcca096dbeac394bd4a6f94bd0aff39
 * Exact declaration excerpts from tsc-emitted dist/trust-policy.js; unused exports/imports omitted.
 * Schema declarations are unchanged. Includes the transitive dependencies of
 * updateAgentSchema, wakeAgentSchema, resetAgentSessionSchema,
 * putToolConnectionInstallsSchema and updateToolConnectionSchema.
 */
export const TRUST_PRESETS = ["standard", "low_trust_review"];
export const LOW_TRUST_REVIEW_PRESET = "low_trust_review";
export const LOW_TRUST_REVIEW_PRESET_VERSION = 1;
export const LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION = "quarantine";

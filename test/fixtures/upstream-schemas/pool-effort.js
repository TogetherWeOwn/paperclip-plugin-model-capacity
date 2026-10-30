/** Upstream Paperclip MIT effort-folding characterization fixture.
 * Target: e2cfdc7e0c7a97349846150be4036b033087fe92 + chatpool patch.
 * The patch does not change the extracted effort fold or adapter helpers.
 * packages/adapters/codex-local/src/index.ts SHA256 e25b4ce995a8324380062099010b8607fda968110c7619f77ed5f41bcca60d1d
 * packages/adapters/claude-local/src/index.ts SHA256 fe70b7760bcb89a7ea9ba501012c75a08c364c1f9a8e722b408933430c20f09a
 * packages/adapters/grok-local/src/index.ts SHA256 8d0156f2cc82115cbbc87184b054e86c339a2d318085498cc2409a27e6f637f9
 * server/src/services/ai-connection-router.ts SHA256 ec2164fcaa83b3cac19281eeaca14a122d7de0d6dcd5e06932589be39d693762
 * Adapter helper bodies and the router effort-fold block are verbatim, types
 * removed with esbuild 0.28.2 (loader: ts, format: esm). Only the last function
 * wrapper is test glue: it provides the already-validated config/profile.
 * This fixture does NOT perform native harness validation, install a plugin,
 * or prove an end-to-end staging gate. Refresh on upstream contract changes.
 */
function normalizeModelId(model) {
  return typeof model === "string" ? model.trim() : "";
}
const CODEX_LOCAL_MODEL_ALIASES = {
  "gpt-5.6": "gpt-5.6-sol"
};
const CODEX_LOCAL_DEFAULT_REASONING_EFFORTS = [
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh"
];
const CODEX_LOCAL_MAX_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max"
];
const CODEX_LOCAL_ULTRA_REASONING_EFFORTS = [
  ...CODEX_LOCAL_MAX_REASONING_EFFORTS,
  "ultra"
];
function normalizeCodexModel(model) {
  const normalizedModel = normalizeModelId(model);
  return CODEX_LOCAL_MODEL_ALIASES[normalizedModel] ?? normalizedModel;
}
function codexLocalReasoningEffortsForModel(model) {
  const normalizedModel = normalizeCodexModel(model);
  switch (normalizedModel) {
    case "gpt-6-astra":
    case "gpt-6.1-sol":
    case "gpt-6-sol":
    case "gpt-5.6-sol":
    case "gpt-5.6-terra":
      return CODEX_LOCAL_ULTRA_REASONING_EFFORTS;
    case "gpt-6-luna":
    case "gpt-5.6-luna":
      return CODEX_LOCAL_MAX_REASONING_EFFORTS;
    default:
      return CODEX_LOCAL_DEFAULT_REASONING_EFFORTS;
  }
}
function claudeLocalReasoningEffortsForModel(model) {
  const id = model.trim().replace(/\[1m\]$/, "").replace(/^(?:(?:us|eu|apac|global)\.)?anthropic\./, "");
  if (/^claude-haiku-/.test(id)) return [];
  if (/^claude-(?:opus-5(?:-5)?|opus-4-[78]|sonnet-5(?:-5)?|fable-5(?:-1)?)$/.test(id)) {
    return ["low", "medium", "high", "xhigh", "max"];
  }
  if (/^claude-(?:opus|sonnet)-4-6(?:-v1)?$/.test(id)) return ["low", "medium", "high", "max"];
  return ["low", "medium", "high"];
}
function grokLocalReasoningEffortsForModel(model) {
  return model.trim() === "grok-4.7" || model.trim() === "grok-4.6" ? ["low", "medium", "high", "xhigh"] : ["low", "medium", "high"];
}
function foldPoolMemberEffort(member, adapterType, overrides = {}) {
  const provider = member.binding.provider, profile = member.profile;
  const config = { provider: profile.provider, ...profile.acpxAgent ? { acpxAgent: profile.acpxAgent } : {}, model: profile.model };
  const notes = [];
  const model = String(config.model);
  const efforts = provider === "openai" ? codexLocalReasoningEffortsForModel(model) : provider === "anthropic" ? claudeLocalReasoningEffortsForModel(model) : provider === "xai" ? grokLocalReasoningEffortsForModel(model) : [];
  const effortKey = adapterType === "paperclip_runner" ? profile.provider === "codex" || profile.provider === "acpx" && profile.acpxAgent === "claude" ? "modelReasoningEffort" : null : provider === "anthropic" ? "effort" : provider === "xai" ? "reasoningEffort" : provider === "openai" ? "modelReasoningEffort" : "variant";
  const requested = overrides.modelReasoningEffort ?? overrides.reasoningEffort ?? overrides.effort ?? overrides.variant;
  const effort = typeof requested === "string" && efforts.includes(requested) && effortKey ? requested : profile.effort && efforts.includes(profile.effort) && effortKey ? profile.effort : null;
  if (requested && requested !== effort) notes.push("Effort override is unavailable for this member; using its default.");
  if (effort && effortKey) config[effortKey] = effort;
  return { config, notes };
}
export {
  claudeLocalReasoningEffortsForModel,
  codexLocalReasoningEffortsForModel,
  foldPoolMemberEffort,
  grokLocalReasoningEffortsForModel,
  normalizeCodexModel
};

# Model Capacity plugin (v0.1.0, shadow)

Picks the model (and effort) for every run and sets how many agent runs
should run in parallel, so every account's allowance is used before it
resets. Two inputs: CLIProxy burn telemetry and Artificial Analysis
free-API quality data. Purely deterministic -- no classifiers, no vetoes.

**v0.1.0 = SHADOW.** The plugin holds no `run.model.resolve` capability,
so it changes no runs. Every minute it records what it *would* have
decided (`GET /shadow`), plus the concurrency target (`GET /capacity`)
and per-account ladders (`GET /ladder`). The resolve hook is implemented
behind the manifest variant (`buildManifest({ modelResolve: true })`);
v0.2.0 enables enforcement by switching to that variant.

## How it decides (per account, per run)

1. **Arms** (model x effort) the account's provider can serve, joined to
   the AA snapshot by slug. Ladders never cross providers.
2. **Quality Q** = z-scored AA composite with null-renormalization
   (missing metrics are excluded, never zero-imputed).
3. **Pareto filter** drops dominated arms; survivors are rungs L0..Ln.
   Low-coverage arms (< 0.6) cap at one rung above cheapest; incumbents
   keep rungs unless a strictly-dominating newcomer appears.
4. **Pacing pointer** tracks a linear burn schedule (deadband 2%, at most
   one rung per 10 min). The 5h guard overrides everything: above 80% the
   account floors and sheds load, rejoining below 50%.
5. **Per-run signals only**: role floor/ceiling, +1 rung per retry,
   test-fail +1, rate-limit reroutes, context-window filter. `defer`
   happens only when no account has headroom.
6. **Concurrency** `C* = sum((R_a/T_a)/E_a[mix]) x D` (Little's law),
   capped by the 5h guard and a 75 hard ceiling.

Sol/Luna decisions carry `CLAUDE_CODE_MAX_CONTEXT_TOKENS=260000` to stay
under the 272k price cliff. The auto-compact watermark key name is
provisional (no such key was found in the host codebase) and configurable
via `contextCaps.autoCompactEnvKey` (null omits it).

## Configuration

See `config.example.json`. Secrets are Paperclip `secret_ref` objects,
resolved at call time and never stored:

- `aa.apiKeySecretRef` -- existing company secret
  `ARTIFICIALANALYSIS_API_KEY` (free tier) fits here.
- `cliproxy.managementKeySecretRef` -- **no suitable secret exists yet.**
  The client key (`cliproxy/agent/api-key`) is inference-transport only
  and cannot call management endpoints; the lane key
  (`cliproxy-usage-lane-key`) reads sanitized telemetry files, not
  CLIProxy. Placing the management key as a Paperclip secret is a
  security-sensitive owner decision (that key can read provider
  credentials in clear). Until then the plugin runs degraded: no live
  reads, ladders frozen, shadow records the gap.

The CLIProxy client only ever issues `GET /v0/management/auth-files`
and `POST /v0/management/api-call` with an allowlisted usage URL
(Anthropic oauth/usage, Codex wham/usage). Reset-consuming endpoints are
blocked in code and covered by the allowlist test.

## Layout

- `src/manifest.mjs` -- shadow manifest + `buildManifest` variant flag
- `src/cliproxy.mjs`, `src/aa.mjs` -- edge clients (pure + guards)
- `src/arms.mjs`, `src/quality.mjs`, `src/ladder.mjs` -- ladder math
- `src/pacing.mjs`, `src/decide.mjs`, `src/concurrency.mjs` -- control
- `src/shadow.mjs` -- bounded shadow ring
- `src/plugin.mjs` -- worker wiring; `src/worker.mjs` -- entrypoint
- `test/` -- `node --test`, no build step: `npm test`

## Open questions

- CLIProxy management-key placement (owner decision, see above), and
  whether `http://cliproxy:8317` is reachable from the plugin worker
  network (configurable via `cliproxy.baseUrl`).
- Verify the AA `omniscience` field direction (currently treated as a
  hallucination rate and negated per spec).
- Per-run burn calibration starts from a configured reference anchor
  (flagged `weak`) until CLIProxy usage deltas per run are observed.

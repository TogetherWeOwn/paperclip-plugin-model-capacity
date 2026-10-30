/** Upstream Paperclip MIT schema fixture. Source: packages/shared/src/ai-provider-routing.ts
 * Checkout: /home/ubuntu/build/fs4/upstream-seams-chatpool @ e2cfdc7e0c7a97349846150be4036b033087fe92
 * Source SHA256: 0fc7d0381fd8e388ea40c49786b1cdd1bab2937cd423e3a9a693136be29884c2
 * Copied from its tsc-emitted dist/ai-provider-routing.js (types removed, source map omitted).
 * Kept portable because Node cannot resolve source .js specifiers to .ts files.
 * No schema modifications. Refresh from the source checkout when upstream changes.
 */
import { z } from "zod";
/** Value-free routing stored on the connection, never supplied by an agent binding. */
export const aiProviderRoutingSchema = z
    .object({
    kind: z.enum(["openrouter", "bedrock", "gateway", "local"]),
    protocol: z.enum(["responses", "messages", "chat", "bedrock"]),
    baseUrl: z.string().trim().max(2048).optional(),
    auth: z
        .enum(["bearer", "api_key", "none"])
        .default("bearer"),
    region: z
        .string()
        .regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/)
        .optional(),
    models: z
        .array(z
        .object({
        id: z.string().trim().min(1).max(256),
        label: z.string().trim().max(160).optional(),
    })
        .strict())
        .max(200)
        .default([]),
})
    .strict()
    .superRefine((route, ctx) => {
    const invalid = (message) => ctx.addIssue({ code: "custom", message });
    if (route.kind === "bedrock") {
        if (route.protocol !== "bedrock" ||
            !route.region ||
            route.auth !== "bearer" ||
            route.baseUrl)
            invalid("Bedrock requires a region and a Bedrock API key.");
    }
    else if (route.protocol === "bedrock" ||
        route.region)
        invalid("AWS settings require Bedrock.");
    if (route.kind === "openrouter" &&
        (route.baseUrl || route.auth !== "bearer"))
        invalid("OpenRouter uses its official endpoint and an API key.");
    if (route.auth === "api_key" && route.protocol !== "messages")
        invalid("API-key header authentication requires Anthropic Messages.");
    if (route.kind === "gateway" || route.kind === "local") {
        try {
            const url = new URL(route.baseUrl ?? "");
            const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
            if (url.username ||
                url.password ||
                url.search ||
                url.hash ||
                (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)))
                throw new Error();
            if (route.kind === "local" && !loopback)
                invalid("A local endpoint must use localhost or a loopback address.");
        }
        catch {
            invalid("Enter an HTTPS base URL without credentials, query parameters, or a fragment. Local endpoints may use HTTP.");
        }
    }
});
export function aiRoutingHarness(adapter, provider, acpxAgent) {
    if (adapter !== "paperclip_runner")
        return adapter;
    if (provider === "acpx" && acpxAgent === "copilot")
        return "copilot_runtime";
    const runner = provider === "acpx" && ["claude", "grok", "pi"].includes(String(acpxAgent))
        ? acpxAgent
        : provider;
    return ({
        claude: "claude_local",
        codex: "codex_local",
        opencode: "opencode_local",
        grok: "grok_local",
        pi: "pi_local",
    }[String(runner)] ?? "unsupported");
}
export function isAiRoutingCompatible(route, harness) {
    if (route.kind === "bedrock")
        return harness === "claude_local";
    if (route.kind === "openrouter")
        return [
            "claude_local",
            "codex_local",
            "opencode_local",
            "pi_local",
            "hermes_local",
        ].includes(harness);
    if (route.protocol === "responses")
        return harness === "codex_local";
    if (route.protocol === "messages")
        return harness === "claude_local";
    return ["opencode_local", "hermes_local"].includes(harness);
}
export function aiRoutingBaseUrl(route, harness) {
    return route.kind === "openrouter"
        ? `https://openrouter.ai/api${harness === "claude_local" ? "" : "/v1"}`
        : (route.baseUrl ?? "").replace(/\/+$/, "");
}
export function aiRoutingModel(route, harness, model) {
    if (!model || (harness !== "opencode_local" && !(harness === "pi_local" && route.kind === "openrouter")))
        return model;
    const prefix = route.kind === "openrouter" ? "openrouter" : "paperclip";
    return model.startsWith(`${prefix}/`) ? model : `${prefix}/${model}`;
}
/** Catalog identity is derived from routing, including accounts saved before these rows existed. */
export function aiConnectionCatalogSlug(provider, routing) {
    if (routing?.kind === "gateway") {
        return routing.protocol === "messages" ? "messages-api"
            : routing.protocol === "chat" ? "chat-completions-api" : "responses-api";
    }
    return routing?.kind ?? provider;
}
/** Direct catalog setup presets; legacy gateway links still open their existing setup. */
export function aiProviderSetupPreset(source) {
    switch (source) {
        case "responses-api": return { provider: "gateway", protocol: "responses", label: "Responses API" };
        case "messages-api": return { provider: "gateway", protocol: "messages", label: "Messages API" };
        case "chat-completions-api": return { provider: "gateway", protocol: "chat", label: "Chat Completions API" };
        case "google-ai": return { provider: "google" };
        case "google":
        case "openrouter":
        case "bedrock":
        case "gateway":
        case "local": return { provider: source };
        default: return undefined;
    }
}

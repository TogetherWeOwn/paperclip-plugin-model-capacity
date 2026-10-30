/** Upstream Paperclip MIT schema fixture. Source: packages/shared/src/ai-connections.ts
 * Checkout: /home/ubuntu/build/fs4/upstream-seams-chatpool @ e2cfdc7e0c7a97349846150be4036b033087fe92
 * Source SHA256: 7f5ba2b432391a76607cabbc0c6bbde7f53951c7d297a67d5d32aca054d71910
 * Copied from its tsc-emitted dist/ai-connections.js (types removed, source map omitted).
 * Kept portable because Node cannot resolve source .js specifiers to .ts files.
 * No schema modifications. Refresh from the source checkout when upstream changes.
 */
import { z } from "zod";
import { aiProviderRoutingSchema, aiRoutingHarness, isAiRoutingCompatible } from "./ai-provider-routing.js";
/** Runtime authentication is a separate transport, never a tool or channel. */
export const connectionPurposeTransportSchema = z.discriminatedUnion("connectionPurpose", [
    z.object({
        connectionPurpose: z.literal("tool"),
        transport: z.enum(["mcp_remote", "rest_api", "local_stdio"]),
    }),
    z.object({
        connectionPurpose: z.literal("channel"),
        transport: z.enum(["chat_sdk", "rest_api", "voice"]),
        config: z.object({ provider: z.string().optional() }).passthrough().optional(),
    }).refine((connection) => connection.transport === "voice" ? connection.config?.provider === "speko" : connection.transport === "chat_sdk" ? connection.config?.provider !== "speko" : connection.config?.provider === "agentmail", { message: "Channel transport must match its provider: voice for Speko, REST for AgentMail, Chat SDK otherwise", path: ["config", "provider"] }),
    z.object({
        connectionPurpose: z.literal("ai"),
        transport: z.literal("runtime_auth"),
    }),
]);
export const AI_PROVIDERS = [
    "anthropic",
    "openai",
    "openrouter",
    "xai",
    "github",
    "google",
];
export const aiProviderSchema = z.enum(AI_PROVIDERS);
export const aiAuthMethodSchema = z.enum(["subscription", "api_key"]);
const requirement = { provider: aiProviderSchema, method: aiAuthMethodSchema };
export const aiConnectionBindingSchema = z.discriminatedUnion("mode", [
    z.object({
        provider: aiProviderSchema,
        // Retained on the wire for older servers during rolling upgrades. The
        // responsible user's provider default determines the actual run method.
        method: aiAuthMethodSchema,
        mode: z.literal("responsible_user"),
    }).strict(),
    z
        .object({
        ...requirement,
        mode: z.literal("shared"),
        connectionId: z.string().uuid(),
        grantId: z.string().uuid(),
    })
        .strict(),
    z
        .object({
        ...requirement,
        // Explicit personal selection. Human access still applies on every run.
        mode: z.literal("delegated"),
        connectionId: z.string().uuid(),
        grantId: z.string().uuid(),
    })
        .strict(),
]);
export const aiConnectionMetadataSchema = z.object({ ...requirement, routing: aiProviderRoutingSchema.optional() }).strict();
/** Existing integrations only. This table describes compatibility, never routing. */
export const AI_CONNECTION_CAPABILITIES = {
    github: {
        name: "GitHub Copilot",
        methods: { api_key: { adapters: ["copilot_runtime"], envKey: "COPILOT_GITHUB_TOKEN" } },
    },
    google: { name: "Google", methods: { api_key: { adapters: ["gemini_local", "pi_local"], envKey: "GEMINI_API_KEY" } } },
    anthropic: {
        name: "Claude",
        methods: {
            subscription: {
                adapters: ["claude_local"],
                envKey: "CLAUDE_CODE_OAUTH_TOKEN",
            },
            api_key: { adapters: ["claude_local", "pi_local"], envKey: "ANTHROPIC_API_KEY" },
        },
    },
    openai: {
        name: "OpenAI",
        methods: {
            subscription: { adapters: ["codex_local"], envKey: "CODEX_HOME" },
            api_key: { adapters: ["codex_local", "pi_local"], envKey: "OPENAI_API_KEY" },
        },
    },
    openrouter: {
        name: "OpenRouter",
        methods: {
            api_key: { adapters: ["opencode_local", "pi_local"], envKey: "OPENROUTER_API_KEY" },
        },
    },
    xai: {
        name: "Grok",
        methods: {
            subscription: { adapters: ["grok_local"], envKey: "GROK_HOME" },
            api_key: { adapters: ["grok_local"], envKey: "XAI_API_KEY" },
        },
    },
};
export function isAiConnectionCompatible(requirement, adapterType, model, runnerProvider, acpxAgent) {
    adapterType = aiRoutingHarness(adapterType, runnerProvider, acpxAgent);
    if ("routing" in requirement && requirement.routing)
        return requirement.method === "api_key" && isAiRoutingCompatible(requirement.routing, adapterType);
    // A fixed binding contains identity only. The service checks authoritative
    // connection metadata before resolving credentials or running the harness.
    if (adapterType === "pi_local")
        return (requirement.method === "api_key" || ("mode" in requirement && requirement.mode === "responsible_user"))
            && ["openrouter", "openai", "anthropic", "google"].includes(requirement.provider)
            && typeof model === "string" && model.startsWith(`${requirement.provider}/`);
    if ("mode" in requirement && requirement.mode !== "responsible_user" && requirement.method === "api_key")
        return ["claude_local", "codex_local", "opencode_local", "hermes_local", "gemini_local", "grok_local", "copilot_runtime"].includes(adapterType);
    const methods = AI_CONNECTION_CAPABILITIES[requirement.provider].methods;
    const candidates = "mode" in requirement && requirement.mode === "responsible_user"
        ? Object.values(methods)
        : requirement.method ? [methods[requirement.method]] : [];
    return (candidates.some((method) => method?.adapters.includes(adapterType)) &&
        (requirement.provider !== "openrouter" ||
            (typeof model === "string" && model.startsWith("openrouter/"))));
}
export const createAiConnectionSchema = z
    .object({
    ...requirement,
    name: z.string().trim().min(1).max(160),
    ownership: z.enum(["personal", "shared"]),
    routing: aiProviderRoutingSchema.optional(),
    apiKey: z.string().trim().min(1).max(32768).optional(),
    environmentId: z.string().uuid().nullable().optional(),
    loginSessionId: z.string().max(128).optional(),
    connectionId: z.string().uuid().optional(),
    agentIds: z.array(z.string().uuid()).max(1000).default([]),
    allAgents: z.boolean().default(false),
})
    .strict()
    .superRefine((v, ctx) => {
    if (!AI_CONNECTION_CAPABILITIES[v.provider].methods[v.method])
        ctx.addIssue({ code: "custom", message: "Unsupported sign-in method" });
    if (v.routing && (v.method !== "api_key" || (v.routing.kind === "openrouter" && v.provider !== "openrouter") || (v.routing.kind === "bedrock" && v.provider !== "anthropic")))
        ctx.addIssue({ code: "custom", message: "Routing requires the matching provider and API authentication." });
    if (v.routing && ["gateway", "local"].includes(v.routing.kind) && v.provider !== (v.routing.protocol === "messages" ? "anthropic" : "openai"))
        ctx.addIssue({ code: "custom", message: "The provider must match the endpoint’s API format." });
    if (v.routing?.auth === "none") {
        if (v.apiKey || v.loginSessionId)
            ctx.addIssue({ code: "custom", message: "Provide only the selected authentication method." });
        return;
    }
    if (v.method === "api_key"
        ? !v.apiKey || Boolean(v.loginSessionId)
        : !v.loginSessionId || Boolean(v.apiKey)) {
        ctx.addIssue({
            code: "custom",
            message: "Provide exactly the credential for the selected sign-in method",
        });
    }
});
export const aiConnectionLoginIntentSchema = z
    .object({
    provider: z.enum(["anthropic", "openai", "xai"]),
    method: z.literal("subscription"),
    name: z.string().trim().min(1).max(160),
    ownership: z.enum(["personal", "shared"]),
    connectionId: z.string().uuid().optional(),
    agentIds: z.array(z.string().uuid()).max(1000).default([]),
    allAgents: z.boolean().default(false),
})
    .strict();
export const localAiConnectionSchema = aiConnectionLoginIntentSchema.extend({
    localSessionId: z.string().uuid().optional(),
});
export const localAiLoginStartSchema = aiConnectionLoginIntentSchema.extend({ restart: z.boolean().optional() });
/** Preview-era copies of rotating local credentials must be reconnected. */
export function aiSubscriptionNeedsIsolatedLogin(config) {
    const metadata = aiConnectionMetadataSchema.safeParse(config?.ai);
    return metadata.success && metadata.data.method === "subscription" &&
        (metadata.data.provider === "openai" || metadata.data.provider === "xai") &&
        config?.aiIsolatedSubscription !== true;
}

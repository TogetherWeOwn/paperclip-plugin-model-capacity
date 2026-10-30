/** Upstream Paperclip MIT schema fixture. Source: packages/shared/src/ai-connection-router.ts
 * Checkout: /home/ubuntu/build/fs4/upstream-seams-chatpool @ e2cfdc7e0c7a97349846150be4036b033087fe92
 * Source SHA256: 852f9321ec54f7814e46b908c0b245aa304a81178eef741959199b7c8b6ededa
 * Copied from its tsc-emitted dist/ai-connection-router.js (types removed, source map omitted).
 * Kept portable because Node cannot resolve source .js specifiers to .ts files.
 * No schema modifications. Refresh from the source checkout when upstream changes.
 */
import { z } from "zod";
import { aiConnectionBindingSchema } from "./ai-connections.js";
export const aiConnectionRouterBindingSchema = z.object({
    mode: z.literal("router"),
    connectionId: z.string().uuid(),
}).strict();
export const aiRuntimeConnectionBindingSchema = z.union([aiConnectionBindingSchema, aiConnectionRouterBindingSchema]);
export const aiConnectionPoolMemberSchema = z.object({
    id: z.string().uuid(),
    binding: aiConnectionBindingSchema.refine((v) => v.mode !== "responsible_user", "Select an explicit account grant"),
    profile: z.object({
        provider: z.enum(["codex", "acpx", "opencode"]),
        acpxAgent: z.enum(["claude", "grok"]).optional(),
        model: z.string().trim().min(1).max(256),
        effort: z.string().trim().min(1).max(32).optional(),
    }).strict(),
}).strict();
export const aiConnectionPoolConfigSchema = z.object({
    name: z.string().trim().min(1).max(160),
    enabled: z.boolean().default(false),
    mode: z.enum(["round_robin", "usage_aware"]).default("round_robin"),
    thresholdPercent: z.number().int().min(1).max(100).default(90),
    members: z.array(aiConnectionPoolMemberSchema).min(1).max(100),
}).strict().superRefine((v, ctx) => {
    const ids = new Set();
    const grants = new Set();
    const connections = new Set();
    for (const [index, member] of v.members.entries()) {
        const grant = `${member.binding.connectionId}:${member.binding.grantId}`;
        if (ids.has(member.id) || grants.has(grant) || connections.has(member.binding.connectionId))
            ctx.addIssue({ code: "custom", path: ["members", index], message: "Duplicate pool member" });
        ids.add(member.id);
        grants.add(grant);
        connections.add(member.binding.connectionId);
        if (member.profile.provider === "acpx" && !member.profile.acpxAgent)
            ctx.addIssue({ code: "custom", path: ["members", index, "profile"], message: "Choose an ACP harness" });
    }
});
/** Stable, collision-free catalog identity across plugin reinstallations. */
export function aiConnectionRouterSlug(pluginKey) {
    return `ai-router-${Array.from(pluginKey, character => character.charCodeAt(0).toString(16).padStart(2, "0")).join("")}`;
}
export function aiConnectionRouterAppDefinition(pluginKey, descriptor, availability = { available: true }) {
    return {
        schemaVersion: 1, slug: aiConnectionRouterSlug(pluginKey), ...descriptor,
        categories: ["ai"], branding: { logoUrl: "/brands/apps/connection-pool.svg" }, urlPatterns: [],
        aiConnectionRouter: { pluginKey }, availability,
        methods: [],
    };
}
export function aiConnectionRouterPluginKey(connection) {
    const router = connection.config?.aiRouter;
    return router && typeof router === "object" && "pluginKey" in router && typeof router.pluginKey === "string" ? router.pluginKey : null;
}

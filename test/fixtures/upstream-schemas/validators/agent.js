/** Upstream Paperclip MIT schema fixture. Source: packages/shared/src/validators/agent.ts
 * Checkout: /home/ubuntu/build/fs4/upstream-seams-chatpool @ e2cfdc7e0c7a97349846150be4036b033087fe92
 * Source SHA256: 2bdb0c468c5ad8fd75b09841f759259ac46b26c4cfbb8a517f30f740d83a2da6
 * Exact declaration excerpts from tsc-emitted dist/validators/agent.js; unused exports/imports omitted.
 * Schema declarations are unchanged. Includes the transitive dependencies of
 * updateAgentSchema, wakeAgentSchema, resetAgentSessionSchema,
 * putToolConnectionInstallsSchema and updateToolConnectionSchema.
 */
import { objectWithoutDefaults } from "./partial.js";
import { z } from "zod";
import { AGENT_ROLES, AGENT_ICON_NAMES } from "../constants.js";
import { agentAppearanceSchema } from "../agent-appearance.js";
import { agentDesiredSkillSelectionSchema } from "./adapter-skills.js";
import { agentAdapterTypeSchema } from "../adapter-type.js";
import { envConfigSchema } from "./secret.js";
import { aiRuntimeConnectionBindingSchema as aiConnectionBindingSchema } from "../ai-connection-router.js";
import { trustPresetSchema, trustAuthorizationPolicySchema } from "./trust-policy.js";
export const agentPermissionsSchema = z.object({
    // No schema default: the server derives the default (enabled unless the
    // permissions record marks the agent low-trust) when the field is omitted.
    canCreateAgents: z.boolean().optional(),
    canCreateSkills: z.boolean().optional().default(true),
    trustPreset: trustPresetSchema.optional(),
    authorizationPolicy: trustAuthorizationPolicySchema.optional(),
}).catchall(z.unknown());
const adapterConfigSchema = z.record(z.string(), z.unknown()).superRefine((value, ctx) => {
    const envValue = value.env;
    if (envValue === undefined)
        return;
    const parsed = envConfigSchema.safeParse(envValue);
    if (!parsed.success) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "adapterConfig.env must be a map of valid env bindings",
            path: ["env"],
        });
    }
});
export const createAgentInstructionsBundleSchema = z.object({
    entryFile: z.string().trim().min(1).optional(),
    files: z.record(z.string(), z.string()).refine((files) => Object.keys(files).length > 0, {
        message: "instructionsBundle.files must contain at least one file",
    }),
});
export const agentRuntimeConfigSchema = z.object({
    aiConnection: aiConnectionBindingSchema.optional(),
    debug: z.object({
        providerTrace: z.literal("raw").optional(),
    }).strict().optional(),
}).catchall(z.unknown()).superRefine((value, ctx) => {
    if (Object.prototype.hasOwnProperty.call(value, "modelProfiles")) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["modelProfiles"],
            message: "runtimeConfig.modelProfiles is no longer supported",
        });
    }
});
export const createAgentSchema = z.object({
    setupId: z.string().guid().optional(),
    name: z.string().min(1),
    role: z.enum(AGENT_ROLES).optional().default("general"),
    title: z.string().optional().nullable(),
    icon: z.enum(AGENT_ICON_NAMES).optional().nullable(),
    appearance: agentAppearanceSchema.optional(),
    reportsTo: z.string().guid().optional().nullable(),
    capabilities: z.string().optional().nullable(),
    desiredSkills: z.array(agentDesiredSkillSelectionSchema).optional(),
    adapterType: agentAdapterTypeSchema,
    runner: z.enum(["auto", "paperclip", "legacy"]).optional(),
    adapterConfig: adapterConfigSchema.optional().default({}),
    instructionsBundle: createAgentInstructionsBundleSchema.optional(),
    runtimeConfig: agentRuntimeConfigSchema.optional().default({}),
    defaultEnvironmentId: z.string().guid().optional().nullable(),
    budgetMonthlyCents: z.number().int().nonnegative().optional().default(0),
    permissions: agentPermissionsSchema.optional(),
    metadata: z.record(z.string(), z.unknown()).optional().nullable(),
    // The optional stored-session claim from a completed Claude login session. It
    // is the non-secret `storedSessionId`; it carries no token. The agent-create
    // transaction consumes it as the one-time stored-session claim.
    storedSessionId: z.string().min(1).max(256).optional(),
    // The optional apply-existing flag. When true, the caller binds the fixed
    // Claude OAuth token reference to the owner stored value with no new login
    // round trip. The server permits the no-claim bind only for a user actor and
    // only when that owner already has a stored value. It carries no token.
    applyStoredClaudeLogin: z.boolean().optional(),
    // Narrow intent flag set by the onboarding wizard when it hires the very first
    // agent (the chief of staff). It is not an agent column: the server consumes
    // it to seed the server-owned chief-of-staff persona over the agent's entry
    // instruction file instead of the generic default, and honors it only for
    // board-authored requests. Mirrors onboardingFirstTask on issue create.
    onboardingFirstAgent: z.boolean().optional(),
});
export const agentRuntimeSettingsPatchSchema = z.object({
    harness: z.string().min(1),
    model: z.string().trim().min(1).max(512).optional(),
    aiConnection: aiConnectionBindingSchema.optional(),
    expected: z.object({
        model: z.string().nullable(),
        aiConnection: aiConnectionBindingSchema.nullable(),
    }).strict(),
}).strict().refine(value => value.model !== undefined || value.aiConnection !== undefined, {
    message: "Choose a connection or default model to change",
});
export const updateAgentSchema = objectWithoutDefaults(createAgentSchema.omit({ permissions: true, onboardingFirstAgent: true, setupId: true }))
    .partial()
    .extend({
    permissions: z.never().optional(),
    runtimeSettings: agentRuntimeSettingsPatchSchema.optional(),
    replaceAdapterConfig: z.boolean().optional(),
    expectedConfigurationRevision: z.string().regex(/^[a-f0-9]{64}$/).optional(),
    status: z.enum(["paused", "idle", "terminated"]).optional(),
    spentMonthlyCents: z.never().optional(),
});
export const wakeAgentSchema = z.object({
    source: z
        .enum(["timer", "assignment", "on_demand", "automation"])
        .optional()
        .default("on_demand"),
    triggerDetail: z.enum(["manual", "ping", "callback", "system"]).optional(),
    reason: z.string().optional().nullable(),
    /** Select an exact failed run; its chat request and actor are server-derived. */
    failedRunId: z.string().uuid().optional(),
    payload: z.record(z.string(), z.unknown()).optional().nullable(),
    idempotencyKey: z.string().optional().nullable(),
    forceFreshSession: z.preprocess((value) => (value === null ? undefined : value), z.boolean().optional().default(false)),
    debug: z
        .object({
        providerTrace: z.literal("raw"),
    })
        .strict()
        .optional(),
});
export const resetAgentSessionSchema = z.object({
    taskKey: z.string().min(1).optional().nullable(),
});

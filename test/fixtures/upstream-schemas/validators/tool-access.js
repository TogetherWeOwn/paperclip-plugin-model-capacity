/** Upstream Paperclip MIT schema fixture. Source: packages/shared/src/validators/tool-access.ts
 * Checkout: /home/ubuntu/build/fs4/upstream-seams-chatpool @ e2cfdc7e0c7a97349846150be4036b033087fe92
 * Source SHA256: 1449fdcabf47173ffcff1c96aae1748f3d5e21fee2c9efdc33365c96dd792b0b
 * Exact declaration excerpts from tsc-emitted dist/validators/tool-access.js; unused exports/imports omitted.
 * Schema declarations are unchanged. Includes the transitive dependencies of
 * updateAgentSchema, wakeAgentSchema, resetAgentSessionSchema,
 * putToolConnectionInstallsSchema and updateToolConnectionSchema.
 */
import { z } from "zod";
import { objectWithoutDefaults } from "./partial.js";
import { connectionAgentInstructionsSchema } from "../connection-instructions.js";
import { TOOL_CONNECTION_KINDS, SECRET_PROJECTION_CLASSES } from "../constants.js";
export const toolConnectionTransportSchema = z.enum(["mcp_remote", "rest_api", "local_stdio", "chat_sdk", "voice"]);
export const toolConnectionPurposeSchema = z.enum(["tool", "channel"]);
export const toolConnectionAuthKindSchema = z.enum(["oauth", "api_key", "none"]);
export const toolConnectionOwnershipSchema = z.enum(["platform_shared", "platform_provisioned", "customer", "dcr"]);
export const toolConnectionCredentialPolicySchema = z.enum(["shared", "per_user", "per_user_with_fallback", "per_agent"]);
export const toolConnectionStatusSchema = z.enum(["draft", "active", "disabled", "archived"]);
export const toolConnectionInstallTargetTypeSchema = z.enum(["company", "agent"]);
export const toolCredentialPlacementSchema = z.enum(["header", "env", "url"]);
export const toolConnectionKindSchema = z.enum(TOOL_CONNECTION_KINDS);
const sensitiveConfigKeyPattern = /^(access[-_]?key([-_]?id)?|api[-_]?key|authorization|bearer|client[-_]?secret|credential|credentials|jwt|password|passwd|private[-_]?key|refresh[-_]?token|secret|secret[-_]?access[-_]?key|secret[-_]?key|session[-_]?token|token)$/i;
function rejectSensitiveConfigKeys(value, ctx, path = []) {
    if (!value || typeof value !== "object")
        return;
    if (Array.isArray(value)) {
        value.forEach((entry, index) => rejectSensitiveConfigKeys(entry, ctx, [...path, index]));
        return;
    }
    for (const [key, nested] of Object.entries(value)) {
        if (sensitiveConfigKeyPattern.test(key)) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: [...path, key],
                message: `Tool access config cannot persist sensitive field: ${key}. Use credentialSecretRefs instead.`,
            });
        }
        rejectSensitiveConfigKeys(nested, ctx, [...path, key]);
    }
}
export const toolCredentialSecretRefSchema = z.object({
    secretId: z.string().guid(),
    versionSelector: z.union([z.literal("latest"), z.number().int().positive()]).optional(),
    configPath: z.string().trim().min(1).max(200),
    required: z.boolean().optional(),
    label: z.string().trim().max(120).optional().nullable(),
    projectionClass: z.enum(SECRET_PROJECTION_CLASSES).optional(),
    projectionAllowlistKey: z.string().trim().min(1).max(160).optional().nullable(),
    keyScope: z.string().trim().min(1).max(160).optional(),
    expiresAt: z.string().datetime({ offset: true }).optional(),
});
export const mcpConnectionCredentialRefSchema = z.object({
    name: z.string().trim().min(1).max(120),
    secretId: z.string().guid(),
    version: z.union([z.literal("latest"), z.number().int().positive()]).optional(),
    placement: toolCredentialPlacementSchema,
    key: z.string().trim().min(1).max(160),
    prefix: z.string().max(120).nullable().optional(),
});
export const toolTransportConfigSchema = z.record(z.string(), z.unknown()).superRefine(rejectSensitiveConfigKeys);
export const createToolConnectionSchema = z.object({
    agentInstructions: connectionAgentInstructionsSchema.nullable().optional(),
    applicationId: z.string().guid().optional(),
    applicationName: z.string().trim().min(1).max(160).optional(),
    name: z.string().trim().min(1).max(160),
    connectionPurpose: toolConnectionPurposeSchema.default("tool"),
    transport: toolConnectionTransportSchema.optional(),
    authKind: toolConnectionAuthKindSchema.default("none"),
    credentialPolicy: toolConnectionCredentialPolicySchema.optional(),
    ownership: toolConnectionOwnershipSchema.default("customer"),
    status: toolConnectionStatusSchema.optional(),
    connectionKind: toolConnectionKindSchema.default("managed"),
    config: toolTransportConfigSchema.optional(),
    transportConfig: toolTransportConfigSchema.default({}),
    credentialRefs: z.array(mcpConnectionCredentialRefSchema).optional(),
    credentialSecretRefs: z.array(toolCredentialSecretRefSchema).default([]),
    enabled: z.boolean().optional(),
});
export const updateToolConnectionSchema = objectWithoutDefaults(createToolConnectionSchema.omit({ applicationId: true })).partial().refine((value) => Object.keys(value).length > 0, { message: "At least one tool connection field is required" });
export const putToolConnectionInstallsSchema = z.object({
    installs: z.array(z.object({
        targetType: toolConnectionInstallTargetTypeSchema,
        targetId: z.string().trim().min(1).max(200),
    })).max(1000),
}).strict();

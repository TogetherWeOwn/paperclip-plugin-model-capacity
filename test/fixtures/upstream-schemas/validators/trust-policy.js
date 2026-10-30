/** Upstream Paperclip MIT schema fixture. Source: packages/shared/src/validators/trust-policy.ts
 * Checkout: /home/ubuntu/build/fs4/upstream-seams-chatpool @ e2cfdc7e0c7a97349846150be4036b033087fe92
 * Source SHA256: 10ecc4bb8b3d80edfc6d578c94845a658e97c6be10a8cd6c81406c14755ab612
 * Exact declaration excerpts from tsc-emitted dist/validators/trust-policy.js; unused exports/imports omitted.
 * Schema declarations are unchanged. Includes the transitive dependencies of
 * updateAgentSchema, wakeAgentSchema, resetAgentSessionSchema,
 * putToolConnectionInstallsSchema and updateToolConnectionSchema.
 */
import { z } from "zod";
import { TRUST_PRESETS, LOW_TRUST_REVIEW_PRESET, LOW_TRUST_REVIEW_PRESET_VERSION, LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION } from "../trust-policy.js";
export const trustPresetSchema = z.enum(TRUST_PRESETS);
export const lowTrustOutputPromotionTargetSchema = z.object({
    type: z.literal("issue"),
    issueId: z.string().guid(),
}).strict();
export const lowTrustBoundarySchema = z.object({
    mode: z.literal(LOW_TRUST_REVIEW_PRESET),
    companyId: z.string().guid().optional(),
    projectIds: z.array(z.string().guid()).optional(),
    rootIssueId: z.string().guid().optional(),
    issueIds: z.array(z.string().guid()).optional(),
    allowedAgentIds: z.array(z.string().guid()).optional(),
    allowedSecretBindingIds: z.array(z.string().guid()).optional(),
    allowedToolClasses: z.array(z.string().trim().min(1)).optional(),
    outputPromotionTarget: lowTrustOutputPromotionTargetSchema.optional(),
}).strict();
export const lowTrustReviewPresetPolicySchema = z.object({
    id: z.literal(LOW_TRUST_REVIEW_PRESET),
    version: z.literal(LOW_TRUST_REVIEW_PRESET_VERSION),
    rawOutputDisposition: z.literal(LOW_TRUST_REVIEW_RAW_OUTPUT_DISPOSITION),
}).strict();
export const assignmentAuthorizationPolicySchema = z.object({
    mode: z.enum(["company_default", "protected"]).optional(),
    // Legacy compatibility only. This remains a hard block and never creates an approval.
    protectedAgentRequiresApproval: z.boolean().optional(),
}).catchall(z.unknown());
export const protectedAgentAuthorizationPolicySchema = z.object({
    blockAssignment: z.boolean().optional(),
    blockReason: z.string().trim().min(1).optional(),
    // Legacy compatibility only. These fields do not create an approval.
    requiresApproval: z.boolean().optional(),
    approvalReason: z.string().optional(),
}).catchall(z.unknown());
export const trustAuthorizationPolicySchema = z.object({
    trustPreset: trustPresetSchema.optional(),
    reviewPreset: lowTrustReviewPresetPolicySchema.optional(),
    trustBoundary: lowTrustBoundarySchema.optional(),
    assignmentPolicy: assignmentAuthorizationPolicySchema.optional(),
    protectedAgent: protectedAgentAuthorizationPolicySchema.optional(),
}).catchall(z.unknown());

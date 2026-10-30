/** Upstream Paperclip MIT schema fixture. Source: packages/shared/src/validators/secret.ts
 * Checkout: /home/ubuntu/build/fs4/upstream-seams-chatpool @ e2cfdc7e0c7a97349846150be4036b033087fe92
 * Source SHA256: e08801804e472ca1307357bb572d0828189ff698106c74dcbc7045927ae26b8e
 * Exact declaration excerpts from tsc-emitted dist/validators/secret.js; unused exports/imports omitted.
 * Schema declarations are unchanged. Includes the transitive dependencies of
 * updateAgentSchema, wakeAgentSchema, resetAgentSessionSchema,
 * putToolConnectionInstallsSchema and updateToolConnectionSchema.
 */
import { z } from "zod";
import { SECRET_PROJECTION_CLASSES } from "../constants.js";
const secretKeySchema = z.string().trim().min(1).max(120).regex(/^[a-zA-Z0-9_.-]+$/);
const secretVersionSelectorSchema = z.union([z.literal("latest"), z.number().int().positive()]);
export const envBindingPlainSchema = z.object({
    type: z.literal("plain"),
    value: z.string(),
});
export const envBindingSecretRefSchema = z.object({
    type: z.literal("secret_ref"),
    secretId: z.string().guid(),
    version: secretVersionSelectorSchema.optional(),
    projectionClass: z.enum(SECRET_PROJECTION_CLASSES).optional(),
    projectionAllowlistKey: z.string().trim().min(1).max(160).optional().nullable(),
});
export const envBindingUserSecretRefSchema = z.object({
    type: z.literal("user_secret_ref"),
    key: secretKeySchema,
    version: secretVersionSelectorSchema.optional(),
    required: z.boolean().optional().default(true),
    allowMissingOverride: z.boolean().optional().default(false),
});
export const envBindingSchema = z.union([
    z.string(),
    envBindingPlainSchema,
    envBindingSecretRefSchema,
    envBindingUserSecretRefSchema,
]);
export const envConfigSchema = z.record(z.string(), envBindingSchema);

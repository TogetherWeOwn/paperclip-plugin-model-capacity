/** Upstream Paperclip MIT schema fixture. Source: packages/shared/src/connection-instructions.ts
 * Checkout: /home/ubuntu/build/fs4/upstream-seams-chatpool @ e2cfdc7e0c7a97349846150be4036b033087fe92
 * Source SHA256: 2cc9e4ec91d36bc9fcafe01a7c9bf9973588ec8e10815166869ac07ac07733c2
 * Exact declaration excerpts from tsc-emitted dist/connection-instructions.js; unused exports/imports omitted.
 * Schema declarations are unchanged. Includes the transitive dependencies of
 * updateAgentSchema, wakeAgentSchema, resetAgentSessionSchema,
 * putToolConnectionInstallsSchema and updateToolConnectionSchema.
 */
import { z } from "zod";
export const CONNECTION_INSTRUCTIONS_MAX_LENGTH = 2000;
export const connectionAgentInstructionsSchema = z.object({
    enabled: z.boolean(),
    text: z.string().trim().min(1).max(CONNECTION_INSTRUCTIONS_MAX_LENGTH),
    template: z.object({
        id: z.string().trim().min(1).max(160),
        version: z.number().int().positive(),
    }).optional(),
});

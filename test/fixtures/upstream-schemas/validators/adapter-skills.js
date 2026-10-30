/** Upstream Paperclip MIT schema fixture. Source: packages/shared/src/validators/adapter-skills.ts
 * Checkout: /home/ubuntu/build/fs4/upstream-seams-chatpool @ e2cfdc7e0c7a97349846150be4036b033087fe92
 * Source SHA256: c2ce3f7291c9d1f51f5aae34a13a211d6308656abde05c146b81ce382c4c1ef3
 * Exact declaration excerpts from tsc-emitted dist/validators/adapter-skills.js; unused exports/imports omitted.
 * Schema declarations are unchanged. Includes the transitive dependencies of
 * updateAgentSchema, wakeAgentSchema, resetAgentSessionSchema,
 * putToolConnectionInstallsSchema and updateToolConnectionSchema.
 */
import { z } from "zod";
export const agentDesiredSkillEntrySchema = z.object({
    key: z.string().min(1),
    versionId: z.string().guid().nullable(),
});
export const agentDesiredSkillSelectionSchema = z.union([
    z.string().min(1),
    agentDesiredSkillEntrySchema,
]);

/** Upstream Paperclip MIT schema fixture. Source: packages/shared/src/adapter-type.ts
 * Checkout: /home/ubuntu/build/fs4/upstream-seams-chatpool @ e2cfdc7e0c7a97349846150be4036b033087fe92
 * Source SHA256: 829c8faf1e83f99273decadc80a803aecff903fba706ee33ccac114d74f051d9
 * Exact declaration excerpts from tsc-emitted dist/adapter-type.js; unused exports/imports omitted.
 * Schema declarations are unchanged. Includes the transitive dependencies of
 * updateAgentSchema, wakeAgentSchema, resetAgentSessionSchema,
 * putToolConnectionInstallsSchema and updateToolConnectionSchema.
 */
import { z } from "zod";
import { AGENT_ADAPTER_TYPES } from "./constants.js";
export const agentAdapterTypeSchema = z
    .string()
    .trim()
    .min(1)
    .default("process")
    .describe(`Known built-in adapters: ${AGENT_ADAPTER_TYPES.join(", ")}. External adapters may register additional non-empty string types at runtime.`);

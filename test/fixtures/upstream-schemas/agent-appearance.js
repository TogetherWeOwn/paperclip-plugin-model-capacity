/** Upstream Paperclip MIT schema fixture. Source: packages/shared/src/agent-appearance.ts
 * Checkout: /home/ubuntu/build/fs4/upstream-seams-chatpool @ e2cfdc7e0c7a97349846150be4036b033087fe92
 * Source SHA256: bc7b87da6029d631d1f67ff5e48b39f7b1ca4d697db64f0e973af5c9b2e6b45a
 * Exact declaration excerpts from tsc-emitted dist/agent-appearance.js; unused exports/imports omitted.
 * Schema declarations are unchanged. Includes the transitive dependencies of
 * updateAgentSchema, wakeAgentSchema, resetAgentSessionSchema,
 * putToolConnectionInstallsSchema and updateToolConnectionSchema.
 */
import { z } from "zod";
export const AGENT_PALETTE_IDS = ["bubblegum-sky", "pink-lemonade", "orchid-peach", "coral-mint", "lime-lagoon", "arctic-blue", "solar-flare", "violet-ember", "deep-tide", "coral-current", "golden-hour", "tangerine-cobalt", "electric-grove", "flamingo-jade", "cherry-pop", "turquoise-cherry", "ultraviolet-tide"];
export const agentAppearanceSchema = z.object({
    schemaVersion: z.literal(1),
    characterVersion: z.literal("cap-v1"),
    paletteId: z.enum(AGENT_PALETTE_IDS),
    /** Company-scoped normalized image, set through the avatar upload service. */
    customAvatarAssetId: z.uuid().optional(),
}).strict();

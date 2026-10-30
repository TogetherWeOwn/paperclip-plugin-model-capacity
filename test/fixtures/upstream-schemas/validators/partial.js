/** Upstream Paperclip MIT schema fixture. Source: packages/shared/src/validators/partial.ts
 * Checkout: /home/ubuntu/build/fs4/upstream-seams-chatpool @ e2cfdc7e0c7a97349846150be4036b033087fe92
 * Source SHA256: 1e34d8d328ea94323a16971d9113f50d147d7342b293cf3ff424f8181bc7c782
 * Exact declaration excerpts from tsc-emitted dist/validators/partial.js; unused exports/imports omitted.
 * Schema declarations are unchanged. Includes the transitive dependencies of
 * updateAgentSchema, wakeAgentSchema, resetAgentSessionSchema,
 * putToolConnectionInstallsSchema and updateToolConnectionSchema.
 */
import { z } from "zod";
function fieldWithoutDefault(field) {
    if (field instanceof z.ZodDefault) {
        return fieldWithoutDefault(field.unwrap());
    }
    if (field instanceof z.ZodOptional) {
        return z.optional(fieldWithoutDefault(field.unwrap()));
    }
    if (field instanceof z.ZodNullable) {
        return z.nullable(fieldWithoutDefault(field.unwrap()));
    }
    return field;
}
export function shapeWithoutDefaults(shape) {
    return Object.fromEntries(Object.entries(shape).map(([key, field]) => [
        key,
        fieldWithoutDefault(field),
    ]));
}
export function objectWithoutDefaults(schema) {
    return z.object(shapeWithoutDefaults(schema.shape));
}

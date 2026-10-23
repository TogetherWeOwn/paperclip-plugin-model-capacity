import { definePlugin, runWorker } from '@paperclipai/plugin-sdk';
import { createModelCapacityPlugin } from './plugin.mjs';

// The proposal evaluator is plugin-internal, not a host lifecycle hook.
const { proposeRunModel, ...implementation } = createModelCapacityPlugin();
const plugin = definePlugin(implementation);
export default plugin;
runWorker(plugin, import.meta.url);

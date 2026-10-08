import { definePlugin, runWorker } from '@paperclipai/plugin-sdk';
import { createModelCapacityPlugin } from './plugin.mjs';

const plugin = definePlugin(createModelCapacityPlugin());
export default plugin;
runWorker(plugin, import.meta.url);

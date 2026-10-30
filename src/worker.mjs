import { definePlugin, runWorker } from '@paperclipai/plugin-sdk';
import { createModelCapacityPlugin } from './plugin.mjs';
import { BUILD_VARIANT } from './build-variant.mjs';

const plugin = definePlugin(createModelCapacityPlugin({variant:BUILD_VARIANT}));
export default plugin;
runWorker(plugin, import.meta.url);

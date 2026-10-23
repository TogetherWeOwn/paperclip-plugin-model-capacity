// Stock-host install (0.2.67): the same build with the manifest that declares
// only capabilities upstream Paperclip knows (no run.model.resolve). Model
// choice runs through upstreamMode (see upstream.mjs).
export * from './manifest.mjs';
export { upstreamManifest as default } from './manifest.mjs';

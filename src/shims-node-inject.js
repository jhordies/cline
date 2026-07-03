// This file is injected by esbuild into the extension bundle via the `inject` option.
// It forces @anthropic-ai/sdk/shims/node to be loaded before any other SDK code,
// even in minified production builds where side-effect-only imports get tree-shaken.
// The explicit require() call is not tree-shakeable and runs before all other modules.
require("@anthropic-ai/sdk/shims/node")

// Compatibility shim: the host-neutral store now lives in ../core.
// The Codex MCP adapter keeps importing "./store.js" so its tests and entry
// points stay unchanged after the extraction.
export * from "../../core/store.js";

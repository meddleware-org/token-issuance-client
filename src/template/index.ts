// @meddleware/token-issuance-client/template — the compiled template module and its patcher. Kept
// apart from the main entry so the wasm and the bytecode load only where a deploy happens.
//
// Role: the entry for code that has to produce the module a person publishes: it re-exports the patcher (which renames the identifiers and overwrites the constants of the compiled
// template) and the generated artefact it patches. Nothing else belongs here: the main entry must stay free of the WASM and the bytecode. Tested in `tests/template.test.ts`.

// The patcher and the WASM set-up (the browser build needs to be told where its WASM asset is).

export {
  configureTemplateWasm,
  initTemplateWasm,
  patchTemplateModule,
  patchTokenModule,
  type PatchParams,
  type TemplateWasmSource,
} from './patch.js'
// The generated artefact: the compiled module, the names and default values the patcher looks for, and how the module was built.
export { TEMPLATE_BUILD_INFO, TEMPLATE_DEFAULTS, TEMPLATE_IDENTIFIERS, TEMPLATE_MODULE_B64 } from './artifact.js'

# Explicit sibling source roots for Typert

The user authorized this additional temporary Harness build-tool patch and continued WSL deployment. Baseline is `5455441da8cd51911ffe9ba83d3ef308198a8611`. Preserve the reviewed required-external runtime patch, the dirty primary Mac checkout and all official upstream refs. No runtime scheduler, persistence, application launcher or Worker protocol changes.

## Evidence and chosen approach

The selected candidate generates the official Commands artifacts. The sibling Roundtable product compiles and passes 74 focused tests, but generation fails: its aggregate omits compiler options; correcting those yields zero Remote methods because `WorkspaceAnalyzer.loadRegistrations()` admits only `<root>/packages`. `isTypeMetaSymbol()` requires the actual protocol declaration's package registration. Adding aggregate references alone leaves sibling packages excluded.

Reuse the official TypeScript analyzer and emitter. Add optional `additionalPackageRoots` to analyzer and generator options, and forward optional `hostConfig`/`clientConfig` through the generator. Roots are explicit source-container directories, resolved against the workspace root and canonicalized; default remains only `<root>/packages`. An explicitly allowed root may be outside the workspace. Admit a directly referenced project only when its canonical package root is inside an allowed canonical container using the existing path-segment comparison. References outside all allowed containers, including symlink escapes, remain excluded as they are today; do not scan directories, recursively admit arbitrary dependencies, or infer authority from decorator spelling.

Keep the existing workspace/root and both aggregate config identities in the registration cache key, canonicalize the config paths, and add sorted/deduplicated canonical extra roots. Configs and their project membership are immutable for one WorkspaceCaches snapshot; changed file contents require a fresh cache as already documented. Compiler-host caches must also distinguish the face and canonical aggregate path, not just the face, so custom aggregates cannot reuse another program's module-resolution settings. Test both inventory and compiler-host isolation across different aggregate paths with the same roots, plus different roots with the same aggregate.

Duplicate identity is `(manifest.name, compiler face)` across the entire admitted direct-reference inventory, not merely the emitted subset. Reject conflicting canonical physical roots for an identity; a consistent dependency identity is required even for a focused target. Identical same-root references remain deduplicated; Host and Client are independent identities. Sort identities and conflicting paths for a deterministic diagnostic before returning the inventory. Discovery and package selection otherwise retain their existing semantics over that inventory.

The product builds ephemeral Host and Client aggregates from their corresponding product/candidate configs, keeping compiler faces separate. Each has explicit rebased source aliases and direct project references from both workspaces, not a copied static alias table or shared cache mutation. It invokes generation for only `@roundtable-director/plugin` and only the Host face, supplying only the candidate's `packages` container as an additional root; Client references serve cross-face inventory, not Client emission. Workspace root stays the product root, not the temporary directory. The generator retains diagnostics, export checks, strict schemas and Remote metadata. Only selected product artifacts are written, never files in Harness. Assert generated artifacts/maps contain no temporary aggregate directory. The observed missing symbol is currently caused by inconsistent analysis resolution; first correct configuration and registration, then diagnose any surviving exception as a separate rejection-path defect rather than suppressing it.

## Scope and verification

Harness owner: analyzer options/registration discovery/cache identity; generator option forwarding; focused sibling-fixture tests; README pair and an Agent Note. Test default exclusion, explicit root inclusion and usable Remote schemas, real-path symlink containment, duplicate-name rejection, distinct cache configurations, custom aggregate forwarding and unchanged official fixture generation. Keep diagnostics enabled; add an invalid referenced request-type case. A focused temporary fixture owns its own directories and teardown.

Product owner: replace experimental artifact copying and handwritten RPC overlays with real generator output, update checkout identification, and add focused config/generation tests. Verify complete actual Remote descriptors including editPlan/approvePlan/retryReview and agent scope. Source synchronization to WSL uses GitHub branches and existing Windows Git SSH, never source SCP or credential copying. Build and paid runtime work stay on WSL. Client bundling proceeds in parallel under the previously dual-reviewed deployment plan's Slice B, without overlapping these files.

Before acceptance, obtain two independent implementation verdicts and run the actual product source-generation probe on the paired WSL SHAs. Then resume Client build, pinned candidate restart qualification, profile installation and real Worker/browser acceptance. Generator success alone does not qualify a running product.

## Reference adoption

| Concern | Reference evidence | Adopt | Decline | Verification |
|---|---|---|---|---|
| Package/compiler membership | Candidate analyzer.ts registration and cache owners | explicit direct-project references and canonical source roots | implicit filesystem scanning and protocol-name-only trust | sibling, collision and cache fixtures |
| Runtime descriptors | Candidate workspace.ts and emitter.ts | official typed schema emission and export validation | copied legacy experimental output and handwritten overlays | generated executable schema and real product methods |
| Independent packaging | Prior deployment research's pinned dsh-agent-teams source inspection | product-owned build orchestration | its scheduler/persistence and alpha compatibility claims | paired WSL artifact tests |

No external source code is copied. The new option is conditional build configuration with a current product caller and observable tests, not a runtime capability flag.

# Pinned embedding runtime

The worker uses node-llama-cpp 3.22.2 with llama.cpp v0.7.0, commit
`620d2225cc436ab0b001e3200e590e3b286ef9ab`. The source archive is SHA-256
pinned in `packages/api/src/lib/kb/fixtures/embedding-runtime.json`.
`scripts/build-embedding-runtime.mjs` builds CPU-only with at most three jobs,
packages the addon and its shared libraries, and writes a file-hash receipt.
The child verifies that receipt, refuses prebuilt/compile/download fallback,
and checks the actual mapped native paths before loading weights.

For local development, after installing the existing workspace dependencies,
run `node scripts/build-embedding-runtime.mjs --install` with CMake, a C++
compiler, make, curl and tar available. The model test lane runs this step
itself. Reinstall the build after replacing node_modules; a missing or changed
receipt deliberately makes activation fail. The generated build cache is ignored
by Git and is never part of the model download volume.

The source is built unpatched. Upstream llama.cpp now skips the LM head and the
logits buffer for pooled embedding contexts (ggml-org/llama.cpp#30445, in
v0.7.0), which is what the former `output-buffer.patch` did for the Qwen graph;
node-llama-cpp 3.22.2 fills batches itself, retiring `node-batch-compat.patch`.
The real-model lanes still assert maximum-input peak memory, so a source that
allocated logits again cannot pass them. Neither change touched the tokenizer
or pooling.

Gemma uses one sequence and a full-cap batch/ubatch, flash attention and mmap.
Qwen retains 512-token causal batches. Models are downloaded separately on
enable; weights are never part of this build or its image/cache.

Native build tools run in owned process groups with a 19-minute operation
deadline. SIGINT/SIGTERM stop admission, terminate and drain descendants, then
remove the extracted source/build scratch. The test harness's 20-minute outer
deadline leaves room for this cleanup. A successful tool exit also drains any
remaining descendants before the build receipt is published.

A deployment with a different runtime identity queues the existing capability
probe even for an already READY model. The target identity and probe claim are
persisted before native work; successful settlement atomically activates that
identity, fences prior epochs and queues sequential rebuilds of every attached
KB. Until then old generations remain lexical-readable. Failed or interrupted
upgrade probes remain terminal across worker restarts; enabling again or saving
the unchanged config explicitly retries them.

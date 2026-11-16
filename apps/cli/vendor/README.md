# Embedding-only Rust bindings

This directory contains the vendored llama-cpp-2 / llama-cpp-sys-2 0.1.161 fork.
The sys source is llama.cpp v0.9.0, commit
`cd959bae99ff4bed22bef2604f45241c09bbb8c8`, from the SHA-256-verified archive
in `packages/api/src/lib/kb/fixtures/embedding-runtime.json` (the same release
the server worker builds). Only the source directories included by the
upstream sys crate are retained. No model weights or compiled libraries belong
here. Cargo builds into the usual CLI target.

The source is unpatched. Upstream skips the LM head and the logits buffer for
pooled embedding contexts (ggml-org/llama.cpp#30445, in v0.7.0), which retired
the former output-buffer patch on both the CLI and the server. Generation,
training and samplers keep logits upstream.

The binding patch disables the sys dependency's default `common` feature;
that unused speculative/generation wrapper is not built for embedding-only use.
The macOS dependency also disables default features and automatic Metal:
this runtime is CPU-only on every supported platform. No new FFI is added
to kb-local. Compile with CMake, a C++ compiler and libclang. Native build
parallelism must be capped at three; OpenMP/C++ runtime libraries are required
where dynamically linked. Real-model tests assert maximum-input memory, so a
source that allocated pooled logits again cannot pass the required lane.

`inventory.json` records the SHA-256 of every vendored file, derived from the
pinned crate and llama.cpp archives by `pnpm cli:vendor:generate`, with each
fork edit listed (reason and upstream hash). `pnpm cli:vendor:check` (in
`pnpm gate`) and a kb-local test fail on any added, removed, changed or
executable vendored file and on pin drift. Any new fork edit needs an entry
in `FORK_EDITS` in `scripts/sync-cli-vendor-inventory.mjs`.

On upgrade, update both source/runtime pins together with the server pin,
regenerate the inventory, and rerun token/vector and memory parity for both
models on every release platform. Upstream crate code keeps its MIT OR Apache-2.0 license; llama.cpp
is MIT (LICENSE in its source directory).

The unused GPU/multimodal shell/Python test/generator scripts from the
upstream source archive (`llamaCpp.omitted` in `inventory.json`) are omitted; those backends are forced OFF in this
embedding-only build. Vendored files carry no executable bit, so the
repository automation policy treats none of them as runnable scripts. Crate attributes in our Rust fixtures follow a Rust doc
header so they are not mistaken for interpreter shebangs by the existing
fail-closed automation policy. No policy rule or allowlist is weakened.
Feature-gating unused common/mtmd imports and fields, and completing enum
variant documentation, keeps the embedding-only binding warning-free. On musl targets the sys
build script links OpenMP (`libgomp.a`) and `libstdc++.a` statically, as
the static musl release binaries need (upstream links OpenMP only on `*-gnu`
and libstdc++ dynamically); GNU, macOS and Windows linking is unchanged. See
`apps/cli/ci/musl-builder.Dockerfile`. The sys
build script reads the MSVC `INCLUDE` path through cc's `Tool::get_envs`
(cc >= 1.7 deprecates `Tool::env`), so it stays warning-free under
`RUSTFLAGS=-D warnings`.

`LlamaTimings::new` zero-initializes the two graph-reallocation counters
llama.cpp v0.7.0 adds to `llama_perf_context_data` (0.1.161 still targets
v0.6.0; no crate release targets v0.9.0 yet); it is the only source adaptation
to the newer headers. 0.1.161's `with_tensor_split` uses the `tensor_split`
field outside `common`, so that field is no longer gated; in `model/params.rs`
only the `common`-only import is.

Binding source archive revision: `e7af607ebd5ec2932709ef918c17cca2f9b0fce4`.
The original MIT and Apache texts from that revision accompany both crates;
llama.cpp and its retained dependencies keep their original license notices.

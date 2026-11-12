#!/bin/sh
# RUSTC_WRAPPER for the static musl builder (musl-builder.Dockerfile).
#
# On a musl host, Rust defaults to crt-static for host artifacts too, so build
# scripts become static executables that cannot dlopen() — and bindgen (the
# llama-cpp-sys-2 build script) must load libclang at runtime. With an explicit
# `--target`, cargo compiles host units (build scripts, proc-macros and their
# dependencies) WITHOUT `--target`, so only those get `-crt-static`. Target
# units, i.e. everything linked into `kb`, keep the musl crt-static default.
set -eu
rustc="$1"
shift
for arg in "$@"; do
  case "$arg" in
    --target | --target=*) exec "$rustc" "$@" ;;
  esac
done
# `rustc -vV` and other probes without a crate also pass through unchanged.
case " $* " in
  *" --crate-name "*) exec "$rustc" "$@" -C target-feature=-crt-static ;;
esac
exec "$rustc" "$@"

#!/bin/sh
# Linker for the *-musl targets in the static musl builder.
#
# musl's default thread stack is 128 KiB (glibc: 8 MiB), and musl sizes it
# from the executable's PT_GNU_STACK. Asking for glibc's 8 MiB keeps the
# libgomp/ggml worker threads at the stack depth they have on GNU builds.
# This lives in the linker, not RUSTFLAGS, because cargo-dist sets RUSTFLAGS
# and RUSTFLAGS replaces target-specific rustflags.
set -eu
exec gcc "$@" -Wl,-z,stack-size=8388608

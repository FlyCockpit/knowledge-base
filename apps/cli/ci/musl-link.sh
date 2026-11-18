#!/bin/sh
# Linker for the *-musl targets in the static musl builder.
#
# musl's default thread stack is 128 KiB (glibc: 8 MiB), and musl sizes it
# from the executable's PT_GNU_STACK. Asking for glibc's 8 MiB keeps the
# libgomp/ggml worker threads at the stack depth they have on GNU builds.
# This lives in the linker, not RUSTFLAGS, because cargo-dist sets RUSTFLAGS
# and RUSTFLAGS replaces target-specific rustflags.
#
# rustc links musl targets with -nodefaultlibs, so libgcc is not implicit. The
# static libgomp in llama-cpp-sys-2 uses aarch64 outline atomics
# (`__aarch64_ldadd8_sync`, ...), which only libgcc.a provides; as a trailing
# archive it contributes nothing else (x86_64 references none of it).
set -eu
exec gcc "$@" -lgcc -Wl,-z,stack-size=8388608

# Static musl release builder for the `kb` CLI (x86_64 and aarch64 Linux).
#
# Alpine's native toolchain is musl, and its gcc/g++ packages ship the static
# archives a fully static `kb` needs: libstdc++.a and libgomp.a (OpenMP for
# llama.cpp). The vendored llama-cpp-sys-2 build script links both statically
# for any *-musl target (apps/cli/vendor/README.md). Rust's musl targets default
# to crt-static, so the result has no ELF interpreter and no NEEDED entries.
#
# The base is pinned by its multi-arch index digest (amd64 + arm64). Alpine
# package revisions are not pinnable long-term (the repository drops old
# revisions), so the release job writes the exact toolchain package versions
# (`apk info -v`) to its job summary instead.
FROM docker.io/library/rust:1.99-alpine@sha256:44819b27be4c97b0e4d7203bd2e02c4820f97700211b6a37fb4c246a2de59383

# build-base: gcc/g++ (libstdc++.a, libgomp.a), musl-dev, make.
# cmake: llama.cpp. clang-dev: libclang for bindgen. git: cargo-dist and the
# build commit. perl/linux-headers: native crate builds. xz/tar: dist archives.
RUN apk add --no-cache build-base cmake clang-dev linux-headers git perl xz tar \
  && test -f "$(gcc --print-file-name=libgomp.a)" \
  && test -f "$(g++ --print-file-name=libstdc++.a)"

# cargo-dist, same pinned release as the release workflow, musl build.
ARG TARGETARCH
RUN set -eu; \
  case "$TARGETARCH" in \
    amd64) triple=x86_64-unknown-linux-musl; sum=f274b9889e93333a52cdcab86b93ab04b875b8ef4eebc7f8589514e0aff827e6 ;; \
    arm64) triple=aarch64-unknown-linux-musl; sum=aac7d48901f5283b53e136dd0498782c88a3350dfa4a5e88f4c3e0ba7e486eea ;; \
    *) echo "unsupported TARGETARCH=$TARGETARCH" >&2; exit 1 ;; \
  esac; \
  archive="/tmp/cargo-dist-$triple.tar.xz"; \
  wget -q -O "$archive" "https://github.com/axodotdev/cargo-dist/releases/download/v0.34.0/cargo-dist-$triple.tar.xz"; \
  echo "$sum  $archive" | sha256sum -c -; \
  tar -xJf "$archive" -C /tmp; \
  install -m755 "/tmp/cargo-dist-$triple/dist" /usr/local/bin/dist; \
  rm -rf "$archive" "/tmp/cargo-dist-$triple"; \
  dist --version

# Host units (build scripts, proc-macros) link dynamically so bindgen can load
# libclang; target units stay crt-static. Builds must pass `--target`.
COPY rustc-host-dynamic.sh /usr/local/bin/rustc-host-dynamic
COPY musl-cc.sh /usr/local/bin/musl-cc
COPY musl-link.sh /usr/local/bin/musl-link
RUN chmod 0755 /usr/local/bin/rustc-host-dynamic /usr/local/bin/musl-cc /usr/local/bin/musl-link

# The build runs as the invoking (non-root) user; cargo state lives in the
# mounted CARGO_HOME, rustup's toolchain stays in the image.
# sqlite-vec.c needs <sys/types.h> + _DEFAULT_SOURCE on musl; musl-cc adds
# them for that one file only (see musl-cc.sh).
# musl-link requests glibc's 8 MiB default thread stack (see musl-link.sh).
ENV RUSTC_WRAPPER=/usr/local/bin/rustc-host-dynamic \
    CC_x86_64_unknown_linux_musl=/usr/local/bin/musl-cc \
    CC_aarch64_unknown_linux_musl=/usr/local/bin/musl-cc \
    CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=/usr/local/bin/musl-link \
    CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER=/usr/local/bin/musl-link \
    LIBCLANG_PATH=/usr/lib \
    CMAKE_BUILD_PARALLEL_LEVEL=3

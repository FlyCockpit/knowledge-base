#!/bin/sh
# C compiler for the *-musl targets in the static musl builder.
#
# sqlite-vec 0.1.9's sqlite-vec.c typedefs from the BSD `u_int8_t` family
# without including <sys/types.h>. glibc provides it transitively through
# <stdlib.h> with _DEFAULT_SOURCE on by default; musl does neither. Only that
# translation unit gets both; every other C/assembly input passes through
# unchanged (a global -include breaks .S files such as ring's).
set -eu
for arg in "$@"; do
  case "$arg" in
    sqlite-vec.c | */sqlite-vec.c) exec gcc -D_DEFAULT_SOURCE -include sys/types.h "$@" ;;
  esac
done
exec gcc "$@"

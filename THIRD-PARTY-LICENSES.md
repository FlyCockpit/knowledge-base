# Third-Party Notices

This project bundles or depends on third-party components whose licenses
require attribution or carry obligations worth knowing about. Everything else
in the dependency tree is under permissive licenses (MIT, Apache-2.0, ISC,
BSD) that require no action. Full license texts ship inside each package in
`node_modules/`.

## Roboto (webfont) — SIL Open Font License 1.1

The web app bundles the Roboto variable font via
[`@fontsource-variable/roboto`](https://www.npmjs.com/package/@fontsource-variable/roboto)
(`packages/ui/src/styles/globals.css`, `apps/web/src/routes/__root.tsx`). The
`.woff2` files are emitted into the client build.

> Copyright 2011 The Roboto Project Authors
> (https://github.com/googlefonts/roboto-classic)
>
> This Font Software is licensed under the SIL Open Font License, Version 1.1.
> The full license text is available at http://scripts.sil.org/OFL and ships
> with the package at `node_modules/@fontsource-variable/roboto/LICENSE`.

The OFL permits bundling the font in commercial products. Its two obligations:
the font files may not be sold on their own, and this notice must accompany
redistributions of the font. Keep this file (or an equivalent notice) if you
ship the bundled font; it does not apply if you swap Roboto for another font
during rebranding.

## libvips (via `sharp`) — LGPL-3.0-or-later

The server and worker declare [`sharp`](https://sharp.pixelplumbing.com)
(Apache-2.0) as a dependency, which loads prebuilt [libvips](https://www.libvips.org) binaries
from `@img/sharp-libvips-*` packages. libvips is LGPL-3.0-or-later.

This imposes no obligations on your application code: libvips is dynamically
linked at runtime as a separate, replaceable npm package and is never compiled
into your code or shipped to browsers. The LGPL's requirements (source
availability for libvips itself, replaceability) are satisfied by the npm
packaging model. No first-party code currently imports sharp; the binaries are
present in the server and worker images only because the packages declare it.

## web-tree-sitter and tree-sitter-bash — MIT

The Claude Code PreToolUse hook (`scripts/claude-hooks/pre-tool-use.mjs`) uses
[`web-tree-sitter`](https://www.npmjs.com/package/web-tree-sitter) and
[`tree-sitter-bash`](https://www.npmjs.com/package/tree-sitter-bash) as root
devDependencies to parse Bash at the tool boundary. This is local agent tooling
only — nothing in the web app, server, worker, or native bundles imports these
packages. The shipped `tree-sitter-bash.wasm` grammar is loaded from the
installed package; no native binding is built (`allowBuilds.tree-sitter-bash:
false` in `pnpm-workspace.yaml`).

## caniuse-lite — CC-BY-4.0

Browser-compatibility data from [caniuse.com](https://caniuse.com), used at
build time by the CSS toolchain (browserslist). Attribution-only; the data is
not shipped as part of the application.


## llama-cpp-2 / llama-cpp-sys-2 and llama.cpp — MIT / Apache-2.0

The CPU-only Rust CLI statically links the approved vendored 0.1.160 bindings
(MIT OR Apache-2.0) and pinned, unpatched llama.cpp v0.7.0 (MIT). Sources,
upstream license texts and pins are retained under `apps/cli/vendor/`. Preserve these notices
when redistributing the CLI. Model weights are downloaded separately after
owner opt-in and are never included in the binary or images.

## Static Linux CLI runtime — musl (MIT); libgomp and libstdc++ (GCC Runtime Library Exception)

The Linux `kb` release binaries (`*-unknown-linux-musl`) are fully static. They
statically link [musl libc](https://musl.libc.org) (MIT; complete COPYRIGHT
below) and GCC's runtime libraries `libgomp` (OpenMP, used by llama.cpp),
`libstdc++` and `libgcc`, which are GPL-3.0-or-later with the GCC Runtime
Library Exception 3.1. The exception permits distributing the combined binary
under any terms when it is produced by an eligible compilation process (GCC
with GPL-compatible software only, which is how `kb` is built); it imposes no
source or notice obligation on `kb`. All of them come from the digest-pinned
Alpine builder in `apps/cli/ci/musl-builder.Dockerfile` (at the time of
writing musl 1.2.6 and GCC 15.2); each release job writes the exact package
versions to its job summary. macOS and Windows binaries
link their platform runtimes dynamically and include none of these.

## web-push — MPL-2.0

The server and worker send Web Push notifications through
[`web-push`](https://www.npmjs.com/package/web-push) (MPL-2.0), a direct
dependency of `@knowledge-base/api`. It ships unmodified in the server and
worker images; its source is available from npm and its upstream repository.
MPL-2.0 is file-level copyleft: it only imposes obligations if you modify the
`web-push` files themselves.

## elkjs — EPL-2.0

[`elkjs`](https://www.npmjs.com/package/elkjs) (EPL-2.0) arrives transitively
through `prisma` → `@prisma/studio-core`. The Prisma CLI is a runtime
dependency of the images (schema apply), so elkjs ships unmodified inside them;
no first-party code uses it.

## node-llama-cpp and llama.cpp (worker image) — MIT

The worker's built-in embedding runtime uses
[`node-llama-cpp`](https://www.npmjs.com/package/node-llama-cpp) (MIT), which
provides the addon for the pinned llama.cpp (MIT) CPU runtime. The worker
image builds this runtime from pinned source and retains the upstream MIT
attribution; it does not use prebuilt embedding binaries. See
[`apps/worker/native/README.md`](apps/worker/native/README.md) for the pinned
versions, source verification and build receipt details.

## Embedding model weights — Apache-2.0

The built-in embedding models are downloaded only after owner opt-in and are
never bundled in the repository, images or CLI binary:
[`ggml-org/embeddinggemma-2-GGUF`](https://huggingface.co/ggml-org/embeddinggemma-2-GGUF)
(Apache-2.0, based on `google/embeddinggemma-2`) and
[`Qwen/Qwen3-Embedding-0.6B-GGUF`](https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF)
(Apache-2.0). Review each model's card before redistributing weights.

## Vendored llama.cpp — complete MIT license

MIT License

Copyright (c) 2023-2026 The ggml authors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## musl libc — complete COPYRIGHT (as of 1.2.6)

```text
musl as a whole is licensed under the following standard MIT license:

----------------------------------------------------------------------
Copyright © 2005-2020 Rich Felker, et al.

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
----------------------------------------------------------------------

Authors/contributors include:

A. Wilcox
Ada Worcester
Alex Dowad
Alex Suykov
Alexander Monakov
Andre McCurdy
Andrew Kelley
Anthony G. Basile
Aric Belsito
Arvid Picciani
Bartosz Brachaczek
Benjamin Peterson
Bobby Bingham
Boris Brezillon
Brent Cook
Chris Spiegel
Clément Vasseur
Daniel Micay
Daniel Sabogal
Daurnimator
David Carlier
David Edelsohn
Denys Vlasenko
Dmitry Ivanov
Dmitry V. Levin
Drew DeVault
Emil Renner Berthing
Fangrui Song
Felix Fietkau
Felix Janda
Gianluca Anzolin
Hauke Mehrtens
He X
Hiltjo Posthuma
Isaac Dunham
Jaydeep Patil
Jens Gustedt
Jeremy Huntwork
Jo-Philipp Wich
Joakim Sindholt
John Spencer
Julien Ramseier
Justin Cormack
Kaarle Ritvanen
Khem Raj
Kylie McClain
Leah Neukirchen
Luca Barbato
Luka Perkov
Lynn Ochs
M Farkas-Dyck (Strake)
Mahesh Bodapati
Markus Wichmann
Masanori Ogino
Michael Clark
Michael Forney
Mikhail Kremnyov
Natanael Copa
Nicholas J. Kain
orc
Pascal Cuoq
Patrick Oppenlander
Petr Hosek
Petr Skocik
Pierre Carrier
Reini Urban
Rich Felker
Richard Pennington
Ryan Fairfax
Samuel Holland
Segev Finer
Shiz
sin
Solar Designer
Stefan Kristiansson
Stefan O'Rear
Szabolcs Nagy
Timo Teräs
Trutz Behn
Will Dietz
William Haddon
William Pitcock

Portions of this software are derived from third-party works licensed
under terms compatible with the above MIT license:

The TRE regular expression implementation (src/regex/reg* and
src/regex/tre*) is Copyright © 2001-2008 Ville Laurikari and licensed
under a 2-clause BSD license (license text in the source files). The
included version has been heavily modified by Rich Felker in 2012, in
the interests of size, simplicity, and namespace cleanliness.

Much of the math library code (src/math/* and src/complex/*) is
Copyright © 1993,2004 Sun Microsystems or
Copyright © 2003-2011 David Schultz or
Copyright © 2003-2009 Steven G. Kargl or
Copyright © 2003-2009 Bruce D. Evans or
Copyright © 2008 Stephen L. Moshier or
Copyright © 2017-2018 Arm Limited
and labelled as such in comments in the individual source files. All
have been licensed under extremely permissive terms.

The ARM memcpy code (src/string/arm/memcpy.S) is Copyright © 2008
The Android Open Source Project and is licensed under a two-clause BSD
license. It was taken from Bionic libc, used on Android.

The AArch64 memcpy and memset code (src/string/aarch64/*) are
Copyright © 1999-2019, Arm Limited.

The implementation of DES for crypt (src/crypt/crypt_des.c) is
Copyright © 1994 David Burren. It is licensed under a BSD license.

The implementation of blowfish crypt (src/crypt/crypt_blowfish.c) was
originally written by Solar Designer and placed into the public
domain. The code also comes with a fallback permissive license for use
in jurisdictions that may not recognize the public domain.

The smoothsort implementation (src/stdlib/qsort.c) is Copyright © 2011
Lynn Ochs and is licensed under an MIT-style license.

The x86_64 port was written by Nicholas J. Kain and is licensed under
the standard MIT terms.

The mips and microblaze ports were originally written by Richard
Pennington for use in the ellcc project. The original code was adapted
by Rich Felker for build system and code conventions during upstream
integration. It is licensed under the standard MIT terms.

The mips64 port was contributed by Imagination Technologies and is
licensed under the standard MIT terms.

The powerpc port was also originally written by Richard Pennington,
and later supplemented and integrated by John Spencer. It is licensed
under the standard MIT terms.

All other files which have no copyright comments are original works
produced specifically for use as part of this library, written either
by Rich Felker, the main author of the library, or by one or more
contibutors listed above. Details on authorship of individual files
can be found in the git version control history of the project. The
omission of copyright and license comments in each file is in the
interest of source tree size.

In addition, permission is hereby granted for all public header files
(include/* and arch/*/bits/*) and crt files intended to be linked into
applications (crt/*, ldso/dlstart.c, and arch/*/crt_arch.h) to omit
the copyright notice and permission notice otherwise required by the
license, and to use these files without any requirement of
attribution. These files include substantial contributions from:

Bobby Bingham
John Spencer
Nicholas J. Kain
Rich Felker
Richard Pennington
Stefan Kristiansson
Szabolcs Nagy

all of whom have explicitly granted such permission.

This file previously contained text expressing a belief that most of
the files covered by the above exception were sufficiently trivial not
to be subject to copyright, resulting in confusion over whether it
negated the permissions granted in the license. In the spirit of
permissive licensing, and of not having licensing issues being an
obstacle to adoption, that text has been removed.
```

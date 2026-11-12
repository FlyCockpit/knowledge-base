## Summary

<!-- What does this change do, and why? Link related issues (for example "Closes #123"). -->

## Checks run

- [ ] `pnpm gate`
- [ ] CLI checks from `apps/cli`, including `cargo test --workspace --all-targets --locked` (Rust changes only; see `apps/cli/CONTRIBUTING.md`)
- [ ] Other (describe):

## Checklist

- [ ] Every commit is signed off (`git commit -s`) under the [Developer Certificate of Origin](https://github.com/FlyCockpit/knowledge-base/blob/main/CONTRIBUTING.md#licensing-and-the-developer-certificate-of-origin).
- [ ] If this adds or changes an oRPC procedure, route gate or schema field, `docs/access-matrix.md` is updated in this change.
- [ ] User-facing strings go through `t()`; new environment variables, public pages and docs are updated as described in `AGENTS.md`.
- [ ] No secrets, private KB content or personal data in code, tests, fixtures or logs.

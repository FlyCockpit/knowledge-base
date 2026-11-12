# Branch rulesets

`main.json` is an importable GitHub ruleset that requires a pull request before
changes land on the default branch, blocks force-pushes and branch deletion,
and requires the named jobs from `.github/workflows/pr-checks.yml` to pass.

GitHub does not apply a checked-in ruleset file automatically. A human with
admin access has to import it once.

## Import

1. Open the repository on GitHub → **Settings** → **Rules** → **Rulesets**.
2. Click **New ruleset** → **Import a ruleset**.
3. Choose `.github/rulesets/main.json`.
4. Review the required check. `PR validation` is the always-running aggregate
   in `pr-checks.yml`: on a ready PR it requires a successful setup plus every
   validation job; on a draft it records the intentional skips. If you add,
   remove, or rename a validation job, update that aggregate and `main.json` in
   the same change.
5. Click **Create**. Enforcement is `active`.

Until this is imported, a direct push to `main` skips every PR check.
The file is the intended policy; importing it is what makes it real.

## Notes on the required list

- **`Install dependencies`** (`setup`) is an input to the required aggregate.
  If it fails, dependent jobs may be skipped by GitHub, but `PR validation`
  still runs and fails for a ready PR; skipped jobs can never hide install
  failure.
- **`pnpm audit`** is required, not advisory. It is the one check whose result
  can change without a code change (a new advisory lands against an unchanged
  lockfile), so it will occasionally turn a green PR red — that is the point.
  If it becomes noisy, raise `--audit-level` in `pr-checks.yml` rather than
  dropping the context here, so the gate stays required.
- A **skipped** required check counts as satisfied on GitHub. That is why
  `pr-checks.yml` listens for `ready_for_review`: without it, a PR opened as a
  draft would leave every job skipped and merge clean.
- **Docker** is represented twice inside `PR validation`: the matrix job result
  and its human-facing `docker-gate`. The aggregate requires both to succeed on
  ready PRs, so a skipped or failed matrix cannot satisfy the branch rule.

# Error handling

## Default: `anyhow`

Application code (everything in `src/`) uses `anyhow::Result<T>`. It gives you
cheap `?` propagation and a context chain that prints a clear story:

```rust
let text = std::fs::read_to_string(&path)
    .with_context(|| format!("reading config file `{}`", path.display()))?;
```

`main.rs` renders errors through `exit::message_for`, writes diagnostics to
stderr via `src/output.rs`, and exits with a code from `src/exit.rs`. That's all
most CLIs need.

## When to reach for `thiserror`

Add `thiserror` only if you split logic into a **library crate with a public,
stable error type** that callers match on. For a single binary, it's overkill —
`anyhow` is better because you don't have to enumerate every failure.

If you do need it:

```sh
cargo add thiserror
```

```rust
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    #[error("no item named `{0}`")]
    NotFound(String),
    #[error("database error")]
    Db(#[from] rusqlite::Error),
}
```

Return `Result<T, StoreError>` from the library; the binary can still wrap those
in `anyhow` with `?` and add context.

## Exit codes

`src/exit.rs` defines the stable codes. To make a specific error exit non-`1`,
attach a `CodedError`:

```rust
use crate::exit::{CodedError, ExitCode};
return Err(anyhow::Error::msg("no profile named `default`"))
    .context(CodedError::new(ExitCode::NotFound));
```

`code_for` walks the error chain and returns that code; everything else exits
`1`.

## Rules

- Add context at boundaries (file, network, parse), not on every line.
- Quote identifiers/paths in `` `backticks` ``.
- Never `unwrap()`/`panic!` in non-test code — clippy enforces this.

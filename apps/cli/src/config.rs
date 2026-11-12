//! User configuration.
//!
//! The config file is TOML (comments allowed, friendly to hand-editing) and
//! lives at [`crate::paths::config_file`]. Loading is tolerant: a missing file
//! yields [`Config::default`], so a fresh install Just Works.
//!
//! Add a field: give it a `#[serde(default)]` (or make the whole struct default
//! via `#[serde(default)]` as below) so old config files keep parsing.

use std::io::{ErrorKind, Write};
use std::time::{Duration, Instant};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use tempfile::NamedTempFile;

/// Top-level configuration. `#[serde(default)]` means any missing key falls back
/// to its `Default`, so adding fields never breaks existing config files. Unknown
/// keys are rejected so misspelled settings cannot silently use defaults.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    /// Default local managed store (absolute path); used by every local
    /// command when `--root` is not given. Mutually exclusive with server for MCP.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub root: Option<std::path::PathBuf>,
    /// Per-user model cache shared by every store (absolute path). Default:
    /// `kb/models` under the platform cache directory. A directory that
    /// already holds the expected model files (e.g. another program's) is
    /// read as a source for private copies after their SHA-256 matches.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models_dir: Option<std::path::PathBuf>,
    /// Default canonical server origin; never a credential.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub server: Option<String>,
    /// Explicit HTTP(S) proxy origin. Ambient proxy variables are ignored.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy: Option<String>,
    /// The loopback `http://` origin whose plain-HTTP opt-in was given to
    /// `kb config set-server --allow-loopback-http`. Applies to that origin
    /// only; every other server still needs https or the per-command flag.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loopback_http_opt_in: Option<String>,
}

/// A config file is a few lines of TOML.
const MAX_CONFIG_BYTES: u64 = 1 << 20;

impl Config {
    /// Load config from disk, returning defaults if the file does not exist.
    pub fn load() -> Result<Self> {
        let config = Self::load_unchecked()?;
        config.validate()?;
        Ok(config)
    }

    /// Load and parse the file without checking its values: `kb config` is the
    /// repair tool, so an invalid `root` or `models_dir` must not lock it out
    /// (R3-L12). Everything else uses [`Config::load`].
    pub fn load_unchecked() -> Result<Self> {
        let path = crate::paths::config_file()?;
        // The shared untrusted-path opener: no link followed, no blocking
        // open on a FIFO, a regular file proven on the handle; bounded.
        let read = || -> std::io::Result<String> {
            use std::io::Read;
            let file = kb_local::paths::open_regular_read(&path).map_err(|e| match e {
                kb_local::StoreError::Io(e) => e,
                other => std::io::Error::other(other.to_string()),
            })?;
            let mut text = String::new();
            file.take(MAX_CONFIG_BYTES + 1).read_to_string(&mut text)?;
            if text.len() as u64 > MAX_CONFIG_BYTES {
                return Err(std::io::Error::other("config file is too large"));
            }
            Ok(text)
        };
        match read() {
            Ok(text) => toml::from_str(&text).map_err(|error: toml::de::Error| {
                // A parser's Display includes source excerpts and a serde
                // message may include rejected values. Never forward either:
                // malformed server/proxy settings can contain credentials.
                let offset = error.span().map_or(0, |span| span.start);
                let (line, column) = text.char_indices().take_while(|(at, _)| *at < offset)
                    .fold((1, 1), |(line, column), (_, ch)| {
                        if ch == '\n' { (line + 1, 1) } else { (line, column + 1) }
                    });
                let reason = if error.message().starts_with("unknown field") {
                    "unknown config setting"
                } else {
                    "invalid TOML or config setting"
                };
                anyhow::anyhow!(
                    "{reason} in config file `{}` at line {line}, column {column}; fix the file before changing settings",
                    path.display()
                )
            }),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e).with_context(|| format!("reading config file `{}`", path.display())),
        }
    }

    /// Write config to disk, creating the config directory if needed.
    pub fn save(&self) -> Result<()> {
        let _lock = mutation_lock()?;
        self.validate()?;
        self.persist()
    }

    /// Serialize the entire read/modify/validate/publish operation against
    /// other setters and initialization. Always read the latest file while
    /// holding the stable lock; the atomically replaced config is not a lock.
    pub fn update(change: impl FnOnce(&mut Self)) -> Result<Self> {
        let _lock = mutation_lock()?;
        let before = Self::load_unchecked()?;
        let mut config = before.clone();
        change(&mut config);
        config.save_changed(&before)?;
        Ok(config)
    }

    fn persist(&self) -> Result<()> {
        let (path, file) = self.write_temp()?;
        file.persist(&path)
            .map_err(|err| err.error)
            .with_context(|| format!("moving temporary config file to `{}`", path.display()))?;
        sync_parent_dir(&path)?;
        Ok(())
    }

    /// Write a repaired config: only the settings that differ from `before`
    /// (the file as loaded) must be valid, so fixing one bad setting is never
    /// blocked by another one that is still bad. The values left unchanged
    /// keep failing the commands that read them, with their own message.
    fn save_changed(&self, before: &Self) -> Result<()> {
        for key in Self::KEYS {
            if self.field(key) != before.field(key) {
                self.check(key)?;
            }
        }
        self.persist()
    }

    /// Write config only if no config file exists yet.
    pub fn save_new(&self) -> Result<bool> {
        let _lock = mutation_lock()?;
        self.validate()?;
        let path = crate::paths::config_file()?;
        if path
            .try_exists()
            .with_context(|| format!("checking whether config file `{}` exists", path.display()))?
        {
            return Ok(false);
        }

        let (path, file) = self.write_temp()?;
        match file.persist_noclobber(&path) {
            Ok(_) => {
                sync_parent_dir(&path)?;
                Ok(true)
            }
            Err(err) if err.error.kind() == ErrorKind::AlreadyExists => Ok(false),
            Err(err) => Err(err.error)
                .with_context(|| format!("moving temporary config file to `{}`", path.display())),
        }
    }

    fn write_temp(&self) -> Result<(std::path::PathBuf, NamedTempFile)> {
        // All publication paths hold mutation_lock, which creates this dir.
        let dir = crate::paths::config_dir()?;
        let path = crate::paths::config_file()?;
        let text = if *self == Self::default() {
            TEMPLATE.to_owned()
        } else {
            toml::to_string_pretty(self).context("serializing config")?
        };
        let mut file = NamedTempFile::new_in(&dir)
            .with_context(|| format!("creating temporary config file in `{}`", dir.display()))?;
        file.write_all(text.as_bytes())
            .with_context(|| format!("writing temporary config file for `{}`", path.display()))?;
        file.as_file()
            .sync_all()
            .with_context(|| format!("syncing temporary config file for `{}`", path.display()))?;
        Ok((path, file))
    }

    const KEYS: [&'static str; 5] = [
        "root",
        "models_dir",
        "server",
        "loopback_http_opt_in",
        "proxy",
    ];

    /// One setting's value, for change detection in [`Config::save_changed`].
    fn field(&self, key: &str) -> Option<String> {
        match key {
            "root" => self.root.as_ref().map(|p| p.display().to_string()),
            "models_dir" => self.models_dir.as_ref().map(|p| p.display().to_string()),
            "server" => self.server.clone(),
            "loopback_http_opt_in" => self.loopback_http_opt_in.clone(),
            "proxy" => self.proxy.clone(),
            _ => unreachable!("unknown config key `{key}`"),
        }
    }

    fn validate(&self) -> Result<()> {
        Self::KEYS.iter().try_for_each(|key| self.check(key))
    }

    /// Setter replies may contain unchanged invalid settings during repair.
    /// Omit invalid URLs, which can contain credentials, without changing disk.
    pub(crate) fn safe_for_output(&self) -> Self {
        let mut safe = self.clone();
        if self.check("server").is_err() {
            safe.server = None;
        }
        if self.check("proxy").is_err() {
            safe.proxy = None;
        }
        if self.check("loopback_http_opt_in").is_err() {
            safe.loopback_http_opt_in = None;
        }
        safe
    }

    /// Validate one setting.
    fn check(&self, key: &str) -> Result<()> {
        match key {
            // MCP hosts launch from arbitrary working directories: a relative
            // path would silently create a different store per launch (L-16).
            "root" | "models_dir" => {
                let path = if key == "root" {
                    &self.root
                } else {
                    &self.models_dir
                };
                if let Some(path) = path
                    && !path.is_absolute()
                {
                    let fix = if key == "root" {
                        "set-root"
                    } else {
                        "set-models-dir"
                    };
                    anyhow::bail!(
                        "`{key}` in the config file must be an absolute path (fix it with `kb config {fix} <absolute path>`)"
                    );
                }
            }
            "server" => {
                if let Some(server) = &self.server {
                    kb_client::origin::McpResource::parse(
                        server,
                        kb_client::origin::TransportPolicy::AllowLoopbackHttp,
                    )?;
                }
            }
            "loopback_http_opt_in" => {
                if let Some(origin) = &self.loopback_http_opt_in {
                    let resource = kb_client::origin::McpResource::parse(
                        origin,
                        kb_client::origin::TransportPolicy::AllowLoopbackHttp,
                    )?;
                    if resource.origin() != origin || !origin.starts_with("http://") {
                        anyhow::bail!("invalid loopback_http_opt_in in config file");
                    }
                }
            }
            "proxy" => {
                if let Some(proxy) = &self.proxy {
                    crate::auth::validate_proxy(proxy)?;
                }
            }
            _ => unreachable!("unknown config key `{key}`"),
        }
        Ok(())
    }
}

/// Stable OS lock shared by every config writer; never unlink this inode.
fn mutation_lock() -> Result<std::fs::File> {
    let dir = crate::paths::config_dir()?;
    // Owner-only on Unix, like the 0600 config file inside it.
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder
        .create(&dir)
        .with_context(|| format!("creating config directory `{}`", dir.display()))?;
    let file = kb_local::paths::open_regular(
        &dir.join(".config.lock"),
        kb_local::paths::no_follow_options()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false),
    )
    .context("opening config lock")?;
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(std::fs::TryLockError::WouldBlock) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(std::fs::TryLockError::WouldBlock) => {
                anyhow::bail!("another `kb` process is changing config; retry when it finishes");
            }
            Err(std::fs::TryLockError::Error(error)) => {
                return Err(error).context("locking config");
            }
        }
    }
}

/// What `kb config init` writes: every setting, commented out (L-16).
pub const TEMPLATE: &str = r#"# kb configuration. Every setting is optional; uncomment to use.
#
# Default local store for `kb mcp`, `kb model`, `kb sealed` and
# `kb providers` when `--root` is not given (absolute path). Set it with
# `kb config set-root <path>`.
# root = "/home/me/kb-store"
#
# Per-user model cache shared by every store (absolute path). A directory
# that already holds the model files (e.g. another program's) is used as-is
# when their SHA-256 matches. Default: `kb/models` in the platform cache dir.
# models_dir = "/home/me/.cache/kb/models"
#
# Default server for `kb mcp`, `kb login` and `kb export` (set it with
# `kb config set-server <url>`). `root` and `server` are mutually exclusive
# for `kb mcp` unless `--root` or `--server` is given.
# server = "https://kb.example.com"
#
# Explicit HTTP(S) proxy origin; ambient proxy variables are ignored.
# proxy = "http://proxy.example.com:3128"
"#;

/// Flush the directory entry created by the rename, so the config file itself
/// survives a crash — not just its contents. `sync_all` on the temp file makes
/// the *data* durable; fsync'ing the parent makes the *rename* durable. Opening
/// a directory as a file handle is a Unix concept, so this is a no-op elsewhere.
#[cfg(unix)]
pub(crate) fn sync_parent_dir(path: &std::path::Path) -> Result<()> {
    let dir = path
        .parent()
        .filter(|dir| !dir.as_os_str().is_empty())
        .unwrap_or_else(|| std::path::Path::new("."));
    std::fs::File::open(dir)
        .and_then(|dir_file| dir_file.sync_all())
        .with_context(|| format!("syncing directory `{}`", dir.display()))
}

#[cfg(not(unix))]
pub(crate) fn sync_parent_dir(_path: &std::path::Path) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_toml() {
        let cfg = Config::default();
        let text = toml::to_string_pretty(&cfg).expect("serialize");
        let back: Config = toml::from_str(&text).expect("deserialize");
        assert_eq!(cfg, back);
    }

    #[test]
    fn empty_file_is_default() {
        let cfg: Config = toml::from_str("").expect("empty toml is valid");
        assert_eq!(cfg, Config::default());
    }

    #[test]
    fn template_parses_to_defaults() {
        let cfg: Config = toml::from_str(TEMPLATE).expect("template is valid toml");
        assert_eq!(cfg, Config::default());
    }

    #[test]
    fn relative_paths_are_rejected() {
        for (key, value, command) in [
            (
                "root",
                "https://user:disposable-config-canary@kb.example",
                "set-root",
            ),
            ("models_dir", "disposable-config-canary", "set-models-dir"),
        ] {
            let text = format!("{key} = {}\n", toml::Value::String(value.into()));
            let cfg: Config = toml::from_str(&text).expect("parse");
            let error = cfg.validate().expect_err("relative path").to_string();
            assert!(error.contains(&format!("`{key}`")));
            assert!(error.contains(&format!("kb config {command} <absolute path>")));
            assert!(!error.contains("disposable-config-canary"));
        }
        // A platform-native absolute path (a drive or UNC prefix on Windows),
        // serialized as a TOML string.
        let absolute = std::env::temp_dir().join("kb-store");
        assert!(absolute.is_absolute());
        for key in ["root", "models_dir"] {
            let text = format!(
                "{key} = {}\n",
                toml::Value::String(absolute.display().to_string())
            );
            let cfg: Config = toml::from_str(&text).expect("parse");
            assert!(cfg.validate().is_ok(), "{text}");
        }
    }

    #[test]
    fn a_repair_only_checks_the_settings_it_changes() {
        let before: Config =
            toml::from_str("root = \"relative\"\nmodels_dir = \"models\"\n").expect("parse");
        let problems = |c: &Config| {
            Config::KEYS
                .iter()
                .filter_map(|key| c.check(key).err().map(|e| format!("{e:#}")))
                .collect::<Vec<_>>()
        };
        assert_eq!(problems(&before).len(), 2);
        let mut fixed = before.clone();
        let absolute = std::env::temp_dir().join("kb-store");
        fixed.root = Some(absolute);
        for key in Config::KEYS {
            if fixed.field(key) != before.field(key) {
                assert!(fixed.check(key).is_ok(), "{key}");
            }
        }
        // The setting left alone still reports, with its repair command.
        let problems = problems(&fixed);
        assert_eq!(problems.len(), 1);
        assert!(
            problems[0].contains("kb config set-models-dir"),
            "{problems:?}"
        );
        let mut worse = before.clone();
        worse.root = Some("still/relative".into());
        assert!(worse.check("root").is_err());
    }

    #[test]
    fn rejects_unknown_fields() {
        let error =
            toml::from_str::<Config>("modelsdir = '/tmp/models'\n").expect_err("unknown setting");
        assert!(error.to_string().contains("unknown field `modelsdir`"));
    }
}

//! OS secrets only. No process-global default store and no file fallback.
use crate::StoreError;
use std::fmt;
use zeroize::Zeroizing;
pub fn unavailable() -> StoreError {
    StoreError::StorageUnavailable("OS credential store unavailable; no plaintext fallback".into())
}
/// The keystore answered, but the entry is gone (deleted outside `kb`).
/// Callers that know whose key it was explain the recovery that exists for
/// it ([`provider_key_lost`], [`sealed_key_lost`]).
pub fn missing_entry() -> StoreError {
    StoreError::StorageUnavailable(
        "the OS keystore is reachable but has no entry for this key (it was removed outside kb)"
            .into(),
    )
}
pub(crate) fn is_missing_entry(e: &StoreError) -> bool {
    matches!((e, missing_entry()), (StoreError::StorageUnavailable(a), StoreError::StorageUnavailable(b)) if *a == b)
}
/// A provider revision's API key is gone: register the key again as a new
/// revision and attach it; the old revision stays unusable.
pub fn provider_key_lost(provider: &str) -> StoreError {
    StoreError::StorageUnavailable(format!(
        "the OS keystore has no API key for provider `{provider}` (it was removed outside kb); \
         register the key again as a new revision (`kb providers register --provider-id \
         {provider} ...`) and attach that revision (`kb providers attach`)"
    ))
}
/// The store's sealed master key is gone. It is never regenerated: the
/// store's sealed records cannot be decrypted and no new value can be
/// enrolled in it. Revoking needs no key; a new store has its own key.
pub fn sealed_key_lost() -> StoreError {
    StoreError::StorageUnavailable(
        "the OS keystore has no sealed master key for this store (it was removed outside kb); \
         kb never regenerates it, so this store's sealed values cannot be read and new ones \
         cannot be enrolled here. `kb sealed revoke` still removes each reference (no key \
         needed); enroll new sealed values in a new store (`--root`), which creates its own key"
            .into(),
    )
}
/// Exit status of the native worker for a missing keystore entry.
pub const MISSING_ENTRY_EXIT: i32 = 3;
/// Run the native worker and map its result to its process exit status.
pub fn credential_worker_exit() -> i32 {
    match credential_worker() {
        Ok(()) => 0,
        Err(e) if is_missing_entry(&e) => MISSING_ENTRY_EXIT,
        Err(_) => 1,
    }
}
pub struct Secret(Zeroizing<String>);
impl Secret {
    pub fn new(value: String) -> Self {
        Self(Zeroizing::new(value))
    }
    pub fn expose(&self) -> &str {
        &self.0
    }
    pub(crate) fn valid(&self) -> bool {
        !self.0.is_empty()
            && self.0.len() <= 16384
            && self.0.bytes().all(|b| (0x21..=0x7e).contains(&b))
    }
}
impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret([redacted])")
    }
}
/// Trusted host seam; never supplied by MCP/config/provider input.
pub trait Credentials {
    fn set(&self, account: &str, secret: &Secret) -> Result<(), StoreError>;
    fn get(&self, account: &str) -> Result<Secret, StoreError>;
    /// Missing entry is successful deletion; every other error fails closed.
    fn delete(&self, account: &str) -> Result<(), StoreError>;
    fn set_controlled(
        &self,
        account: &str,
        secret: &Secret,
        ctl: &crate::embedder::ProviderControl,
        _: &crate::locks::CredentialFence,
    ) -> Result<(), StoreError> {
        ctl.check()?;
        self.set(account, secret)
    }
    fn delete_controlled(
        &self,
        account: &str,
        ctl: &crate::embedder::ProviderControl,
        _: &crate::locks::CredentialFence,
    ) -> Result<(), StoreError> {
        ctl.check()?;
        self.delete(account)
    }
    /// Synchronous bounded caller retaining the same lifecycle fence.
    fn get_sync_controlled(
        &self,
        account: &str,
        ctl: &crate::embedder::ProviderControl,
        _: &crate::locks::CredentialFence,
    ) -> Result<Secret, StoreError> {
        ctl.check()?;
        self.get(account)
    }
    fn get_controlled<'a>(
        &'a self,
        account: &'a str,
        ctl: &'a crate::embedder::ProviderControl,
        _: &'a crate::locks::CredentialFence,
    ) -> crate::egress::IoFuture<'a, Secret> {
        Box::pin(async move {
            ctl.check()?;
            self.get(account)
        })
    }
}
/// The executable is a trusted host choice, never read from provider config.
/// Native calls happen in a kill/reap child, with bounded zeroizing pipe input.
pub struct NativeCredentials {
    executable: std::path::PathBuf,
}
impl NativeCredentials {
    pub fn new(executable: std::path::PathBuf) -> Self {
        Self { executable }
    }
    fn start(
        &self,
        op: &str,
        account: &str,
        secret: &str,
        fence: Option<&crate::locks::CredentialFence>,
    ) -> Result<NativeCall, StoreError> {
        use std::process::{Command, Stdio};
        let input =
            Zeroizing::new(serde_json::to_vec(&(op, account, secret)).map_err(|_| unavailable())?);
        let mut command = Command::new(&self.executable);
        command
            .arg("--kb-native-credential-worker")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null());
        let child = if let Some(fence) = fence {
            fence.spawn_native(command)?
        } else {
            #[cfg(unix)]
            let native = command.spawn().map_err(|_| unavailable())?;
            #[cfg(windows)]
            let native = crate::win::spawn(&command, crate::win::Input::Pipe, None)
                .map_err(|_| unavailable())?;
            crate::git_read::ProcessChild::new(native, None)
        };
        NativeCall::new(child, input, fence.is_some())
    }
    fn call(
        &self,
        op: &str,
        account: &str,
        secret: &str,
        ctl: &crate::embedder::ProviderControl,
        fence: Option<&crate::locks::CredentialFence>,
    ) -> Result<Secret, StoreError> {
        ctl.check()?;
        let mut call = self.start(op, account, secret, fence)?;
        loop {
            ctl.check()?;
            if let Some(result) = call.poll()? {
                return result;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
}
/// Owns all threads and the child until reaped, including cancellation/error.
struct NativeCall {
    child: crate::git_read::ProcessChild,
    writer: Option<std::thread::JoinHandle<std::io::Result<()>>>,
    reader: Option<std::thread::JoinHandle<std::io::Result<Zeroizing<Vec<u8>>>>>,
}
impl NativeCall {
    fn new(
        child: crate::git_read::ProcessChild,
        input: Zeroizing<Vec<u8>>,
        fenced: bool,
    ) -> Result<Self, StoreError> {
        use std::io::{Read, Write};
        // Install the reap guard before any fallible pipe setup. Errors retain
        // the lifecycle lease through kill/wait just like cancellation does.
        let mut call = Self {
            child,
            writer: None,
            reader: None,
        };
        let mut stdin = call.child.stdin.take().ok_or_else(unavailable)?;
        let mut stdout = call.child.stdout.take().ok_or_else(unavailable)?;
        let (ready_tx, ready_rx) = std::sync::mpsc::channel();
        call.writer = Some(std::thread::spawn(move || {
            if fenced {
                ready_rx.recv().map_err(std::io::Error::other)?;
            }
            stdin.write_all(&input)
        }));
        call.reader = Some(std::thread::spawn(move || {
            if fenced {
                let mut ready = [0];
                stdout.read_exact(&mut ready)?;
                if ready != [1] {
                    return Err(std::io::Error::other("native credential readiness"));
                }
                ready_tx.send(()).map_err(std::io::Error::other)?;
            }
            let mut bytes = Zeroizing::new(Vec::new());
            stdout.take(16385).read_to_end(&mut bytes)?;
            Ok(bytes)
        }));
        Ok(call)
    }
    fn poll(&mut self) -> Result<Option<Result<Secret, StoreError>>, StoreError> {
        let Some(status) = self.child.try_wait().map_err(|_| unavailable())? else {
            return Ok(None);
        };
        let written = self
            .writer
            .take()
            .ok_or_else(unavailable)?
            .join()
            .map_err(|_| unavailable())?;
        let bytes = self
            .reader
            .take()
            .ok_or_else(unavailable)?
            .join()
            .map_err(|_| unavailable())?
            .map_err(|_| unavailable())?;
        if status.code() == Some(MISSING_ENTRY_EXIT) && written.is_ok() {
            return Ok(Some(Err(missing_entry())));
        }
        if !status.success() || written.is_err() || bytes.len() > 16384 {
            return Ok(Some(Err(unavailable())));
        }
        Ok(Some(
            std::str::from_utf8(&bytes)
                .map(|text| Secret::new(text.to_owned()))
                .map_err(|_| unavailable()),
        ))
    }
}
impl Drop for NativeCall {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        if let Some(writer) = self.writer.take() {
            let _ = writer.join();
        }
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}
impl Credentials for NativeCredentials {
    fn set(&self, account: &str, secret: &Secret) -> Result<(), StoreError> {
        self.call("set", account, secret.expose(), &Default::default(), None)
            .map(|_| ())
    }
    fn get(&self, account: &str) -> Result<Secret, StoreError> {
        self.call("get", account, "", &Default::default(), None)
    }
    fn delete(&self, account: &str) -> Result<(), StoreError> {
        self.call("delete", account, "", &Default::default(), None)
            .map(|_| ())
    }
    fn set_controlled(
        &self,
        account: &str,
        secret: &Secret,
        ctl: &crate::embedder::ProviderControl,
        fence: &crate::locks::CredentialFence,
    ) -> Result<(), StoreError> {
        self.call("set", account, secret.expose(), ctl, Some(fence))
            .map(|_| ())
    }
    fn delete_controlled(
        &self,
        account: &str,
        ctl: &crate::embedder::ProviderControl,
        fence: &crate::locks::CredentialFence,
    ) -> Result<(), StoreError> {
        self.call("delete", account, "", ctl, Some(fence))
            .map(|_| ())
    }
    fn get_sync_controlled(
        &self,
        account: &str,
        ctl: &crate::embedder::ProviderControl,
        fence: &crate::locks::CredentialFence,
    ) -> Result<Secret, StoreError> {
        self.call("get", account, "", ctl, Some(fence))
    }
    fn get_controlled<'a>(
        &'a self,
        account: &'a str,
        ctl: &'a crate::embedder::ProviderControl,
        fence: &'a crate::locks::CredentialFence,
    ) -> crate::egress::IoFuture<'a, Secret> {
        Box::pin(async move {
            ctl.check()?;
            let mut call = self.start("get", account, "", Some(fence))?;
            loop {
                ctl.check()?;
                if let Some(result) = call.poll()? {
                    return result;
                }
                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }
        })
    }
}
/// Private binary dispatch before clap/logging. No errors or secrets are printed.
pub fn credential_worker() -> Result<(), StoreError> {
    use std::io::{Read, Write};
    // Independent of the owner's lifetime: an abrupt owner death cannot
    // leave a stalled helper holding the account indefinitely. Native effects
    // remain bound to the durable intent and matching immutable account.
    std::thread::spawn(|| {
        std::thread::sleep(std::time::Duration::from_secs(10));
        std::process::exit(1);
    });
    let args = std::env::args_os().skip(2).collect::<Vec<_>>();
    let _native_fence = match args.as_slice() {
        [] => None,
        [flag, path] if flag == "--kb-native-credential-fence" => {
            let fence = crate::locks::native_credential_lock(std::path::Path::new(path))?;
            // Readiness precedes credential input. If the owner dies before
            // this handshake, stdin is empty/EOF and this worker cannot apply
            // stale effects after a successor. Otherwise the native fence
            // serializes the old effect before any successor's deletion/set.
            std::io::stdout()
                .write_all(&[1])
                .map_err(|_| unavailable())?;
            std::io::stdout().flush().map_err(|_| unavailable())?;
            Some(fence)
        }
        _ => return Err(unavailable()),
    };
    let mut bytes = Zeroizing::new(Vec::new());
    std::io::stdin()
        .take(33793)
        .read_to_end(&mut bytes)
        .map_err(|_| unavailable())?;
    if bytes.len() > 33792 {
        return Err(unavailable());
    }
    let (op, account, secret): (String, String, Zeroizing<String>) =
        serde_json::from_slice(&bytes).map_err(|_| unavailable())?;
    if account.len() > 256
        || !account
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err(unavailable());
    }
    let native = DirectNative;
    match op.as_str() {
        "set" => {
            let secret = Secret::new(secret.to_string());
            if !secret.valid() {
                return Err(unavailable());
            }
            native.set(&account, &secret)?;
        }
        "delete" => native.delete(&account)?,
        "get" => {
            let value = native.get(&account)?;
            std::io::stdout()
                .write_all(value.expose().as_bytes())
                .map_err(|_| unavailable())?;
        }
        _ => return Err(unavailable()),
    }
    Ok(())
}
/// Native connections are confined to the private worker; errors are redacted.
struct DirectNative;
impl DirectNative {
    fn entry(&self, account: &str) -> Result<keyring_core::Entry, StoreError> {
        use keyring_core::api::CredentialStoreApi;
        #[cfg(target_os = "linux")]
        let store = zbus_secret_service_keyring_store::Store::new();
        #[cfg(target_os = "macos")]
        let store = apple_native_keyring_store::keychain::Store::new();
        #[cfg(target_os = "windows")]
        let store = windows_native_keyring_store::Store::new();
        store
            .map_err(|_| unavailable())?
            .build("knowledge-base-provider-v1", account, None)
            .map_err(|_| unavailable())
    }
}
impl Credentials for DirectNative {
    fn set(&self, account: &str, secret: &Secret) -> Result<(), StoreError> {
        // Windows passwords are UTF-16 blobs with a 2560-byte native ceiling.
        // Immutable request-bound accounts permit deterministic retry of eight
        // raw 2048-byte entries. Publish their length last, inside the account
        // fence; no partial value can be read as a registered credential.
        #[cfg(windows)]
        {
            for (i, chunk) in secret.expose().as_bytes().chunks(2048).enumerate() {
                self.entry(&format!("{account}-{i}"))?
                    .set_secret(chunk)
                    .map_err(|_| unavailable())?;
            }
            self.entry(account)?
                .set_password(&secret.expose().len().to_string())
                .map_err(|_| unavailable())
        }
        #[cfg(not(windows))]
        self.entry(account)?
            .set_password(secret.expose())
            .map_err(|_| unavailable())
    }
    fn get(&self, account: &str) -> Result<Secret, StoreError> {
        #[cfg(windows)]
        {
            let len: usize = self
                .entry(account)?
                .get_password()
                .map_err(|e| match e {
                    keyring_core::Error::NoEntry => missing_entry(),
                    _ => unavailable(),
                })?
                .parse()
                .map_err(|_| unavailable())?;
            if !(1..=16384).contains(&len) {
                return Err(unavailable());
            }
            let mut bytes = Zeroizing::new(Vec::with_capacity(len));
            for i in 0..len.div_ceil(2048) {
                let part = Zeroizing::new(
                    self.entry(&format!("{account}-{i}"))?
                        .get_secret()
                        .map_err(|_| unavailable())?,
                );
                if part.len() != (len - bytes.len()).min(2048) {
                    return Err(unavailable());
                }
                bytes.extend_from_slice(&part);
            }
            std::str::from_utf8(&bytes)
                .map(|text| Secret::new(text.to_owned()))
                .map_err(|_| unavailable())
        }
        #[cfg(not(windows))]
        self.entry(account)?
            .get_password()
            .map(Secret::new)
            .map_err(|e| match e {
                keyring_core::Error::NoEntry => missing_entry(),
                _ => unavailable(),
            })
    }
    fn delete(&self, account: &str) -> Result<(), StoreError> {
        // Always clear the fixed fragment inventory, even without a root
        // marker after interrupted storage. Missing entries are successful.
        #[cfg(windows)]
        for i in 0..8 {
            match self.entry(&format!("{account}-{i}"))?.delete_credential() {
                Ok(()) | Err(keyring_core::Error::NoEntry) => {}
                Err(_) => return Err(unavailable()),
            }
        }
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(keyring_core::Error::NoEntry) => Ok(()),
            Err(_) => Err(unavailable()),
        }
    }
}

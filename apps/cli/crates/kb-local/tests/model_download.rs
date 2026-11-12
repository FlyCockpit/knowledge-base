//! Task 58 executable contract fixture: the per-user model cache.
use kb_local::{
    model_download::{
        CachedFile, ModelCache, Verification, validate_addresses, validate_hop, verify_artifact,
    },
    qwen::{ModelDescriptor, descriptor},
};
use std::{io::Cursor, net::IpAddr};
mod support {
    pub mod fixture;
}
use support::fixture::{Fixture, canonical_file};

fn abc() -> ModelDescriptor {
    let mut m = descriptor("embeddinggemma-2-q8_0").expect("descriptor");
    m.size_bytes = 3;
    m.sha256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".into();
    m
}
/// Fixture roots inherit the host umask; trust needs owner-only ancestors.
fn private_root(f: &Fixture) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&f.root, std::fs::Permissions::from_mode(0o700))
            .expect("private fixture root");
    }
    #[cfg(not(unix))]
    let _ = f;
}
fn partials(dir: &std::path::Path) -> usize {
    std::fs::read_dir(dir)
        .expect("models")
        .map(|e| e.expect("entry"))
        .filter(|e| e.file_name().to_string_lossy().ends_with(".partial"))
        .count()
}
#[test]
fn download_allowlist_and_public_addresses_are_closed() {
    for url in [
        "http://huggingface.co/a",
        "https://huggingface.co.evil/a",
        "https://evil/a",
        "https://user@huggingface.co/a",
        "https://huggingface.co:444/a",
        "https://huggingface.co/a#x",
    ] {
        assert!(validate_hop(url).is_err(), "{url}");
    }
    for host in [
        "huggingface.co",
        "cdn-lfs.huggingface.co",
        "cas-bridge.xethub.hf.co",
        "us.aws.cdn.hf.co",
    ] {
        assert!(validate_hop(&format!("https://{host}/a?signature=x")).is_ok());
    }
    for ip in [
        "127.0.0.1",
        "10.0.0.1",
        "169.254.169.254",
        "::1",
        "::ffff:127.0.0.1",
    ] {
        assert!(
            validate_addresses(&[
                "1.1.1.1".parse().expect("task 58 fixture"),
                ip.parse().expect("task 58 fixture")
            ])
            .is_err()
        );
    }
    assert!(validate_addresses(&[]).is_err());
    assert!(validate_addresses(&["1.1.1.1".parse::<IpAddr>().expect("task 58 fixture")]).is_ok());
}
#[test]
fn cache_requires_an_absolute_directory() {
    assert!(ModelCache::new("relative/models".into()).is_err());
}
#[test]
fn publication_checks_size_hash_no_replace_and_cleans_partial() {
    let f = Fixture::new("model-download");
    private_root(&f);
    let dir = f.root.join("models");
    let cache = ModelCache::new(dir.clone()).expect("cache");
    let m = abc();
    // Publications create our own inode (recorded as ours) in the private
    // `verified/` and load in place there; `models_dir` is only read.
    let copy = cache.private_copy(&m).expect("copy path");
    assert_eq!(cache.cached(&m).expect("status"), CachedFile::Missing);
    assert_eq!(cache.verify(&m).expect("verify"), Verification::Missing);
    for bytes in [b"bad".as_slice(), b"ab", b"abcd"] {
        assert!(cache.publish_reader(&m, Cursor::new(bytes)).is_err());
    }
    assert!(!copy.exists());
    cache
        .publish_reader(&m, Cursor::new(b"abc"))
        .expect("publication");
    assert!(verify_artifact(&copy, &m).expect("verify"));
    assert_eq!(cache.verify(&m).expect("verify"), Verification::Verified);
    assert!(cache.resolve(&m).expect("ours").trusted);
    assert_eq!(
        cache.verified_path(&m).expect("path"),
        canonical_file(&copy)
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for d in [dir.clone(), dir.join("verified")] {
            let mode = std::fs::metadata(&d).expect("dir").permissions().mode();
            assert_eq!(
                mode & 0o777,
                0o700,
                "a created cache directory is owner-only"
            );
        }
    }
    // A conflicting file is retained, never removed to make publication succeed.
    std::fs::write(&copy, b"zzz").expect("conflict");
    let error = cache
        .publish_reader(&m, Cursor::new(b"abc"))
        .expect_err("conflict");
    assert!(error.to_string().contains("kb model remove"), "{error}");
    assert_eq!(std::fs::read(&copy).expect("kept"), b"zzz");
    assert_eq!(cache.verify(&m).expect("verify"), Verification::Mismatch);
    let error = cache.verified_path(&m).expect_err("mismatch");
    assert!(error.to_string().contains("SHA-256"), "{error}");
    assert_eq!(partials(&dir.join("verified")), 0);
    // `kb model remove` repairs it; the next publication succeeds.
    assert!(cache.remove(&m).expect("remove"));
    assert!(!cache.remove(&m).expect("absent"));
    cache
        .publish_reader(&m, Cursor::new(b"abc"))
        .expect("republication");
}
#[test]
fn foreign_model_directory_files_are_copied_once_never_loaded_in_place() {
    let f = Fixture::new("model-foreign-dir");
    private_root(&f);
    let dir = f.root.join("other-program");
    std::fs::create_dir(&dir).expect("dir");
    let m = abc();
    std::fs::write(dir.join(&m.file_name), b"abc").expect("existing weights");
    #[cfg(unix)]
    {
        // Another program's ordinary layout: not writable by group/other.
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).expect("dir");
        std::fs::set_permissions(
            dir.join(&m.file_name),
            std::fs::Permissions::from_mode(0o644),
        )
        .expect("file");
    }
    let cache = ModelCache::with_private(dir.clone(), f.root.join("private")).expect("cache");
    // Even an owner-only file we did not create is never parsed in place:
    // its hashed bytes are copied into our own inode, reused from then on.
    assert!(!cache.resolve(&m).expect("found").trusted);
    let loaded = cache.verified_path(&m).expect("private copy");
    let copy = canonical_file(&cache.private_copy(&m).expect("copy path"));
    assert_eq!(loaded, copy);
    assert!(cache.resolve(&m).expect("copy found first").trusted);
    assert_eq!(
        std::fs::read(dir.join(&m.file_name)).expect("source"),
        b"abc"
    );
    let executor = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("executor");
    // A verified file is never downloaded again.
    assert_eq!(
        executor
            .block_on(cache.download(&m, &mut |_, _| panic!("no transfer")))
            .expect("reused"),
        copy
    );
    // Old per-store weights are adopted only when their checksum matches.
    let other = ModelCache::new(f.root.join("adopted")).expect("cache");
    other.adopt(&m, &dir.join(&m.file_name)).expect("adopted");
    std::fs::write(f.root.join("bad"), b"abd").expect("bad");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(f.root.join("bad"), std::fs::Permissions::from_mode(0o600))
            .expect("bad");
    }
    assert!(
        ModelCache::new(f.root.join("adopted2"))
            .expect("cache")
            .adopt(&m, &f.root.join("bad"))
            .is_err()
    );
}
#[cfg(unix)]
#[test]
fn files_we_did_not_create_always_load_from_a_verified_private_copy() {
    use std::os::unix::fs::PermissionsExt;
    let mode = |p: &std::path::Path, m: u32| {
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(m)).expect("chmod")
    };
    let f = Fixture::new("model-trust");
    private_root(&f);
    let dir = f.root.join("shared");
    let private = f.root.join("private");
    std::fs::create_dir(&dir).expect("dir");
    mode(&dir, 0o755);
    let m = abc();
    let file = dir.join(&m.file_name);
    let cache = ModelCache::with_private(dir.clone(), private.clone()).expect("cache");
    // A link is never followed, loaded or removed through.
    let outside = f.root.join("outside");
    std::fs::write(&outside, b"abc").expect("outside");
    std::os::unix::fs::symlink(&outside, &file).expect("link");
    assert!(!verify_artifact(&file, &m).expect("link refused"));
    assert!(cache.verified_path(&m).is_err());
    assert!(!cache.remove(&m).expect("a link is never ours to delete"));
    assert_eq!(std::fs::read(&outside).expect("untouched"), b"abc");
    std::fs::remove_file(&file).expect("unlink");
    // Whatever its permissions, a file we did not create is never loaded in
    // place: its verified bytes are copied into our own inode.
    std::fs::write(&file, b"abc").expect("file");
    cache.adopt(&m, &file).expect("explicit use after removal");
    for (file_mode, dir_mode) in [
        (0o600, 0o700),
        (0o644, 0o755),
        (0o660, 0o755),
        (0o666, 0o755),
        (0o644, 0o770),
        (0o644, 0o777),
    ] {
        let _ = std::fs::remove_file(cache.private_copy(&m).expect("copy"));
        mode(&file, file_mode);
        mode(&dir, dir_mode);
        let found = cache.resolve(&m).expect("found");
        assert!(!found.trusted, "{file_mode:o}/{dir_mode:o}");
        let loaded = cache.verified_path(&m).expect("private copy");
        assert_eq!(
            loaded,
            canonical_file(&cache.private_copy(&m).expect("copy")),
            "{file_mode:o}/{dir_mode:o}"
        );
        let meta = std::fs::metadata(&loaded).expect("copy");
        assert_eq!(meta.permissions().mode() & 0o077, 0, "owner-only copy");
        assert_eq!(std::fs::read(&loaded).expect("copy"), b"abc");
        // The private copy is found first from now on.
        assert_eq!(cache.resolve(&m).expect("found").path, loaded);
        assert_eq!(cache.verify(&m).expect("verify"), Verification::Verified);
    }
    // Bad bytes in a shared file are never copied.
    let _ = std::fs::remove_file(cache.private_copy(&m).expect("copy"));
    std::fs::write(&file, b"abd").expect("tampered");
    assert!(cache.verified_path(&m).is_err());
    assert!(!cache.private_copy(&m).expect("copy").exists());
    // R3-L9: `remove` deletes the private copy and leaves the shared file
    // it did not create.
    std::fs::write(&file, b"abc").expect("file");
    cache.verified_path(&m).expect("copy again");
    assert!(cache.remove(&m).expect("removed"));
    assert!(file.exists() && !cache.private_copy(&m).expect("copy").exists());
}
#[cfg(unix)]
#[test]
fn a_file_replaced_between_verification_and_load_is_refused() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new("model-swap");
    private_root(&f);
    let dir = f.root.join("models");
    std::fs::create_dir(&dir).expect("dir");
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).expect("dir");
    let m = abc();
    let file = dir.join(&m.file_name);
    std::fs::write(&file, b"abc").expect("file");
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).expect("file");
    let cache = ModelCache::new(dir.clone()).expect("cache");
    let found = cache.resolve(&m).expect("found");
    // Replaced (new inode, same size and bytes) after the cheap stat.
    std::fs::remove_file(&file).expect("unlink");
    std::fs::write(&file, b"abc").expect("replacement");
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o600)).expect("file");
    let error = cache
        .prepare_load(&m, &found)
        .expect_err("identity changed");
    assert!(error.to_string().contains("changed"), "{error}");
    // A fresh resolve sees (and verifies) the new file.
    let again = cache.resolve(&m).expect("found");
    assert!(
        cache
            .prepare_load(&m, &again)
            .expect("loads")
            .still_current()
    );
}
#[cfg(unix)]
#[test]
fn intermediate_symlink_replacement_cannot_redirect_a_verified_load() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let f = Fixture::new("model-intermediate-link");
    private_root(&f);
    let target = f.root.join("protected");
    let attacker = f.root.join("attacker");
    let shared = f.root.join("group-writable");
    for dir in [&target, &attacker, &shared] {
        std::fs::create_dir(dir).expect("dir");
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)).expect("private dir");
    }
    std::fs::set_permissions(&shared, std::fs::Permissions::from_mode(0o770)).expect("shared");
    let m = abc();
    std::fs::write(target.join(&m.file_name), b"abc").expect("verified bytes");
    std::fs::set_permissions(
        target.join(&m.file_name),
        std::fs::Permissions::from_mode(0o600),
    )
    .expect("private file");
    std::fs::write(attacker.join(&m.file_name), b"bad").expect("unverified bytes");
    let link = shared.join("models");
    symlink(&target, &link).expect("configured alias");
    let cache = ModelCache::with_private(link.clone(), f.root.join("private")).expect("cache");
    let found = cache.resolve(&m).expect("resolve");
    // Not our inode: a source to copy, opened by its canonical spelling.
    assert!(!found.trusted);
    assert_eq!(found.path, canonical_file(&target.join(&m.file_name)));
    let prepared = cache.prepare_load(&m, &found).expect("prepare");
    let copy = canonical_file(&cache.private_copy(&m).expect("copy path"));
    assert_eq!(prepared.path, copy);
    std::fs::remove_file(&link).expect("replace alias");
    symlink(&attacker, &link).expect("redirect");
    assert_eq!(
        std::fs::read(&prepared.path).expect("native load path"),
        b"abc"
    );
    assert!(prepared.still_current());
    drop(prepared); // the per-model fence
    // A stale artifact keeps its canonical source: the redirect is ignored.
    std::fs::remove_file(&copy).expect("drop copy");
    assert_eq!(
        std::fs::read(&cache.prepare_load(&m, &found).expect("same artifact").path).expect("bytes"),
        b"abc"
    );
    std::fs::remove_file(&copy).expect("drop copy");
    assert!(
        cache.verified_path(&m).is_err(),
        "a fresh lookup through the redirected alias rejects bad bytes"
    );
    assert!(!copy.exists(), "bad bytes are never copied");
}

#[cfg(unix)]
#[test]
fn removal_fences_loads_and_never_touches_models_dir() {
    use std::{
        os::unix::fs::PermissionsExt,
        sync::mpsc,
        time::{Duration, Instant},
    };
    let f = Fixture::new("model-remove-adopt");
    private_root(&f);
    let dir = f.root.join("configured");
    let private = f.root.join("private");
    std::fs::create_dir(&dir).expect("dir");
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).expect("dir");
    let m = abc();
    let file = dir.join(&m.file_name);
    std::fs::write(&file, b"abc").expect("models_dir source");
    let cache = ModelCache::with_private(dir, private.clone()).expect("cache");
    let source = cache.resolve(&m).expect("source");
    assert!(!source.trusted);
    cache.prepare_load(&m, &source).expect("first private copy");
    // Removal holds the per-model fence while the worker confirms the release.
    let (parked_tx, parked_rx) = mpsc::channel();
    let (release_tx, release_rx) = mpsc::channel::<()>();
    let remover = {
        let (cache, m) = (cache.clone(), m.clone());
        std::thread::spawn(move || {
            cache.remove_quiesced(&m, &mut || {
                parked_tx.send(()).expect("parked");
                release_rx.recv().expect("release");
                Ok(())
            })
        })
    };
    parked_rx
        .recv_timeout(Duration::from_secs(3))
        .expect("removal holds the fence");
    let (tx, rx) = mpsc::channel();
    let loaders = [false, true].map(|adopt| {
        let (cache, m, source, file, tx) = (
            cache.clone(),
            m.clone(),
            source.clone(),
            file.clone(),
            tx.clone(),
        );
        std::thread::spawn(move || {
            let result = if adopt {
                cache.adopt(&m, &file).map(|_| ())
            } else {
                cache.prepare_load(&m, &source).map(|_| ())
            };
            tx.send((adopt, result.is_ok())).expect("result");
        })
    });
    let started = Instant::now();
    assert!(
        rx.recv_timeout(Duration::from_millis(100)).is_err(),
        "loads wait for removal"
    );
    release_tx.send(()).expect("release");
    let removal = remover.join().expect("remover").expect("removed");
    assert_eq!(removal.removed.len(), 1, "the private copy");
    assert_eq!(removal.kept.len(), 1, "models_dir is only read");
    for loader in loaders {
        loader.join().expect("loader");
    }
    // An explicit adoption may follow removal; an ordinary load either
    // sees that adoption or refuses. It cannot undo removal by itself.
    let outcomes = (0..2)
        .map(|_| {
            rx.recv_timeout(Duration::from_secs(3))
                .expect("load outcome")
        })
        .collect::<Vec<_>>();
    assert!(
        outcomes.contains(&(true, true)),
        "explicit adoption is allowed"
    );
    assert!(started.elapsed() < Duration::from_secs(10));
    assert_eq!(std::fs::read(&file).expect("source kept"), b"abc");
    assert!(cache.resolve(&m).expect("explicitly adopted copy").trusted);
}

#[test]
fn killed_writer_partials_are_reclaimed_only_under_the_cache_lock() {
    use std::io::BufRead;
    use std::process::{Command, Stdio};
    let f = Fixture::new("model-download-crash");
    private_root(&f);
    let dir = f.root.join("models");
    // Publications stage in the private `verified/` directory.
    let staged = dir.join("verified");
    let cache = ModelCache::new(dir.clone()).expect("cache");
    let m = abc();
    for _ in 0..2 {
        let mut writer = support::fixture::ChildGuard::new(
            Command::new(env!("CARGO_BIN_EXE_kb-model-fixture"))
                .arg("download-parent")
                .arg(&dir)
                .stdout(Stdio::piped())
                .spawn()
                .expect("writer"),
        );
        let mut ready = String::new();
        std::io::BufReader::new(writer.stdout.take().expect("stdout"))
            .read_line(&mut ready)
            .expect("ready");
        assert_eq!(ready.trim(), "ready");
        assert_eq!(partials(&staged), 1);
        // A live writer holds the cache lock: nobody reclaims its partial.
        assert!(cache.publish_reader(&m, Cursor::new(b"abc")).is_err());
        assert_eq!(
            partials(&staged),
            1,
            "must preserve another process's live writer"
        );
        writer.kill().expect("kill writer");
        writer.wait().expect("reap writer");
        drop(cache.lock().expect("lock after writer death"));
        assert_eq!(partials(&staged), 0, "abandoned partial must not survive");
    }
    std::fs::write(staged.join("unrelated.partial"), b"foreign").expect("foreign file");
    let g = descriptor("embeddinggemma-2-q8_0").expect("descriptor");
    std::fs::write(
        staged.join(format!(".{}.not-a-uuid.partial", g.file_name)),
        b"foreign",
    )
    .expect("foreign name");
    #[cfg(unix)]
    {
        let outside = f.root.join("outside");
        std::fs::write(&outside, b"untouched").expect("outside");
        let linked = staged.join(format!(
            ".{}.11111111-1111-4111-8111-111111111111.partial",
            g.file_name
        ));
        std::os::unix::fs::symlink(&outside, &linked).expect("foreign link");
        let hard = staged.join(format!(
            ".{}.33333333-3333-4333-8333-333333333333.partial",
            g.file_name
        ));
        std::fs::hard_link(&outside, &hard).expect("foreign hard link");
        drop(cache.lock().expect("selective recovery"));
        assert!(
            std::fs::symlink_metadata(&linked)
                .expect("retained link")
                .file_type()
                .is_symlink()
        );
        assert!(hard.exists());
        assert_eq!(std::fs::read(&outside).expect("outside"), b"untouched");
    }
    drop(cache.lock().expect("final recovery"));
    assert_eq!(
        std::fs::read(staged.join("unrelated.partial")).expect("foreign preserved"),
        b"foreign"
    );
    cache
        .publish_reader(&m, Cursor::new(b"abc"))
        .expect("healthy publication after recovery");
}

/// #6: with one directory for downloads and private copies (the default),
/// a checksum-valid group-writable file gets a distinct, owner-only copy.
#[cfg(unix)]
#[test]
fn a_private_copy_never_collides_with_its_source_in_the_default_cache() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new("model-same-dir-copy");
    private_root(&f);
    let dir = f.root.join("models");
    std::fs::create_dir(&dir).expect("dir");
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).expect("dir");
    let m = abc();
    let file = dir.join(&m.file_name);
    std::fs::write(&file, b"abc").expect("file");
    std::fs::set_permissions(&file, std::fs::Permissions::from_mode(0o660)).expect("shared");
    let cache = ModelCache::new(dir.clone()).expect("cache");
    let found = cache.resolve(&m).expect("found");
    assert!(!found.trusted);
    let prepared = cache.prepare_load(&m, &found).expect("private copy");
    assert_ne!(prepared.path, found.path);
    assert_eq!(
        prepared.path,
        canonical_file(&cache.private_copy(&m).expect("copy"))
    );
    let meta = std::fs::metadata(&prepared.path).expect("copy");
    assert_eq!(meta.permissions().mode() & 0o077, 0, "owner-only copy");
    assert!(prepared.trusted && prepared.still_current());
    drop(prepared);
    // The verified copy is what a load finds from now on.
    assert!(cache.resolve(&m).expect("copy").trusted);
    // R3-L9: the source `kb` did not create stays.
    assert!(cache.remove(&m).expect("removed"));
    assert!(file.exists() && !cache.private_copy(&m).expect("copy").exists());
}

/// ROOT B: a resident model is keyed on the full trust result of the file a
/// request finds, not only its identity: a mode or directory-chain change
/// stops it serving; the reload uses a verified private copy, or is refused
/// when even that copy is no longer protected.
#[cfg(unix)]
#[test]
fn a_resident_model_stops_serving_when_its_files_trust_changes() {
    use kb_local::model_download::Resident;
    use std::os::unix::fs::PermissionsExt;
    let mode = |p: &std::path::Path, m: u32| {
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(m)).expect("chmod")
    };
    let f = Fixture::new("model-resident-trust");
    private_root(&f);
    let dir = f.root.join("models");
    std::fs::create_dir(&dir).expect("dir");
    mode(&dir, 0o700);
    let m = abc();
    let cache = ModelCache::new(dir.clone()).expect("cache");
    // Published into the owner-only configured directory as our own,
    // recorded inode: it loads in place.
    let file = cache
        .publish_reader(&m, Cursor::new(b"abc"))
        .expect("our own inode");
    assert_eq!(
        file,
        canonical_file(&cache.private_copy(&m).expect("copy path"))
    );
    let load = |found: &kb_local::model_download::Artifact| {
        let prepared = cache.prepare_load(&m, found).expect("verified load");
        Resident::new(&m.model_id, found, &prepared, ())
    };
    let found = cache.resolve(&m).expect("found");
    assert!(found.trusted);
    let resident = load(&found);
    assert!(resident.serves(&m.model_id, &cache.resolve(&m).expect("again")));
    assert!(!resident.serves("other-model", &found));
    // File mode: same inode, size and mtime, but no longer owner-only.
    let inode = |p: &std::path::Path| {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata(p).expect("file").ino()
    };
    let before = inode(&file);
    mode(&file, 0o660);
    let changed = cache.resolve(&m).expect("found");
    assert!(!changed.trusted);
    assert!(!resident.serves(&m.model_id, &changed), "0660 file");
    // No longer protected: never loaded in place, only copied while hashed
    // into a fresh inode of ours at the same place.
    let copied = cache
        .prepare_load(&m, &changed)
        .expect("fresh private copy");
    assert!(copied.trusted);
    assert_ne!(inode(&copied.path), before);
    drop(copied);
    // Restoring the mode never restores trust: it moved ctime, so the inode
    // no longer matches its creation mark (a writer may have kept a handle
    // from the loosened window). It loads from a fresh inode of ours.
    let before = inode(&file);
    mode(&file, 0o660);
    mode(&file, 0o600);
    let restored = cache.resolve(&m).expect("restored");
    assert!(
        !restored.trusted,
        "a permission-restored inode is not trusted"
    );
    assert!(!resident.serves(&m.model_id, &restored));
    let resident = load(&restored);
    let copy = cache.resolve(&m).expect("fresh copy");
    assert!(copy.trusted && inode(&copy.path) != before);
    // Directory chain: the directory (and `verified/` below it) becomes
    // group-writable. Nothing resident serves; the reload is refused.
    mode(&dir, 0o770);
    let unsafe_copy = cache.resolve(&m).expect("found");
    assert!(!unsafe_copy.trusted);
    assert!(
        !resident.serves(&m.model_id, &unsafe_copy),
        "0770 directory"
    );
    let error = cache
        .prepare_load(&m, &unsafe_copy)
        .expect_err("refused, never loaded");
    assert!(error.to_string().contains("another user"), "{error}");
    // R3-L12: the error names the model cache, never the store.
    assert!(
        error.to_string().starts_with("unsafe path: model cache: "),
        "{error}"
    );
    mode(&dir, 0o700);
}

/// ROOT B on Windows: an ACL that lets another account write the file stops
/// a resident model serving it.
#[cfg(windows)]
#[test]
fn a_resident_model_stops_serving_when_its_files_acl_is_broadened() {
    use kb_local::model_download::Resident;
    let f = Fixture::new("model-resident-acl");
    let dir = f.root.join("models");
    let cache = ModelCache::new(dir.clone()).expect("cache");
    let m = abc();
    let file = cache
        .publish_reader(&m, Cursor::new(b"abc"))
        .expect("owner-only publication");
    let found = cache.resolve(&m).expect("found");
    assert!(found.trusted, "published files are owner-only");
    let prepared = cache.prepare_load(&m, &found).expect("verified load");
    let resident = Resident::new(&m.model_id, &found, &prepared, ());
    drop(prepared);
    assert!(resident.serves(&m.model_id, &cache.resolve(&m).expect("again")));
    let output = std::process::Command::new("icacls")
        .arg(&file)
        .args(["/grant", "*S-1-1-0:M"])
        .output()
        .expect("fixture ACL");
    assert!(output.status.success(), "{output:?}");
    let changed = cache.resolve(&m).expect("found");
    assert!(!changed.trusted);
    assert!(!resident.serves(&m.model_id, &changed));
}

/// #1: a writer swaps the resolved model file for a FIFO before the load
/// opens it. No reader blocks in `open` (no writer ever connects here): each
/// refuses at once on the opened handle's type.
#[cfg(unix)]
#[test]
fn a_fifo_swapped_in_after_resolve_is_refused_without_blocking() {
    use std::{os::unix::fs::PermissionsExt, sync::mpsc, time::Duration};
    let f = Fixture::new("model-fifo");
    private_root(&f);
    for shared in [false, true] {
        let dir = f.root.join(if shared { "shared" } else { "own" });
        std::fs::create_dir(&dir).expect("dir");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).expect("dir");
        let m = abc();
        let file = dir.join(&m.file_name);
        std::fs::write(&file, b"abc").expect("file");
        // Shared: group-writable, so the load would copy it privately.
        let mode = if shared { 0o660 } else { 0o600 };
        std::fs::set_permissions(&file, std::fs::Permissions::from_mode(mode)).expect("mode");
        let cache = ModelCache::with_private(dir.clone(), f.root.join(format!("p-{shared}")))
            .expect("cache");
        let found = cache.resolve(&m).expect("regular file found");
        std::fs::remove_file(&file).expect("unlink");
        assert!(
            std::process::Command::new("mkfifo")
                .arg(&file)
                .status()
                .expect("mkfifo")
                .success()
        );
        let (tx, rx) = mpsc::channel();
        {
            let (cache, m, found, file) = (cache.clone(), m.clone(), found.clone(), file.clone());
            std::thread::spawn(move || {
                let load = cache.prepare_load(&m, &found).map(|_| ());
                let verify = cache.verify(&m);
                let artifact = verify_artifact(&file, &m);
                let adopt = cache.adopt(&m, &file).map(|_| ());
                let _ = tx.send((load, verify, artifact, adopt));
            });
        }
        let (load, verify, artifact, adopt) = rx
            .recv_timeout(Duration::from_secs(10))
            .expect("no reader blocks on a FIFO");
        assert!(load.is_err(), "load refused (shared={shared})");
        assert_ne!(verify.ok(), Some(Verification::Verified));
        assert_ne!(artifact.ok(), Some(true));
        assert!(adopt.is_err());
        std::fs::remove_file(&file).expect("fifo cleanup");
    }
}

/// #5: status and verification name the file they inspected: with a valid
/// private copy and a missing or corrupted configured source, that is the
/// private copy, not the source.
#[cfg(unix)]
#[test]
fn status_and_verify_report_the_file_actually_inspected() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new("model-inspected-path");
    private_root(&f);
    let dir = f.root.join("configured");
    std::fs::create_dir(&dir).expect("dir");
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).expect("dir");
    let m = abc();
    let source = dir.join(&m.file_name);
    std::fs::write(&source, b"abc").expect("source");
    std::fs::set_permissions(&source, std::fs::Permissions::from_mode(0o660)).expect("shared");
    let cache = ModelCache::with_private(dir, f.root.join("private")).expect("cache");
    let copy = canonical_file(&cache.verified_path(&m).expect("private copy"));
    for corrupt in [true, false] {
        if corrupt {
            std::fs::write(&source, b"abd").expect("corrupt source");
        } else {
            std::fs::remove_file(&source).expect("missing source");
        }
        let (result, file) = cache.verify_file(&m).expect("verify");
        assert_eq!(
            (result, canonical_file(&file)),
            (Verification::Verified, copy.clone())
        );
        let (cached, file) = cache.cached_file(&m).expect("status");
        assert_eq!(
            (cached, canonical_file(&file)),
            (CachedFile::Present, copy.clone())
        );
    }
    // Without the copy: the configured path, reported missing.
    std::fs::remove_file(&copy).expect("drop copy");
    assert_eq!(
        cache.verify_file(&m).expect("verify"),
        (Verification::Missing, source.clone())
    );
    // A corrupted source alone is the mismatching file reported.
    std::fs::write(&source, b"abdd").expect("wrong size");
    assert_eq!(
        cache.verify_file(&m).expect("verify"),
        (Verification::Mismatch, source)
    );
}

/// Round 6 (THE trust rule): a writer that opened a file while it was
/// group-writable keeps its descriptor after the permissions become
/// owner-only. The file is never parsed in place: the native load reads a
/// fresh inode of ours filled from the hashed stream, so the retained
/// writer's later changes never reach it.
#[cfg(unix)]
#[test]
fn a_retained_writer_cannot_change_the_bytes_the_native_load_parses() {
    use std::{io::Write, os::unix::fs::PermissionsExt};
    let f = Fixture::new("model-retained-writer");
    private_root(&f);
    let dir = f.root.join("configured");
    std::fs::create_dir(&dir).expect("dir");
    let m = abc();
    let source = dir.join(&m.file_name);
    std::fs::write(&source, b"abc").expect("source");
    std::fs::set_permissions(&source, std::fs::Permissions::from_mode(0o660)).expect("shared");
    // The other writer opens it now and keeps the descriptor.
    let mut writer = std::fs::OpenOptions::new()
        .write(true)
        .open(&source)
        .expect("retained writer");
    // The owner then makes everything owner-only.
    std::fs::set_permissions(&source, std::fs::Permissions::from_mode(0o600)).expect("private");
    std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).expect("private");
    let cache = ModelCache::with_private(dir, f.root.join("private")).expect("cache");
    let found = cache.resolve(&m).expect("found");
    assert!(!found.trusted, "permissions alone never make a file ours");
    let prepared = cache.prepare_load(&m, &found).expect("verified copy");
    assert_ne!(
        prepared.path, found.path,
        "the parser never opens the source"
    );
    // Between verification and the native parse, the retained writer strikes.
    writer.write_all(b"bad").expect("retained write");
    writer.sync_all().expect("sync");
    assert_eq!(std::fs::read(&found.path).expect("source"), b"bad");
    assert_eq!(std::fs::read(&prepared.path).expect("parsed bytes"), b"abc");
    assert!(prepared.still_current());
}

/// models_dir decision: downloads go where the user configured them. An
/// owner-only configured chain receives our own recorded inode, loaded in
/// place with no copy; a replacement there is not ours. A configured
/// directory others can change receives nothing: the publication lands in
/// `verified/`.
#[cfg(unix)]
#[test]
fn publications_always_go_to_the_private_cache_never_to_models_dir() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new("model-configured-publish");
    private_root(&f);
    let m = abc();
    for (name, dir_mode) in [("configured", 0o700), ("shared", 0o770)] {
        let dir = f.root.join(name);
        std::fs::create_dir(&dir).expect("dir");
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(dir_mode)).expect("mode");
        let cache = ModelCache::with_private(dir.clone(), f.root.join(format!("{name}-private")))
            .expect("cache");
        let published = cache
            .publish_reader(&m, Cursor::new(b"abc"))
            .expect("published");
        assert_eq!(
            published,
            canonical_file(&cache.private_copy(&m).expect("copy"))
        );
        assert!(!dir.join(&m.file_name).exists(), "models_dir is only read");
        let found = cache.resolve(&m).expect("found");
        assert!(found.trusted, "our recorded inode");
        let prepared = cache.prepare_load(&m, &found).expect("in place");
        assert_eq!(prepared.path, found.path, "no copy");
    }
}

/// Round 7 (closed world): our own inodes too. A writer keeps a handle opened
/// while our recorded publication or our `verified/` copy was loosened; after
/// the mode is restored the inode's ctime no longer matches its creation
/// mark, so the native load reads a fresh inode filled from the hashed
/// stream, and the retained writer's changes never reach it. A file in
/// `verified/` without a mark (planted, or left by anything but us) is not
/// trusted by its location either.
#[cfg(unix)]
#[test]
fn retained_writers_on_our_own_inodes_never_reach_the_parsed_bytes() {
    use std::{io::Write, os::unix::fs::PermissionsExt};
    let mode = |p: &std::path::Path, m: u32| {
        std::fs::set_permissions(p, std::fs::Permissions::from_mode(m)).expect("chmod")
    };
    let f = Fixture::new("model-retained-own");
    private_root(&f);
    let m = abc();
    let cache =
        ModelCache::with_private(f.root.join("configured"), f.root.join("private")).expect("cache");
    // (a) A recorded publication (in the private `verified/`).
    let published = cache
        .publish_reader(&m, Cursor::new(b"abc"))
        .expect("our own inode");
    assert!(cache.resolve(&m).expect("found").trusted);
    // (b) Our `verified/` copy: the source is loosened, so a load copies it.
    let attack = |target: &std::path::Path| {
        mode(target, 0o660);
        let writer = std::fs::OpenOptions::new()
            .write(true)
            .open(target)
            .expect("retained writer");
        mode(target, 0o600);
        writer
    };
    let inode = |p: &std::path::Path| {
        use std::os::unix::fs::MetadataExt;
        std::fs::metadata(p).expect("file").ino()
    };
    let before = inode(&published);
    let mut writer = attack(&published);
    let found = cache.resolve(&m).expect("found");
    assert_eq!(found.path, published);
    assert!(
        !found.trusted,
        "restored permissions do not restore provenance"
    );
    let prepared = cache.prepare_load(&m, &found).expect("fresh copy");
    assert_ne!(inode(&prepared.path), before);
    writer.write_all(b"bad").expect("retained write");
    writer.sync_all().expect("sync");
    assert_eq!(std::fs::read(&prepared.path).expect("parsed"), b"abc");
    let copy = prepared.path.clone();
    drop(prepared);
    // The copy is ours and marked; then it is attacked the same way.
    let found = cache.resolve(&m).expect("copy found first");
    assert_eq!(found.path, copy);
    assert!(found.trusted);
    let mut writer = attack(&copy);
    let found = cache.resolve(&m).expect("found");
    assert!(
        !found.trusted,
        "a verified/ file is not trusted by location"
    );
    let prepared = cache.prepare_load(&m, &found).expect("replaced copy");
    writer
        .write_all(b"bad")
        .expect("retained write to the old inode");
    writer.sync_all().expect("sync");
    assert_eq!(std::fs::read(&prepared.path).expect("parsed"), b"abc");
    drop(prepared);
    assert!(cache.resolve(&m).expect("fresh").trusted);
    // (c) An unmarked file planted in `verified/`.
    let planted = cache.private_copy(&m).expect("copy path");
    std::fs::remove_file(&planted).expect("unlink");
    std::fs::write(&planted, b"abc").expect("planted");
    mode(&planted, 0o600);
    assert!(
        !cache.resolve(&m).expect("found").trusted,
        "no mark, no trust"
    );
}

/// R3-L9 / review #1: `remove` deletes only `kb`'s own creation-marked copy
/// in its private `verified/` (damaged since or not) and names it; a file in
/// `models_dir` is only ever read, so it is kept and reported with the reason.
#[test]
fn remove_deletes_only_files_kb_created_and_reports_them() {
    use kb_local::model_download::{Kept, KeptReason};
    let f = Fixture::new("model-remove-ownership");
    private_root(&f);
    let dir = f.root.join("models");
    let cache = ModelCache::new(dir.clone()).expect("cache");
    let m = abc();
    let file = dir.join(&m.file_name);
    // Downloads land in `verified/`, never in `models_dir`.
    let published = cache
        .publish_reader(&m, Cursor::new(b"abc"))
        .expect("published");
    assert_eq!(
        canonical_file(&published),
        canonical_file(&cache.private_copy(&m).expect("copy"))
    );
    assert!(!file.exists());
    // Ours, then damaged in place: still ours to delete.
    std::fs::write(&published, b"abd").expect("damaged");
    let removal = cache.remove_quiesced(&m, &mut || Ok(())).expect("remove");
    assert_eq!(removal.removed, vec![canonical_file(&published)]);
    assert!(removal.kept.is_empty());
    assert!(!published.exists());
    // A file in `models_dir`: copied into `verified/` to load; remove deletes
    // the copy and keeps the source, saying why.
    std::fs::write(&file, b"abc").expect("models_dir file");
    let copy = cache
        .adopt(&m, &file)
        .expect("explicit adoption after removal");
    let removal = cache.remove_quiesced(&m, &mut || Ok(())).expect("remove");
    assert_eq!(removal.removed, vec![canonical_file(&copy)]);
    let kept = vec![Kept {
        path: file.clone(),
        reason: KeptReason::ModelsDir,
    }];
    assert_eq!(removal.kept, kept);
    assert!(KeptReason::ModelsDir.why().contains("only reads"));
    assert_eq!(std::fs::read(&file).expect("kept"), b"abc");
    let removal = cache.remove_quiesced(&m, &mut || Ok(())).expect("again");
    assert!(removal.removed.is_empty());
    assert_eq!(removal.kept, kept);
}

/// `kb model download` and the load agree on the file: a same-size damaged
/// private copy (which loads would find first) is dropped, not shadowing
/// the configured file forever.
#[test]
fn a_damaged_private_copy_never_shadows_a_good_configured_file() {
    let f = Fixture::new("model-damaged-copy");
    private_root(&f);
    let dir = f.root.join("models");
    let cache = ModelCache::new(dir.clone()).expect("cache");
    let m = abc();
    std::fs::create_dir_all(&dir).expect("dir");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)).expect("dir");
    }
    std::fs::write(dir.join(&m.file_name), b"abc").expect("foreign source");
    let copy = canonical_file(&cache.verified_path(&m).expect("private copy"));
    assert_eq!(copy, canonical_file(&cache.private_copy(&m).expect("copy")));
    std::fs::write(&copy, b"abd").expect("damaged copy");
    assert!(
        cache.verified_path(&m).is_err(),
        "the damaged copy is found first"
    );
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    let path = rt
        .block_on(cache.download(&m, &mut |_, _| {}))
        .expect("no download needed: the configured file verifies");
    assert_eq!(canonical_file(&path), copy);
    assert_eq!(std::fs::read(&copy).expect("private copy restored"), b"abc");
    assert_eq!(
        std::fs::read(cache.verified_path(&m).expect("loads again")).expect("bytes"),
        b"abc"
    );
}

/// Review r2 #1/#3: provenance is the directory. `verified/` is `kb`'s own
/// (created by `kb`, owner-only, identity recorded), so whatever is in it is
/// `kb`'s to delete; a directory swapped in under that name is not, and
/// nothing in it is ever deleted.
#[cfg(unix)]
#[test]
fn deletion_trusts_only_the_verified_directory_kb_created() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new("model-own-private");
    private_root(&f);
    let dir = f.root.join("models");
    let cache = ModelCache::new(dir.clone()).expect("cache");
    cache.ensure_dirs().expect("dirs");
    let m = abc();
    let copy = cache.private_copy(&m).expect("copy path");
    std::fs::write(&copy, b"abd").expect("unmarked file in kb's dir");
    std::fs::set_permissions(&copy, std::fs::Permissions::from_mode(0o600)).expect("mode");
    let removal = cache.remove_quiesced(&m, &mut || Ok(())).expect("remove");
    assert_eq!(
        removal.removed,
        vec![canonical_file(&dir.join("verified")).join(&m.file_name)]
    );
    assert!(!copy.exists());
    // Another directory renamed in place of `verified/`: not kb's.
    let verified = dir.join("verified");
    let elsewhere = f.root.join("elsewhere");
    std::fs::create_dir(&elsewhere).expect("dir");
    std::fs::set_permissions(&elsewhere, std::fs::Permissions::from_mode(0o700)).expect("mode");
    std::fs::write(elsewhere.join(&m.file_name), b"abc").expect("another program's model");
    std::fs::rename(&verified, f.root.join("old-verified")).expect("move kb's dir away");
    std::fs::rename(&elsewhere, &verified).expect("swap in another dir");
    let error = cache
        .remove_quiesced(&m, &mut || Ok(()))
        .expect_err("not the directory kb created");
    assert!(
        error.to_string().contains("not the private model cache"),
        "{error}"
    );
    assert_eq!(
        std::fs::read(verified.join(&m.file_name)).expect("kept"),
        b"abc"
    );
    // Download's damaged-copy cleanup asks the same question.
    std::fs::write(verified.join(&m.file_name), b"abd").expect("damaged");
    std::fs::write(dir.join(&m.file_name), b"abc").expect("good source");
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("runtime");
    assert!(rt.block_on(cache.download(&m, &mut |_, _| {})).is_err());
    assert_eq!(
        std::fs::read(verified.join(&m.file_name)).expect("kept"),
        b"abd"
    );
}

/// Review #1: a `verified/` that is a symlink to another directory is never
/// followed to delete what is there.
#[cfg(unix)]
#[test]
fn a_symlinked_private_cache_directory_is_never_followed() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new("model-symlinked-private");
    private_root(&f);
    let dir = f.root.join("models");
    let elsewhere = f.root.join("elsewhere");
    for d in [&dir, &elsewhere] {
        std::fs::create_dir_all(d).expect("dir");
        std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o700)).expect("mode");
    }
    let cache = ModelCache::new(dir.clone()).expect("cache");
    let m = abc();
    let victim = elsewhere.join(&m.file_name);
    std::fs::write(&victim, b"abc").expect("another program's model");
    std::os::unix::fs::symlink(&elsewhere, dir.join("verified")).expect("symlink");
    assert!(cache.remove_quiesced(&m, &mut || Ok(())).is_err());
    assert_eq!(std::fs::read(&victim).expect("kept"), b"abc");
}

#[tokio::test]
async fn removal_blocks_automatic_source_adoption_until_an_explicit_download() {
    let f = Fixture::new("model-removed-source");
    private_root(&f);
    let cache =
        ModelCache::with_private(f.root.join("source"), f.root.join("private")).expect("cache");
    cache.ensure_dirs().expect("dirs");
    let m = abc();
    let file = cache.file(&m).expect("source");
    std::fs::write(&file, b"abc").expect("source bytes");
    let found = cache.resolve(&m).expect("source artifact");
    cache.prepare_load(&m, &found).expect("first adoption");
    cache.remove(&m).expect("remove");
    let reopened =
        ModelCache::with_private(cache.dir().into(), cache.private_dir().into()).expect("reopen");
    assert_eq!(reopened.cached(&m).expect("status"), CachedFile::Missing);
    assert!(reopened.resolve(&m).is_err());
    assert!(
        reopened.prepare_load(&m, &found).is_err(),
        "a pre-removal artifact cannot republish"
    );
    assert!(!reopened.private_copy(&m).expect("copy").exists());
    assert_eq!(std::fs::read(&file).expect("source kept"), b"abc");
    reopened
        .download(&m, &mut |_, _| {})
        .await
        .expect("explicit download re-adopts without networking");
    assert_eq!(reopened.cached(&m).expect("status"), CachedFile::Present);
    assert!(reopened.verified_path(&m).expect("copy").exists());
}

#[test]
fn a_panicking_crash_test_reaps_its_parked_model_writer() {
    use std::io::BufRead;
    use std::process::{Command, Stdio};
    let f = Fixture::new("model-writer-unwind");
    private_root(&f);
    let dir = f.root.join("models");
    let cache = ModelCache::new(dir.clone()).expect("cache");
    let result = std::panic::catch_unwind(|| {
        let mut writer = support::fixture::ChildGuard::new(
            Command::new(env!("CARGO_BIN_EXE_kb-model-fixture"))
                .arg("download-parent")
                .arg(&dir)
                .stdout(Stdio::piped())
                .spawn()
                .expect("writer"),
        );
        let mut ready = String::new();
        std::io::BufReader::new(writer.stdout.take().expect("stdout"))
            .read_line(&mut ready)
            .expect("ready");
        assert_eq!(ready.trim(), "ready");
        panic!("injected assertion failure after the writer starts");
    });
    assert!(result.is_err());
    // The failed test cannot leave a process holding the cache lock or partial.
    drop(
        cache
            .lock()
            .expect("writer was killed and reaped during unwind"),
    );
    assert_eq!(partials(&dir.join("verified")), 0);
    cache
        .publish_reader(&abc(), Cursor::new(b"abc"))
        .expect("fresh publication");
}

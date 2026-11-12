//! Spec-first CAS and trusted MIME boundary tests; native on all release OSes.
use std::io::{Cursor, Read};
use std::sync::{Arc, Barrier};

use base64::{Engine, engine::general_purpose::STANDARD};
use kb_client::{snapshot::content_hash, types::Mime};
use kb_local::{Store, cas::publish_cas, mime::validate_media};

#[path = "support/fixture.rs"]
mod fixture;

/// Read the server's encoder fixtures directly, without another fixture copy.
fn media(name: &str) -> Vec<u8> {
    let source = include_str!("../../../../../packages/api/src/lib/kb/fixtures/media-bytes.ts");
    let body = source
        .split(&format!("export function {name}(): Buffer {{"))
        .nth(1)
        .expect("fixture operation");
    let body = body.split("\n}").next().expect("fixture operation");
    let encoded: String = body
        .split('"')
        .enumerate()
        .filter(|(i, _)| i % 2 == 1)
        .map(|(_, s)| s)
        .take_while(|s| *s != "base64" && *s != "hex")
        .collect();
    if body.contains("\"hex\"") {
        fixture::hex_to_bytes(&encoded)
    } else {
        let mut bytes = STANDARD.decode(encoded).expect("fixture operation");
        if name == "minimalWebp" {
            let size = (bytes.len() - 8) as u32;
            bytes[4..8].copy_from_slice(&size.to_le_bytes());
        }
        bytes
    }
}

#[test]
fn server_encoder_fixtures_agree_including_real_video_and_audio() {
    for (name, mime) in [
        ("minimalJpeg", Mime::ImageJpeg),
        ("progressiveJpeg", Mime::ImageJpeg),
        ("minimalPng", Mime::ImagePng),
        ("minimalGif", Mime::ImageGif),
        ("animatedGif", Mime::ImageGif),
        ("commentGif", Mime::ImageGif),
        ("minimalWebp", Mime::ImageWebp),
        ("realMp4", Mime::VideoMp4),
        ("realWebm", Mime::VideoWebm),
        ("cbrMp3NoTag", Mime::AudioMpeg),
        ("taggedMp3", Mime::AudioMpeg),
        ("vbrMp3", Mime::AudioMpeg),
        ("minimalWav", Mime::AudioWav),
        ("minimalOgg", Mime::AudioOgg),
        ("opusOgg", Mime::AudioOgg),
        ("minimalPdf", Mime::ApplicationPdf),
    ] {
        let bytes = media(name);
        assert!(validate_media(&bytes, mime).is_ok(), "{name}");
        assert!(
            validate_media(&bytes[..bytes.len() / 2], mime).is_err(),
            "truncated {name}"
        );
        assert!(validate_media(&bytes, Mime::TextPlain).is_err());
    }
}

#[test]
fn rejects_empty_unknown_active_content_mismatch_and_signature_only() {
    for bytes in [
        b"".as_slice(),
        b"unknown",
        b"<html>hi</html>",
        b"<?xml?><svg />",
        b"\xff\xd8\xff\xd9",
        b"\x89PNG\r\n\x1a\n",
        b"GIF89a",
        b"ID3\x04\0\0\0\0\0\0",
        b"%PDF-1.7\n%%EOF\n",
        b"OggS\0",
        b"RIFF\0\0\0\0WAVE",
    ] {
        for mime in [
            Mime::ImageJpeg,
            Mime::ImagePng,
            Mime::ImageGif,
            Mime::ImageWebp,
            Mime::VideoMp4,
            Mime::VideoWebm,
            Mime::AudioMpeg,
            Mime::AudioWav,
            Mime::AudioOgg,
            Mime::ApplicationPdf,
            Mime::ImageSvgXml,
        ] {
            assert!(validate_media(bytes, mime).is_err(), "{mime:?}");
        }
    }
    let png = media("minimalPng");
    assert!(validate_media(&png, Mime::ImageJpeg).is_err());
    let mut polyglot = png.clone();
    polyglot.extend_from_slice(b"<script>alert(1)</script>");
    assert!(validate_media(&polyglot, Mime::ImagePng).is_err());
}

#[test]
fn identical_publish_races_deduplicate_without_replacing_inode() {
    let f = fixture::Fixture::new("cas-race");
    let store = Store::open(&f.root.join("store")).expect("fixture operation");
    let paths = store.paths().clone();
    let barrier = Arc::new(Barrier::new(3));
    let workers: Vec<_> = (0..2)
        .map(|_| {
            let paths = paths.clone();
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                let bytes = media("minimalPng");
                barrier.wait();
                publish_cas(
                    &paths,
                    Cursor::new(&bytes),
                    &content_hash(&bytes),
                    bytes.len() as u64,
                    Mime::ImagePng,
                )
                .expect("fixture operation")
            })
        })
        .collect();
    barrier.wait();
    let blobs: Vec<_> = workers
        .into_iter()
        .map(|w| w.join().expect("fixture operation"))
        .collect();
    assert_eq!(blobs.iter().filter(|b| b.new_bytes).count(), 1);
    assert_eq!(blobs[0].path, blobs[1].path);
    assert_eq!(
        std::fs::read(&blobs[0].path).expect("fixture operation"),
        media("minimalPng")
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let inode = std::fs::metadata(&blobs[0].path)
            .expect("fixture operation")
            .ino();
        let bytes = media("minimalPng");
        publish_cas(
            &paths,
            Cursor::new(&bytes),
            &content_hash(&bytes),
            bytes.len() as u64,
            Mime::ImagePng,
        )
        .expect("fixture operation");
        assert_eq!(
            std::fs::metadata(&blobs[0].path)
                .expect("fixture operation")
                .ino(),
            inode
        );
    }
}

#[test]
fn corrupt_existing_hash_is_never_repaired_by_overwrite() {
    let f = fixture::Fixture::new("cas-corrupt");
    let store = Store::open(&f.root.join("store")).expect("fixture operation");
    let bytes = media("minimalPng");
    let hash = content_hash(&bytes);
    let blob = publish_cas(
        store.paths(),
        Cursor::new(&bytes),
        &hash,
        bytes.len() as u64,
        Mime::ImagePng,
    )
    .expect("fixture operation");
    let corrupt = vec![b'x'; bytes.len()];
    std::fs::write(&blob.path, &corrupt).expect("fixture operation");
    assert!(
        publish_cas(
            store.paths(),
            Cursor::new(&bytes),
            &hash,
            bytes.len() as u64,
            Mime::ImagePng
        )
        .is_err()
    );
    assert_eq!(
        std::fs::read(&blob.path).expect("fixture operation"),
        corrupt
    );
}

#[test]
fn destination_link_or_reparse_point_cannot_escape_or_overwrite() {
    let f = fixture::Fixture::new("cas-link");
    let store = Store::open(&f.root.join("store")).expect("fixture operation");
    let bytes = media("minimalPng");
    let hash = content_hash(&bytes);
    let blob = publish_cas(
        store.paths(),
        Cursor::new(&bytes),
        &hash,
        bytes.len() as u64,
        Mime::ImagePng,
    )
    .expect("fixture operation");
    std::fs::remove_file(&blob.path).expect("fixture operation");
    let outside = f.root.join("outside");
    std::fs::write(&outside, &bytes).expect("fixture operation");
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, &blob.path).expect("fixture operation");
    #[cfg(windows)]
    std::os::windows::fs::symlink_file(&outside, &blob.path)
        .expect("Windows lane requires developer-mode symlink capability");
    assert!(
        publish_cas(
            store.paths(),
            Cursor::new(&bytes),
            &hash,
            bytes.len() as u64,
            Mime::ImagePng
        )
        .is_err()
    );
    assert_eq!(std::fs::read(&outside).expect("fixture operation"), bytes);
}

#[test]
fn failed_stream_length_hash_or_mime_leaves_no_publish_or_temp() {
    struct Failed;
    impl Read for Failed {
        fn read(&mut self, _: &mut [u8]) -> std::io::Result<usize> {
            Err(std::io::Error::other("fixture"))
        }
    }
    let f = fixture::Fixture::new("cas-failure");
    let store = Store::open(&f.root.join("store")).expect("fixture operation");
    let bytes = media("minimalPng");
    let hash = content_hash(&bytes);
    assert!(
        publish_cas(
            store.paths(),
            Failed,
            &hash,
            bytes.len() as u64,
            Mime::ImagePng
        )
        .is_err()
    );
    for (size, declared_hash, mime) in [
        (bytes.len() as u64 + 1, hash.clone(), Mime::ImagePng),
        (bytes.len() as u64, content_hash(b"wrong"), Mime::ImagePng),
        (bytes.len() as u64, hash.clone(), Mime::ImageJpeg),
        (25 * 1024 * 1024 + 1, hash.clone(), Mime::ImagePng),
    ] {
        assert!(
            publish_cas(
                store.paths(),
                Cursor::new(&bytes),
                &declared_hash,
                size,
                mime
            )
            .is_err()
        );
    }
    assert_eq!(
        std::fs::read_dir(store.paths().assets_dir().join("tmp"))
            .expect("fixture operation")
            .count(),
        0
    );
}

struct PausedSource {
    bytes: Cursor<Vec<u8>>,
    entered: std::path::PathBuf,
    release: Option<Arc<Barrier>>,
    calls: usize,
}
impl Read for PausedSource {
    fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
        self.calls += 1;
        if self.calls == 2 {
            std::fs::write(&self.entered, b"streaming")?;
            if let Some(release) = &self.release {
                release.wait();
            } else {
                loop {
                    std::thread::park();
                }
            }
        }
        self.bytes.read(b)
    }
}
fn large_wav() -> Vec<u8> {
    let mut bytes = media("minimalWav");
    bytes.resize(128 * 1024, 0);
    let riff_size = (bytes.len() - 8) as u32;
    bytes[4..8].copy_from_slice(&riff_size.to_le_bytes());
    let start = bytes.windows(4).position(|s| s == b"data").expect("data");
    let size = (bytes.len() - start - 8) as u32;
    bytes[start + 4..start + 8].copy_from_slice(&size.to_le_bytes());
    bytes
}

fn wait_for_marker(path: &std::path::Path) {
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
    while !path.exists() {
        assert!(
            std::time::Instant::now() < deadline,
            "publisher boundary not reached"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
}
#[test]
fn cas_crash_child() {
    let Some(root) = std::env::var_os("KB_CAS_CRASH_CHILD") else {
        return;
    };
    let root = std::path::PathBuf::from(root);
    let store = Store::open(&root.join("store")).expect("store");
    let bytes = large_wav();
    let hash = content_hash(&bytes);
    let size = bytes.len() as u64;
    let source = PausedSource {
        bytes: Cursor::new(bytes),
        entered: root.join("entered"),
        release: None,
        calls: 0,
    };
    publish_cas(store.paths(), source, &hash, size, Mime::AudioWav).expect("publish");
    panic!("boundary not reached");
}
#[test]
fn cas_orphans_recover_after_kill_while_live_publishers_and_final_bytes_survive() {
    let f = fixture::Fixture::new("cas-crash");
    let root = f.root.join("store");
    let store = Store::open(&root).expect("store");
    let bytes = media("minimalPng");
    let historic = publish_cas(
        store.paths(),
        Cursor::new(&bytes),
        &content_hash(&bytes),
        bytes.len() as u64,
        Mime::ImagePng,
    )
    .expect("historic");
    drop(store);
    let mut child = fixture::ChildGuard::spawn(
        std::process::Command::new(std::env::current_exe().expect("exe"))
            .args(["--exact", "cas_crash_child", "--nocapture"])
            .env("KB_CAS_CRASH_CHILD", &f.root)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null()),
    )
    .expect("child");
    wait_for_marker(&f.root.join("entered"));
    let temps = root.join("assets/tmp");
    let abandoned: Vec<_> = std::fs::read_dir(&temps)
        .expect("temps")
        .map(|e| e.expect("entry").path())
        .collect();
    assert_eq!(abandoned.len(), 1);
    assert_eq!(
        std::fs::metadata(&abandoned[0])
            .expect("partial bytes")
            .len(),
        65536
    );
    child.kill().expect("kill child");
    assert!(!child.wait().expect("drain child").success());
    let store = Store::open(&root).expect("restart");
    assert_eq!(std::fs::read_dir(&temps).expect("temps").count(), 0);
    assert_eq!(std::fs::read(&historic.path).expect("historic"), bytes);
    let release = Arc::new(Barrier::new(2));
    let paths = store.paths().clone();
    let marker = f.root.join("live-entered");
    let r = release.clone();
    let m = marker.clone();
    let writer = std::thread::spawn(move || {
        let bytes = large_wav();
        let hash = content_hash(&bytes);
        let size = bytes.len() as u64;
        publish_cas(
            &paths,
            PausedSource {
                bytes: Cursor::new(bytes),
                entered: m,
                release: Some(r),
                calls: 0,
            },
            &hash,
            size,
            Mime::AudioWav,
        )
    });
    wait_for_marker(&marker);
    let successor = Store::open(&root).expect("open while streaming");
    successor
        .run_upload_timer_for_tests()
        .expect("nonblocking timer");
    assert_eq!(std::fs::read_dir(&temps).expect("live temp").count(), 1);
    release.wait();
    let blob = writer.join().expect("writer").expect("live publish");
    assert_eq!(std::fs::read(blob.path).expect("published"), large_wav());
    assert_eq!(std::fs::read_dir(&temps).expect("temps").count(), 0);
    // Already-fenced consumers have a non-reentrant entry with the same proof.
    let guard = successor.lock_write(&[]).expect("consumer fence");
    kb_local::cas::publish_cas_locked(
        successor.paths(),
        Cursor::new(&bytes),
        &content_hash(&bytes),
        bytes.len() as u64,
        Mime::ImagePng,
        &guard,
    )
    .expect("locked dedup");
}

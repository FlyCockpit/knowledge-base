//! Pack rollups run under a publication's lock: bounds, budgets, retries and interruption.

use super::*;

/// Every object name in the repository (packed and loose).
fn all_objects(repo: &Path) -> std::collections::BTreeSet<String> {
    git(
        repo,
        &[
            "cat-file",
            "--batch-all-objects",
            "--batch-check=%(objectname)",
        ],
    )
    .lines()
    .map(str::to_owned)
    .collect()
}

/// Batch fixture creation avoids a Git process and durability barrier per blob.
fn loose_blob_batch(repo: &Path, count: usize) -> Vec<String> {
    let inputs = repo.join("fixture-inputs");
    std::fs::create_dir(&inputs).expect("fixture directory");
    let mut list = String::new();
    for n in 0..count {
        let path = inputs.join(n.to_string());
        std::fs::write(&path, format!("tiny fixture blob {n}\n")).expect("fixture body");
        list.push_str(
            scratch_git::git_spelling(&path)
                .to_str()
                .expect("utf8 path"),
        );
        list.push('\n');
    }
    let input_list = inputs.join("paths");
    std::fs::write(&input_list, list).expect("fixture list");
    // File-fed stdin lets output() drain all the hashes while Git reads the
    // paths; writing a large list synchronously to a pipe can deadlock.
    let out = scratch_git()
        .arg("--git-dir")
        .arg(scratch_git::git_spelling(repo))
        .args([
            "-c",
            "core.fsync=none",
            "hash-object",
            "-w",
            "--stdin-paths",
        ])
        .stdin(std::fs::File::open(input_list).expect("fixture list"))
        .output()
        .expect("git hash-object");
    assert!(out.status.success());
    let names = String::from_utf8(out.stdout).expect("object names");
    std::fs::remove_dir_all(inputs).expect("fixture cleanup");
    names.lines().map(str::to_owned).collect()
}

/// An extra pack holding one new unreachable blob (raises the pack count
/// without a publication or a lock).
fn extra_pack(repo: &Path, body: &[u8]) -> String {
    let sha = loose_blob(repo, body);
    let prefix = scratch_git::git_spelling(&repo.join("objects/pack/pack"));
    git_with_input(
        repo,
        &["pack-objects", "-q", prefix.to_str().expect("utf8")],
        format!("{sha}\n").as_bytes(),
    );
    git(repo, &["prune-packed"]);
    sha
}

/// Publish until the repository holds `CONSOLIDATE_PACKS` packs: the state
/// right after a publication, before the next lock rolls them up.
fn publish_to_threshold(kb: &Kb, head: &mut Sha, tag: &str) -> Vec<String> {
    let mut paths = Vec::new();
    let mut i = 0;
    while indexed_pack_count(&kb.repo) < CONSOLIDATE_PACKS {
        assert!(i < 2 * CONSOLIDATE_PACKS, "one pack per publication");
        let path = format!("notes/{tag}{i}.md");
        *head = publish(kb, head, &format!("{tag}-key-{i:06}"), &path);
        paths.push(path);
        i += 1;
    }
    paths
}

/// Functional assertions exercise the real fold and cleanup with the
/// maintenance clock/admission controlled. Real budget kills live in recovery.
fn maintain_now(kb: &Kb) {
    let guard = kb
        .store
        .lock_write(std::slice::from_ref(&kb.kb))
        .expect("maintenance fence");
    for _ in 0..128 {
        if !kb
            .store
            .consolidate_now_for_tests(&guard)
            .expect("maintenance")
        {
            return;
        }
    }
    panic!("bounded cleanup batches did not finish");
}

/// One pack per publication with no Git maintenance would make every Git
/// spawn slower without bound, and rewriting the whole repository is no
/// remedy. Rollups are geometric: the pack count stays bounded, a large
/// pack is never rewritten, no object (reachable or not) is lost, a reader
/// that already mapped the old packs keeps resolving every object, and
/// concurrent kb-local reads stay correct throughout.
#[test]
#[cfg_attr(
    windows,
    ignore = "known Windows timing issue: Defender scans every loose object Git writes; follow-up: write fewer loose objects (cheaper tree-batch and pack writes)"
)]
fn pack_count_stays_bounded_and_reads_stay_correct_across_rollups() {
    let kb = new_kb("pack-bound");
    // A large unreachable pack at the freeze size (`CONSOLIDATE_FROZEN_BYTES`,
    // 16 MiB): never counted toward a rollup and never rewritten.
    let frozen = 16 << 20;
    let mut noise = Vec::with_capacity(frozen + 4096);
    let mut x: u64 = 0x9e37_79b9_7f4a_7c15;
    while noise.len() < frozen + 4096 {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        noise.extend_from_slice(&x.to_le_bytes());
    }
    let big_blob = extra_pack(&kb.repo, &noise);
    let big_pack = pack_names(&kb.repo)
        .into_iter()
        .find(|n| n.ends_with(".pack"))
        .expect("large pack");
    let big_inode = std::fs::metadata(kb.repo.join("objects/pack").join(&big_pack)).unwrap();
    // A long-lived raw reader that maps every pack as it appears.
    let mut reader = ChildGuard::new(
        scratch_git()
            .current_dir(&kb.repo)
            .args(["--git-dir", ".", "cat-file", "--batch-check"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .spawn()
            .expect("reader"),
    );
    let mut reader_in = reader.stdin.take().expect("stdin");
    let mut reader_out = BufReader::new(reader.stdout.take().expect("stdout"));
    let mut ask_all = |reader_in: &mut std::process::ChildStdin| {
        for name in all_objects(&kb.repo) {
            writeln!(reader_in, "{name}").expect("ask");
            let mut line = String::new();
            reader_out.read_line(&mut line).expect("answer");
            assert!(!line.ends_with("missing\n"), "live reader lost {name}");
        }
    };
    ask_all(&mut reader_in);
    let first = publish(&kb, &kb.main, "pack-bound-key-000000", "notes/n0.md");
    // Concurrent kb-local reads of the first document at its first commit.
    let root = kb.store.paths().root().to_path_buf();
    // One concurrent read per publication. A busy reader loop can monopolize
    // lock admission on a loaded host and keeps running if the publisher
    // panics; channel closure stops this reader on every exit path.
    std::thread::scope(|scope| {
        let (requests, requested) = std::sync::mpsc::channel::<()>();
        let (completed, completions) = std::sync::mpsc::channel::<()>();
        let concurrent = {
            let (kb_id, rev) = (kb.kb.clone(), first.clone());
            scope.spawn(move || {
                let store = Store::open(&root).expect("reader store");
                let mut reads = 0usize;
                while requested.recv().is_ok() {
                    let got = store.documents_get(
                        &store.owner(),
                        input::<DocumentsGet>(json!({
                            "kbId": kb_id.as_str(), "rev": rev.as_str(), "path": "notes/n0.md",
                        })),
                    );
                    match got {
                        Ok(doc) => {
                            assert_eq!(doc.markdown, "# notes/n0.md\n", "read stays correct")
                        }
                        // Lock admission may be busy behind a publication.
                        Err(e) => assert!(
                            matches!(
                                code(&e),
                                ErrorCode::DeadlineExceeded | ErrorCode::StorageUnavailable
                            ),
                            "unexpected read failure {e:?}"
                        ),
                    }
                    reads += 1;
                    let _ = completed.send(());
                }
                reads
            })
        };
        let mut revisions = vec![(first.clone(), 0usize)];
        let mut head = first;
        let (mut rolled, mut last) = (false, indexed_pack_count(&kb.repo));
        for i in 1..4 * CONSOLIDATE_PACKS {
            // The reader maps the current packs before the next rollup.
            ask_all(&mut reader_in);
            requests.send(()).expect("concurrent read requested");
            maintain_now(&kb);
            head = publish(
                &kb,
                &head,
                &format!("pack-bound-key-{i:06}"),
                &format!("notes/n{i}.md"),
            );
            completions.recv().expect("concurrent read finished");
            revisions.push((head.clone(), i));
            let packs = indexed_pack_count(&kb.repo);
            // The frozen pack plus at most the threshold of small ones.
            assert!(packs <= CONSOLIDATE_PACKS + 1, "{packs} packs after {i}");
            rolled |= packs < last;
            last = packs;
        }
        drop(requests);
        assert!(concurrent.join().expect("reader thread") > 0);
        assert!(rolled, "rollups ran");
        // The large pack was never rewritten.
        let still = std::fs::metadata(kb.repo.join("objects/pack").join(&big_pack))
            .expect("large pack kept");
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            assert_eq!(still.ino(), big_inode.ino(), "large pack untouched");
        }
        let _ = (still, big_inode);
        ask_all(&mut reader_in);
        drop(reader_in);
        assert!(reader.wait().expect("reader").success());
        assert!(
            all_objects(&kb.repo).contains(&big_blob),
            "unreachable object retained"
        );
        for (rev, i) in &revisions {
            assert_eq!(
                kb.get(rev, &format!("notes/n{i}.md"))
                    .expect("historical read"),
                format!("# notes/n{i}.md\n")
            );
        }
        git(&kb.repo, &["fsck", "--full", "--no-dangling"]);
        assert!(
            !std::fs::read_dir(kb.store.paths().uploads_dir())
                .expect("uploads")
                .any(|e| e
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with("publish-")),
            "no rollup scratch left"
        );
        assert_eq!(kb.store.pack_consolidation(&kb.kb).unwrap(), None);
    });
}

/// Loose objects alone (direct writes, aborted operations) trigger a rollup
/// at Git's `gc.auto` sample; they are packed, kept and pruned as loose.
#[test]
fn loose_object_sample_triggers_a_rollup_that_keeps_every_object() {
    let kb = new_kb("pack-loose");
    let mut sampled = Vec::new();
    let mut n = 0u64;
    while sampled.len() < 27 {
        let body = format!("loose {n}\n");
        n += 1;
        let header = format!("blob {}\0", body.len());
        let digest = ring::digest::digest(
            &ring::digest::SHA1_FOR_LEGACY_USE_ONLY,
            &[header.as_bytes(), body.as_bytes()].concat(),
        );
        if digest.as_ref()[0] == 0x17 {
            sampled.push(loose_blob(&kb.repo, body.as_bytes()));
        }
    }
    assert!(indexed_pack_count(&kb.repo) < CONSOLIDATE_PACKS);
    let objects = all_objects(&kb.repo);
    maintain_now(&kb);
    let fan = kb.repo.join("objects/17");
    assert_eq!(
        std::fs::read_dir(&fan).map(|d| d.count()).unwrap_or(0),
        0,
        "sampled loose objects were packed and pruned"
    );
    assert!(all_objects(&kb.repo).is_superset(&objects));
    for sha in &sampled {
        assert!(objects.contains(sha));
    }
    git(&kb.repo, &["fsck", "--full", "--no-dangling"]);
}

#[test]
fn scheduled_rollup_progresses_with_many_genuinely_unpacked_objects() {
    let kb = new_kb("rollup-mixed");
    for n in 0..32 {
        extra_pack(&kb.repo, format!("mixed pack {n}\n").as_bytes());
    }
    let loose = loose_blob_batch(&kb.repo, 12_000);
    let before = all_objects(&kb.repo);
    assert_eq!(indexed_pack_count(&kb.repo), 32);
    drop(
        kb.store
            .lock_publication(std::slice::from_ref(&kb.kb))
            .unwrap(),
    );
    // Scheduled work may defer anywhere in its wall-clock budget. Assert
    // functional completion through the controlled maintenance seam below.
    // Fsync/installation may consume the pass's budget. The regression is
    // useful folding under scheduled admission, not a deadline for every
    // selected unlink. A later cleanup must reuse that installed coverage.
    if let Some(deferred) = kb.store.pack_consolidation(&kb.kb).unwrap() {
        assert_eq!(deferred.code, "DEADLINE_EXCEEDED");
    }
    maintain_now(&kb);
    // A pre-install intent is discarded without retirement; its next pass
    // performs the fold from the preserved originals.
    maintain_now(&kb);
    assert!(
        indexed_pack_count(&kb.repo) < 32,
        "controlled fold makes progress"
    );
    let installed = pack_names(&kb.repo);
    maintain_now(&kb);
    assert_eq!(
        pack_names(&kb.repo),
        installed,
        "completed cleanup does not repack"
    );
    assert!(
        loose.iter().any(|sha| {
            !kb.repo
                .join("objects")
                .join(&sha[..2])
                .join(&sha[2..])
                .exists()
        }),
        "cleanup makes on-disk progress"
    );
    assert!(all_objects(&kb.repo).is_superset(&before));
    git(&kb.repo, &["fsck", "--full", "--no-dangling"]);
}

fn rollup_disk_budget(_: &kb_local::StorePaths, _: &Path) -> Result<u64, StoreError> {
    Ok(ROLLUP_FREE_BYTES.get())
}

#[test]
fn rollup_admission_includes_the_count_dense_pack_index_before_scratch() {
    let kb = new_kb("rollup-index-budget");
    let names = loose_blob_batch(&kb.repo, 52_000);
    for chunk in names.chunks(6_500) {
        git_with_input(
            &kb.repo,
            &[
                "pack-objects",
                "-q",
                scratch_git::git_spelling(&kb.repo.join("objects/pack/pack"))
                    .to_str()
                    .unwrap(),
            ],
            format!("{}\n", chunk.join("\n")).as_bytes(),
        );
    }
    git(&kb.repo, &["prune-packed", "-q"]);
    let before = pack_names(&kb.repo);
    let input_bytes: u64 = before
        .iter()
        .filter(|name| name.ends_with(".pack"))
        .map(|name| {
            std::fs::metadata(kb.repo.join("objects/pack").join(name))
                .unwrap()
                .len()
        })
        .sum();
    let objects_before = all_objects(&kb.repo);
    let loose_bytes = git(&kb.repo, &["count-objects", "-v"])
        .lines()
        .find_map(|line| {
            line.strip_prefix("size: ")
                .map(|n| n.parse::<u64>().unwrap() * 1024)
        })
        .unwrap();
    let old_allowance = input_bytes + loose_bytes + (1 << 20) + 4096;
    kb.store.set_disk_meter_for_tests(rollup_disk_budget);
    ROLLUP_FREE_BYTES.set((1 << 30) + old_allowance);
    maintain_now(&kb);
    assert_eq!(
        pack_names(&kb.repo),
        before,
        "old files remain and no replacement was installed"
    );
    assert_eq!(
        kb.store.pack_consolidation(&kb.kb).unwrap().unwrap().code,
        "QUOTA_EXCEEDED"
    );
    assert_eq!(
        std::fs::read_dir(kb.store.paths().uploads_dir())
            .unwrap()
            .count(),
        0,
        "admission precedes scratch creation"
    );
    // v2 SHA-1 index upper bound, including a large-offset entry per object.
    let index_bound = 1072 + objects_before.len() as u64 * 36;
    // The durable cleanup intent coexists with the index and all originals.
    let intent_bound = objects_before.len() as u64 * 128 + (8 + 20_000) * 1024;
    ROLLUP_FREE_BYTES.set((1 << 30) + old_allowance + index_bound + intent_bound);
    maintain_now(&kb);
    assert_eq!(kb.store.pack_consolidation(&kb.kb).unwrap(), None);
    assert_eq!(indexed_pack_count(&kb.repo), 1);
    let installed_bytes: u64 = pack_names(&kb.repo)
        .iter()
        .filter(|name| name.ends_with(".pack") || name.ends_with(".idx"))
        .map(|name| {
            std::fs::metadata(kb.repo.join("objects/pack").join(name))
                .unwrap()
                .len()
        })
        .sum();
    assert!(
        installed_bytes > old_allowance,
        "the omitted index would spend the disk floor"
    );
    assert!(
        installed_bytes <= input_bytes + loose_bytes + (1 << 20) + index_bound,
        "the full replacement fits while all original files still coexist"
    );
    assert!(all_objects(&kb.repo).is_superset(&objects_before));
    git(&kb.repo, &["fsck", "--full", "--no-dangling"]);
}

static NO_DISK: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
fn toggled_disk(_: &kb_local::StorePaths, _: &Path) -> Result<u64, StoreError> {
    Ok(if NO_DISK.load(std::sync::atomic::Ordering::Acquire) {
        0
    } else {
        u64::MAX / 4
    })
}

/// A rollup without disk headroom is deferred: the lock still succeeds, the
/// store is unchanged and valid, the deferral is recorded durably, and the
/// next locks do not repeat its cost until the pressure has grown by the
/// back-off step; a later success clears the record.
#[test]
fn a_deferred_rollup_backs_off_and_never_fails_the_lock() {
    let kb = new_kb("pack-defer");
    kb.store.set_disk_meter_for_tests(toggled_disk);
    let mut head = kb.main.clone();
    publish_to_threshold(&kb, &mut head, "defer");
    let before = pack_names(&kb.repo);
    NO_DISK.store(true, std::sync::atomic::Ordering::Release);
    maintain_now(&kb);
    assert_eq!(pack_names(&kb.repo), before, "nothing changed");
    let deferred = kb
        .store
        .pack_consolidation(&kb.kb)
        .unwrap()
        .expect("recorded");
    assert_eq!(deferred.code, "QUOTA_EXCEEDED");
    assert_eq!(deferred.deferrals, 1);
    // Back-off: further locks do not retry below the next level.
    for _ in 0..3 {
        drop(
            kb.store
                .lock_publication(std::slice::from_ref(&kb.kb))
                .unwrap(),
        );
    }
    assert_eq!(
        kb.store.pack_consolidation(&kb.kb).unwrap(),
        Some(deferred.clone())
    );
    let mut extra = 0;
    while (kb
        .store
        .pack_consolidation(&kb.kb)
        .unwrap()
        .unwrap()
        .deferrals
        == 1)
        && extra < 4 * CONSOLIDATE_PACKS
    {
        extra_pack(&kb.repo, format!("pressure {extra}\n").as_bytes());
        extra += 1;
        drop(
            kb.store
                .lock_publication(std::slice::from_ref(&kb.kb))
                .unwrap(),
        );
    }
    let again = kb.store.pack_consolidation(&kb.kb).unwrap().unwrap();
    assert_eq!(again.deferrals, 2, "retried once the pressure grew");
    assert!(again.level >= deferred.retry_level());
    assert!(again.retry_level() - again.level > deferred.retry_level() - deferred.level);
    git(&kb.repo, &["fsck", "--full", "--no-dangling"]);
    // With headroom back, the next due retry succeeds and clears the record.
    NO_DISK.store(false, std::sync::atomic::Ordering::Release);
    maintain_now(&kb);
    assert!(indexed_pack_count(&kb.repo) < CONSOLIDATE_PACKS);
    assert_eq!(
        kb.get(&head, "notes/defer0.md").expect("read"),
        "# notes/defer0.md\n"
    );
}

/// Failed attempts never shrink the cap. All the packs here are ~600 KiB,
/// with no loose objects: a 1 MiB cap could fold only one, and "nothing to
/// fold" would keep the KB stuck forever. Retry spacing must
/// recover without changing the cap or weakening its freeze bound.
#[test]
fn a_rollup_makes_progress_after_five_injected_failures() {
    let kb = new_kb("pack-progress");
    let mut random = 0x2545_f491_4f6c_dd1du64;
    for i in 0..9 {
        let blob: Vec<u8> = (0..600 * 1024)
            .map(|_| {
                random ^= random << 13;
                random ^= random >> 7;
                random ^= random << 17;
                random as u8
            })
            .collect();
        // Build fixture packs without per-blob durability barriers. The
        // production rollup below still performs every file/directory sync.
        let sha = git_with_input(
            &kb.repo,
            &["-c", "core.fsync=none", "hash-object", "-w", "--stdin"],
            &blob,
        );
        git_with_input(
            &kb.repo,
            &[
                "pack-objects",
                "-q",
                scratch_git::git_spelling(&kb.repo.join("objects/pack/pack"))
                    .to_str()
                    .unwrap(),
            ],
            format!("{sha}\n").as_bytes(),
        );
        if i == 0 {
            // Put the initial KB objects in a >512 KiB pack as well.
            git(&kb.repo, &["repack", "-ad", "--keep-unreachable"]);
        }
    }
    git(&kb.repo, &["prune-packed", "-q"]);
    assert!(
        pack_names(&kb.repo)
            .iter()
            .filter(|n| n.ends_with(".pack"))
            .all(|n| {
                std::fs::metadata(kb.repo.join("objects/pack").join(n))
                    .unwrap()
                    .len()
                    > 512 * 1024
            })
    );
    let before = indexed_pack_count(&kb.repo);
    let all = all_objects(&kb.repo);
    let guard = kb.store.lock_write(std::slice::from_ref(&kb.kb)).unwrap();
    kb.store.set_disk_meter_for_tests(|_, _| Ok(0));
    for failures in 1..=5 {
        kb.store
            .consolidate_now_for_tests(&guard)
            .expect("deferred fold");
        let row = kb
            .store
            .pack_consolidation(&kb.kb)
            .unwrap()
            .expect("failure");
        assert_eq!(row.deferrals, failures);
        assert_eq!(row.code, "QUOTA_EXCEEDED");
        assert_eq!(indexed_pack_count(&kb.repo), before);
    }
    kb.store.set_disk_meter_for_tests(|_, _| Ok(u64::MAX / 4));
    kb.store
        .consolidate_now_for_tests(&guard)
        .expect("progress");
    assert!(
        indexed_pack_count(&kb.repo) < before,
        "full-cap retry folded the small packs"
    );
    assert_eq!(kb.store.pack_consolidation(&kb.kb).unwrap(), None);
    assert!(
        indexed_pack_count(&kb.repo) < 8,
        "returned to a bounded steady state"
    );
    assert_eq!(all_objects(&kb.repo), all, "no objects lost");
    git(&kb.repo, &["fsck", "--full", "--no-dangling"]);
    drop(guard);
}

/// Retry history must also recover when there is nothing left to fold.
/// Failures never leave a sticky reduced cap, even for idle stores.
#[test]
fn a_repository_with_no_rollup_work_clears_old_failures() {
    let kb = new_kb("pack-idle");
    // Seed packs directly: the behavior under test is retry settlement,
    // independent of publication deadlines on a busy disk.
    for i in 0..CONSOLIDATE_PACKS {
        extra_pack(&kb.repo, format!("idle pack {i}\n").as_bytes());
    }
    let all = all_objects(&kb.repo);
    let guard = kb.store.lock_write(std::slice::from_ref(&kb.kb)).unwrap();
    kb.store.set_disk_meter_for_tests(|_, _| Ok(0));
    for _ in 0..5 {
        kb.store.consolidate_now_for_tests(&guard).unwrap();
    }
    assert_eq!(
        kb.store
            .pack_consolidation(&kb.kb)
            .unwrap()
            .unwrap()
            .deferrals,
        5
    );
    // Offline maintenance can resolve the pressure while its old deferral
    // remains. Exercise the real publication lock with that durable history.
    git(&kb.repo, &["repack", "-ad", "--keep-unreachable"]);
    git(&kb.repo, &["prune-packed", "-q"]);
    let before = pack_names(&kb.repo);
    assert_eq!(indexed_pack_count(&kb.repo), 1);
    drop(guard);
    drop(
        kb.store
            .lock_publication(std::slice::from_ref(&kb.kb))
            .unwrap(),
    );
    assert_eq!(kb.store.pack_consolidation(&kb.kb).unwrap(), None);
    assert_eq!(pack_names(&kb.repo), before, "no fold attempted");
    assert_eq!(all_objects(&kb.repo), all);
    git(&kb.repo, &["fsck", "--full", "--no-dangling"]);
}

/// A write to one KB never rolls up another KB's repository, and neither
/// does opening the store; the other KB's own next write does.
#[test]
fn rollups_run_only_for_the_written_kb() {
    let a = new_kb("pack-cross");
    let b_id = a
        .store
        .bases_create(
            &a.store.owner(),
            input::<BasesCreate>(json!({
                "name": "Other KB",
                "slug": "other",
                "description": "A second knowledge base in the same store",
                "idempotencyKey": "create-key-000000002",
            })),
        )
        .expect("second kb")
        .kb;
    let b = Kb {
        store: Store::open(a.store.paths().root()).expect("second handle"),
        repo: a.store.paths().repo_dir(&b_id.id),
        kb: b_id.id,
        main: b_id.head_sha,
        _root: a._root.clone(),
    };
    let mut b_head = b.main.clone();
    publish_to_threshold(&b, &mut b_head, "cross");
    let before = pack_names(&b.repo);
    publish(&a, &a.main, "cross-a-key-000001", "notes/a.md");
    drop(
        a.store
            .lock_publication(std::slice::from_ref(&a.kb))
            .unwrap(),
    );
    assert_eq!(pack_names(&b.repo), before, "a write to A leaves B alone");
    drop(Store::open(a.store.paths().root()).expect("reopen"));
    assert_eq!(pack_names(&b.repo), before, "store open leaves B alone");
    maintain_now(&b);
    assert!(
        indexed_pack_count(&b.repo) < CONSOLIDATE_PACKS,
        "B's own lock rolls up"
    );
}

/// The earlier sorted lock is a healthy import source. Speculative cleanup
/// must leave the maintenance slot available to the growing destination.
#[test]
fn rollup_no_work_source_does_not_starve_the_import_destination() {
    let a = new_kb("rollup-two-kbs");
    let created = a
        .store
        .bases_create(
            &a.store.owner(),
            input::<BasesCreate>(json!({
                "name": "Other KB", "slug": "other", "description": "Import destination fixture",
                "idempotencyKey": "rollup-second-0001",
            })),
        )
        .unwrap()
        .kb;
    let b = Kb {
        store: Store::open(a.store.paths().root()).unwrap(),
        repo: a.store.paths().repo_dir(&created.id),
        kb: created.id,
        main: created.head_sha,
        _root: a._root.clone(),
    };
    let (source, destination) = if a.kb.as_str() < b.kb.as_str() {
        (&a, &b)
    } else {
        (&b, &a)
    };
    for i in 0..2 {
        extra_pack(&source.repo, format!("healthy source {i}\n").as_bytes());
    }
    for i in 0..CONSOLIDATE_PACKS {
        extra_pack(
            &destination.repo,
            format!("due destination {i}\n").as_bytes(),
        );
    }
    let source_packs = pack_names(&source.repo);
    let before = all_objects(&destination.repo);
    for i in 0..12 {
        // Pass the source first as well: NoWork must advance even without the
        // destination preference. Controlled maintenance keeps fsync speed
        // separate from this functional scheduling assertion.
        let guard = a
            .store
            .lock_write(&[source.kb.clone(), destination.kb.clone()])
            .unwrap();
        a.store.consolidate_now_for_tests(&guard).unwrap();
        drop(guard);
        assert!(indexed_pack_count(&destination.repo) < CONSOLIDATE_PACKS);
        extra_pack(
            &destination.repo,
            format!("import publication {i}\n").as_bytes(),
        );
    }
    assert_eq!(pack_names(&source.repo), source_packs);
    assert!(all_objects(&destination.repo).is_superset(&before));
    assert_eq!(a.store.pack_consolidation(&destination.kb).unwrap(), None);
    git(&source.repo, &["fsck", "--full", "--no-dangling"]);
    git(&destination.repo, &["fsck", "--full", "--no-dangling"]);
}

/// Oversized loose inputs are retained under an explicit keep policy. They
/// neither stop smaller inputs nor count as work that can never be selected.
#[test]
fn rollup_skips_an_oversized_real_loose_object_and_maintains_smaller_ones() {
    let kb = new_kb("rollup-oversized");
    let mut body = vec![0u8; 17 << 20];
    let mut x = 0x2545_f491_4f6c_dd1du64;
    for byte in &mut body {
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        *byte = x as u8;
    }
    // Hash the large prefix once; search the sampled fan-out by varying an
    // eight-byte suffix. The fixture stays cheap even in an unoptimized build.
    let mut prefix = ring::digest::Context::new(&ring::digest::SHA1_FOR_LEGACY_USE_ONLY);
    prefix.update(format!("blob {}\0", body.len() + 8).as_bytes());
    prefix.update(&body);
    for n in 0u64.. {
        let nonce = n.to_le_bytes();
        let mut digest = prefix.clone();
        digest.update(&nonce);
        if digest.finish().as_ref()[0] == 0x17 {
            body.extend_from_slice(&nonce);
            break;
        }
    }
    let oversized = loose_blob(&kb.repo, &body);
    drop(body);
    let kept = kb.repo.join("objects/17").join(&oversized[2..]);
    assert!(std::fs::metadata(&kept).unwrap().len() > 16 << 20);
    let mut sampled = Vec::new();
    for n in 0.. {
        let body = format!("small after oversized {n}\n");
        let digest = ring::digest::digest(
            &ring::digest::SHA1_FOR_LEGACY_USE_ONLY,
            &[format!("blob {}\0", body.len()).as_bytes(), body.as_bytes()].concat(),
        );
        if digest.as_ref()[0] == 0x17 {
            sampled.push(loose_blob(&kb.repo, body.as_bytes()));
            if sampled.len() == 27 {
                break;
            }
        }
    }
    let before = all_objects(&kb.repo);
    maintain_now(&kb);
    for name in &sampled {
        assert!(!kb.repo.join("objects/17").join(&name[2..]).exists());
    }
    assert!(kept.exists(), "oversized object retained loose");
    let packs = pack_names(&kb.repo);
    for _ in 0..3 {
        drop(
            kb.store
                .lock_publication(std::slice::from_ref(&kb.kb))
                .unwrap(),
        );
        maintain_now(&kb);
    }
    assert_eq!(pack_names(&kb.repo), packs, "no perpetual rollup");
    assert_eq!(kb.store.pack_consolidation(&kb.kb).unwrap(), None);
    let mut head = kb.main.clone();
    for n in 0..3 {
        head = publish(
            &kb,
            &head,
            &format!("oversized-write-{n:06}"),
            &format!("notes/after-{n}.md"),
        );
        maintain_now(&kb);
    }
    assert_eq!(
        kb.head(),
        head,
        "publication continues beside the retained object"
    );
    assert!(kept.exists());
    assert!(indexed_pack_count(&kb.repo) < CONSOLIDATE_PACKS);
    assert!(all_objects(&kb.repo).is_superset(&before));
    git(&kb.repo, &["fsck", "--full", "--no-dangling"]);
}

/// A crash at any point of a rollup leaves a valid store that the next
/// pass finishes: both the new pack and every old one (crash before
/// removal), or an old data file whose index was already removed.
#[test]
fn interrupted_rollup_leaves_a_valid_store_that_the_next_pass_finishes() {
    let kb = new_kb("pack-crash");
    let mut head = kb.main.clone();
    let written = publish_to_threshold(&kb, &mut head, "crash");
    let packs = kb.repo.join("objects/pack");
    let saved = kb
        .store
        .paths()
        .root()
        .parent()
        .expect("base")
        .join("saved");
    std::fs::create_dir_all(&saved).unwrap();
    let before = pack_names(&kb.repo);
    for name in &before {
        std::fs::copy(packs.join(name), saved.join(name)).unwrap();
    }
    let objects = all_objects(&kb.repo);
    maintain_now(&kb);
    assert!(
        indexed_pack_count(&kb.repo) < CONSOLIDATE_PACKS,
        "rolled up"
    );
    // Crash before the old packs went: restore them (data before index).
    for name in before.iter().filter(|n| n.ends_with(".pack")) {
        std::fs::copy(saved.join(name), packs.join(name)).unwrap();
    }
    for name in before.iter().filter(|n| !n.ends_with(".pack")) {
        std::fs::copy(saved.join(name), packs.join(name)).unwrap();
    }
    // ...and one old pack had already lost its index.
    let orphan = before
        .iter()
        .find(|n| n.ends_with(".idx"))
        .expect("an old index")
        .clone();
    std::fs::remove_file(packs.join(&orphan)).unwrap();
    git(&kb.repo, &["fsck", "--full", "--no-dangling"]);
    assert!(all_objects(&kb.repo).is_superset(&objects));
    assert_eq!(
        kb.get(&head, &written[0]).expect("read"),
        format!("# {}\n", written[0])
    );
    assert!(indexed_pack_count(&kb.repo) >= CONSOLIDATE_PACKS);
    maintain_now(&kb);
    assert!(
        indexed_pack_count(&kb.repo) < CONSOLIDATE_PACKS,
        "next pass finished it"
    );
    assert!(
        !pack_names(&kb.repo).contains(&orphan.replace(".idx", ".pack")),
        "unindexed data file removed"
    );
    assert!(all_objects(&kb.repo).is_superset(&objects));
    git(&kb.repo, &["fsck", "--full", "--no-dangling"]);
    for path in &written {
        assert_eq!(kb.get(&head, path).expect("read"), format!("# {path}\n"));
    }
}

/// Removing an unindexed pack can fail for reasons other than permissions
/// (a Windows sharing violation; here: it is a directory). Recovery treats
/// any such failure as "not yet" and every lock still succeeds.
#[test]
fn an_unremovable_unindexed_pack_never_fails_recovery() {
    let kb = new_kb("pack-stuck");
    let stuck = kb
        .repo
        .join("objects/pack")
        .join(format!("pack-{}.pack", "e".repeat(40)));
    std::fs::create_dir(&stuck).unwrap();
    std::fs::write(stuck.join("held"), b"x").unwrap();
    for _ in 0..2 {
        drop(
            kb.store
                .lock_publication(std::slice::from_ref(&kb.kb))
                .expect("lock"),
        );
    }
    publish(&kb, &kb.main, "stuck-key-000001", "notes/s.md");
    assert!(stuck.exists());
    std::fs::remove_dir_all(&stuck).unwrap();
    drop(
        kb.store
            .lock_publication(std::slice::from_ref(&kb.kb))
            .expect("lock"),
    );
}

#[test]
fn crash_helper_unwind_drains_before_directory_removal() {
    let removed = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let observed = removed.clone();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut root = temp_root("unwind-writer");
        std::fs::create_dir_all(&root).expect("probe root");
        // Construction of a second child fails after the first was admitted.
        // Vec must own the first tree throughout this partial construction.
        let _children: Vec<ChildGuard> = (0..2)
            .map(|index| {
                assert_eq!(index, 0, "injected failure constructing the second child");
                let child = spawn_role("unwind-probe", &root, "");
                let pids = child_guard::writer_pids(&root);
                let path = root.to_path_buf();
                let observed = observed.clone();
                root.before_remove(move || {
                    assert!(path.exists(), "check runs before the actual rm");
                    child_guard::assert_dead(&pids);
                    observed.store(true, std::sync::atomic::Ordering::Relaxed);
                });
                child
            })
            .collect();
    }));
    assert!(result.is_err());
    assert!(removed.load(std::sync::atomic::Ordering::Relaxed));
}

#[path = "child_guard.rs"]
mod child_guard;
use child_guard::ChildGuard;

// Standalone PATH fixture compiled by rustc, on Unix and Windows. It uses
// ordinary stdin/stdout and real Git, with a file barrier before execution.
use std::io::{Read, Write};
use std::process::{Command, Stdio};

fn main() {
    let exe = std::env::current_exe().expect("exe");
    let bin = exe.parent().expect("bin");
    let mode = std::fs::read_to_string(bin.join("mode")).expect("mode");
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    // A Git execution failure (not a conflict count): `merge-tree` dies as
    // on an unreadable object or a resource failure.
    if mode.trim() == "fail-merge-tree" && args.iter().any(|a| a == "merge-tree") {
        std::process::exit(128);
    }
    #[cfg(unix)]
    if mode.trim() == "early-eof" && args.iter().any(|a| a == "for-each-ref") {
        use std::os::unix::process::CommandExt;
        std::fs::write(bin.join("pid"), std::process::id().to_string()).expect("pid");
        // Same PID and inherited lock, but EOF immediately while the process
        // stays alive. The finite park bounds historical failure replay too.
        let error = Command::new("sh")
            .args(["-c", "exec 1>&-; exec sleep 2"])
            .exec();
        panic!("early EOF fixture exec: {}", error);
    }
    if mode.trim() == "batch-trace" && args.iter().any(|a| a == "--batch") {
        use std::io::BufRead;
        let git = std::fs::read_to_string(bin.join("real-git")).expect("git");
        let mut input = std::io::stdin().lock();
        let mut output = std::io::stdout().lock();
        let mut log = std::fs::OpenOptions::new().create(true).append(true).open(bin.join("bodies")).expect("log");
        let mut request = String::new();
        loop {
            request.clear();
            if input.read_line(&mut request).expect("request") == 0 { break; }
            // One real-Git round trip, completely reaped before forwarding.
            // The fixture logs complete bodies delivered to the real reader;
            // an over-budget header must stop delivery before its payload.
            let mut child = ChildGuard::spawn_direct(Command::new(git.trim()).args(&args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null())).expect("git");
            child.stdin.take().expect("stdin").write_all(request.as_bytes()).expect("request");
            let data = child.wait_with_output().expect("wait");
            assert!(data.status.success());
            let end = data.stdout.iter().position(|b| *b == b'\n').expect("header") + 1;
            if output.write_all(&data.stdout[..end]).and_then(|()| output.flush()).is_err() { break; }
            if output.write_all(&data.stdout[end..]).and_then(|()| output.flush()).is_err() { break; }
            writeln!(log, "{} {}", request.trim(), data.stdout.len() - end - 1).expect("log");
            log.flush().expect("flush log");
        }
        return;
    }
    if mode.trim().starts_with("batch-") && args.iter().any(|a| a == "--batch") {
        use std::io::BufRead;
        std::fs::write(bin.join("pid"), std::process::id().to_string()).expect("pid");
        let mut request = String::new();
        let mut input = std::io::stdin().lock();
        let mut output = std::io::stdout().lock();
        if mode.trim() == "batch-write-failure" {
            // On the second request the parent's pipe is broken after expiry.
            input.read_line(&mut request).expect("request");
            writeln!(output, "{} blob 0\n", request.trim()).expect("empty body");
            output.flush().expect("flush");
            std::thread::sleep(std::time::Duration::from_secs(30));
            return;
        }
        input.read_line(&mut request).expect("request");
        if mode.trim() == "batch-partial" {
            writeln!(output, "{} blob 5", request.trim()).expect("header");
            output.write_all(b"xy").expect("partial body");
            output.flush().expect("flush");
        } else if mode.trim() == "batch-malformed" {
            writeln!(output, "invalid header").expect("header");
            output.flush().expect("flush");
            return;
        }
        std::thread::sleep(std::time::Duration::from_secs(30));
        return;
    }
    if mode.trim() == "truncate-pack" && args.iter().any(|a| a == "pack-objects") {
        let git = std::fs::read_to_string(bin.join("real-git")).expect("git");
        let output = Command::new(git.trim()).args(&args).stdin(Stdio::inherit()).output().expect("real pack-objects");
        assert!(output.status.success());
        assert_eq!(&output.stdout[..4], b"PACK");
        assert!(u32::from_be_bytes([output.stdout[8], output.stdout[9], output.stdout[10], output.stdout[11]]) > 1);
        // All but the last object's final byte and checksum: earlier objects
        // are complete, reproducing unpack-objects' partial graph exposure.
        let sent = output.stdout.len() - 21;
        std::io::stdout().write_all(&output.stdout[..sent]).expect("truncated stream");
        std::fs::write(bin.join("truncated-pack"), format!("{sent}/{}", output.stdout.len())).expect("proof");
        return;
    }
    let selected = args.iter().any(|a| a == mode.trim())
        && (mode.trim() != "cat-file" || args.iter().any(|a| a == "--batch"));
    if !selected && args.iter().any(|a| a == "cat-file") {
        if let Ok(delay) = std::fs::read_to_string(bin.join("delay-unselected-cat-file")) {
            // One unselected preflight command takes three seconds, before the
            // writer's park is armed. The old test silently skipped the writer
            // here; the admitted-deadline test must still reach its marker.
            if let Ok(_claim) = std::fs::OpenOptions::new().write(true).create_new(true)
                .open(bin.join("preflight-delayed")) {
                std::thread::sleep(std::time::Duration::from_millis(delay.trim().parse().expect("delay")));
            }
        }
    }
    let mut first = Vec::new();
    if selected {
        // Parents probe this PID as soon as either readiness marker appears.
        // Publish identity first, including before the stdin acknowledgement.
        std::fs::write(bin.join("pid"), std::process::id().to_string()).expect("pid");
        if mode.trim() == "cat-file" {
            // Proves that the real read path supplied its request on stdin.
            let mut byte = [0];
            while std::io::stdin().read(&mut byte).expect("stdin") == 1 {
                first.push(byte[0]);
                if byte[0] == b'\n' { break; }
            }
            assert_eq!(first.len(), 41, "SHA request on normal stdin");
        }
        if !first.is_empty() {
            // Publish readiness after the complete PID: the observer checks
            // liveness immediately, including while this process is scheduled out.
            std::fs::write(bin.join("stdin-ok"), &first).expect("stdin proof");
        }
        // Readiness is the last write before parking. Publish atomically so
        // observers never kill a fixture still writing its acknowledgement.
        std::fs::write(bin.join("mark-pending"), b"parked").expect("mark");
        std::fs::rename(bin.join("mark-pending"), bin.join("mark")).expect("publish mark");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while !bin.join("release").exists() {
            if std::time::Instant::now() > deadline { std::process::exit(9); }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
    }
    let git = std::fs::read_to_string(bin.join("real-git")).expect("real git");
    let mut cmd = Command::new(git.trim());
    cmd.args(args).stdout(Stdio::inherit()).stderr(Stdio::inherit());
    if !first.is_empty() {
        cmd.stdin(Stdio::piped());
        let mut child = ChildGuard::spawn_direct(&mut cmd).expect("git");
        let mut input = child.stdin.take().expect("pipe");
        let writer = std::thread::spawn(move || {
            let _ = input.write_all(&first);
            let _ = std::io::copy(&mut std::io::stdin(), &mut input);
        });
        let status = child.wait().expect("wait");
        // After SIGKILL of the owner stdin is EOF; in live probes, the
        // ObjectReader closes stdin on drop.
        writer.join().expect("writer");
        std::fs::write(bin.join("exited"), b"done").expect("exit");
        std::process::exit(status.code().unwrap_or(1));
    }
    let status = cmd.stdin(Stdio::inherit()).status().expect("git");
    if selected { std::fs::write(bin.join("exited"), b"done").expect("exit"); }
    std::process::exit(status.code().unwrap_or(1));
}

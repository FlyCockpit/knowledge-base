use super::*;
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    io::{Read, Write},
    os::unix::{
        net::{UnixListener, UnixStream},
        process::{CommandExt, ExitStatusExt},
    },
    process::{Child, ExitStatus},
    sync::atomic::{AtomicBool, Ordering},
    time::{Duration, Instant},
};

static INTERRUPTED: AtomicBool = AtomicBool::new(false);
extern "C" fn interrupt(_: libc::c_int) {
    INTERRUPTED.store(true, Ordering::Relaxed);
}

// sun_path is only 104 bytes on macOS, including the terminating NUL. Never
// derive this name from TMPDIR or a nested fixture path. Keep the literal /tmp
// spelling (canonicalizing it on macOS adds /private), with a private, atomic,
// randomly named directory for each owner, including nested owners.
struct BrokerDirectory(std::path::PathBuf);
impl BrokerDirectory {
    fn new() -> io::Result<Self> {
        use ring::rand::{SecureRandom, SystemRandom};
        use std::os::unix::fs::DirBuilderExt;
        loop {
            let mut random = [0u8; 16];
            SystemRandom::new()
                .fill(&mut random)
                .map_err(|_| io::Error::other("broker directory randomness unavailable"))?;
            let name: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
            let path = std::path::PathBuf::from(format!("/tmp/kbt-{name}"));
            match std::fs::DirBuilder::new().mode(0o700).create(&path) {
                Ok(()) => return Ok(Self(path)),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
    }
    fn socket(&self) -> std::path::PathBuf {
        self.0.join("s") // Always 43 bytes, comfortably below macOS's 104.
    }
}
impl Drop for BrokerDirectory {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[derive(Serialize, Deserialize)]
struct Request {
    args: Vec<OsString>,
    env: Vec<(OsString, OsString)>,
    cwd: OsString,
    session: bool,
    quiet: bool,
    delegate: Option<(std::path::PathBuf, bool)>,
}

fn escape(args: &[OsString]) -> io::Result<i32> {
    let mut socket = UnixStream::connect(&args[1])?;
    let request = Request {
        args: args[2..].to_vec(),
        env: std::env::vars_os().collect(),
        cwd: std::env::current_dir()?.into_os_string(),
        session: args[0] == "--escape-session",
        quiet: args[0] == "--escape-worker",
        delegate: None,
    };
    serde_json::to_writer(&mut socket, &request)?;
    socket.shutdown(std::net::Shutdown::Write)?;
    let mut reply = String::new();
    socket.read_to_string(&mut reply)?;
    reply.parse().map_err(io::Error::other)
}

// Nested owners stay in their caller's group so their configured pipes stay
// intact. Register BEFORE creating any private group; acknowledge completion
// BEFORE exiting. The enclosing owner must wait for this receipt before its
// final group kill, even when Cargo/the test process dies without running Drop.
fn delegate(parent: &Option<OsString>, root: &Path, done: bool) -> io::Result<()> {
    let Some(parent) = parent else {
        return Ok(());
    };
    let mut socket = UnixStream::connect(parent)?;
    serde_json::to_writer(
        &mut socket,
        &Request {
            args: Vec::new(),
            env: Vec::new(),
            cwd: OsString::new(),
            session: false,
            quiet: false,
            delegate: Some((root.to_path_buf(), done)),
        },
    )?;
    socket.shutdown(std::net::Shutdown::Write)?;
    let mut reply = String::new();
    socket.read_to_string(&mut reply)?;
    if reply != "0" {
        return Err(io::Error::other("parent refused delegated ownership"));
    }
    Ok(())
}

struct Owned {
    child: Child,
    status: Option<ExitStatus>,
    killed: bool,
    reply: Option<UnixStream>,
}
impl Owned {
    // WNOWAIT pins the PID/PGID until the final group signal. Reaping first
    // would allow an unrelated process to recycle that signalling identity.
    fn observe(&mut self) -> io::Result<Option<ExitStatus>> {
        if self.status.is_none() {
            // SAFETY: initialized siginfo; child is ours and is never reaped elsewhere.
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            // SAFETY: valid output pointer; WNOWAIT retains our child identity.
            if unsafe {
                libc::waitid(
                    libc::P_PID,
                    self.child.id(),
                    &mut info,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            } != 0
            {
                let error = io::Error::last_os_error();
                // A signal interrupted polling, not ownership. Process its
                // stop flag this turn and observe the child on the next turn.
                if error.kind() == io::ErrorKind::Interrupted {
                    return Ok(None);
                }
                return Err(error);
            }
            // SAFETY: waitid initialized the siginfo variant selected by si_code.
            if unsafe { info.si_pid() } != 0 {
                // SAFETY: a child-exit siginfo has a valid si_status field.
                let code = unsafe { info.si_status() };
                self.status = Some(ExitStatus::from_raw(if info.si_code == libc::CLD_EXITED {
                    code << 8
                } else {
                    code
                }));
            }
        }
        Ok(self.status)
    }
    fn signal(&self, signal: i32) -> io::Result<()> {
        // SAFETY: group leader is still our unreaped child, pinning this PGID.
        if unsafe { libc::kill(-(self.child.id() as i32), signal) } != 0 {
            let error = io::Error::last_os_error();
            if error.raw_os_error() != Some(libc::ESRCH) {
                return Err(error);
            }
        }
        Ok(())
    }
    fn finish(&mut self) -> io::Result<()> {
        if !self.killed {
            self.signal(libc::SIGKILL)?;
            self.child.wait()?;
            self.killed = true;
        }
        Ok(())
    }
}

fn spawn(mut command: Command, session: bool, reply: Option<UnixStream>) -> io::Result<Owned> {
    if session {
        // SAFETY: child-only, async-signal-safe setsid before exec; no allocations.
        unsafe {
            command.pre_exec(|| {
                if libc::setsid() < 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(())
            });
        }
    } else {
        command.process_group(0);
    }
    Ok(Owned {
        child: command.spawn()?,
        status: None,
        killed: false,
        reply,
    })
}

#[cfg(target_os = "linux")]
fn adopted(signal: Option<i32>) -> io::Result<bool> {
    let children =
        std::fs::read_to_string(format!("/proc/self/task/{}/children", std::process::id()))?;
    for pid in children.split_whitespace() {
        let pid: i32 = pid.parse().map_err(io::Error::other)?;
        if let Some(signal) = signal {
            // SAFETY: unreaped direct/adopted child, enumerated and signalled on
            // this single thread. Its identity cannot recycle before waitpid.
            if unsafe { libc::kill(pid, signal) } != 0
                && io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH)
            {
                return Err(io::Error::last_os_error());
            }
        }
    }
    Ok(children.trim().is_empty())
}

pub fn run(args: &[OsString]) -> io::Result<i32> {
    if args
        .first()
        .is_some_and(|a| a == "--escape-group" || a == "--escape-session" || a == "--escape-worker")
    {
        return escape(args);
    }
    let root = Path::new(
        args.first()
            .ok_or_else(|| io::Error::other("missing root"))?,
    );
    let hold = args.get(1).is_some_and(|a| a == "--hold");
    let portable = args.get(1).is_some_and(|a| a == "--portable");
    let start = if hold || portable { 2 } else { 1 };
    // Linux remains a subreaper even in portable tests, solely to reap the
    // orphaned group members that macOS init reaps. Portable signalling never
    // consults the Linux adopted-child inventory.
    #[cfg(target_os = "linux")]
    // SAFETY: process-local ownership policy, before starting any child/thread.
    if unsafe { libc::prctl(libc::PR_SET_CHILD_SUBREAPER, 1, 0, 0, 0) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: install process-local handlers before spawning; handler only sets an atomic.
    unsafe {
        libc::signal(libc::SIGCHLD, libc::SIG_DFL);
        libc::signal(libc::SIGINT, interrupt as *const () as usize);
        libc::signal(libc::SIGTERM, interrupt as *const () as usize);
    }
    let parent = std::env::var_os("KB_TEST_PROCESS_SOCKET");
    let broker = BrokerDirectory::new()?;
    let socket_path = broker.socket();
    let listener = UnixListener::bind(&socket_path)?;
    listener.set_nonblocking(true)?;
    delegate(&parent, root, false)?;
    let mut main = super::command(&args[start..])?;
    main.env("KB_TEST_PROCESS_SOCKET", &socket_path)
        .env("KB_TEST_PROCESS_OWNER", std::env::current_exe()?);
    let main = match spawn(main, false, None) {
        Ok(child) => child,
        Err(error) => {
            super::receipt(root, "drained", "drained")?;
            delegate(&parent, root, true)?;
            return Ok(if error.kind() == io::ErrorKind::NotFound {
                127
            } else {
                125
            });
        }
    };
    super::receipt(root, "pid", main.child.id().to_string())?;
    let mut owned = vec![main];
    let mut requests = Vec::<(UnixStream, Vec<u8>)>::new();
    let mut delegates = BTreeMap::<std::path::PathBuf, bool>::new();
    let mut stopping = None;
    let mut result = 1;
    loop {
        // A request is admitted synchronously, including spawn+registration,
        // before another stop/exit observation can begin drainage.
        while let Ok((stream, _)) = listener.accept() {
            stream.set_nonblocking(true)?;
            requests.push((stream, Vec::new()));
        }
        let mut index = 0;
        while index < requests.len() {
            let (stream, bytes) = &mut requests[index];
            let mut chunk = [0u8; 8192];
            let complete = loop {
                match stream.read(&mut chunk) {
                    Ok(0) => break true,
                    Ok(n) => bytes.extend_from_slice(&chunk[..n]),
                    Err(error) if error.kind() == io::ErrorKind::WouldBlock => break false,
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
                    Err(_) => break true,
                }
            };
            if !complete {
                index += 1;
                continue;
            }
            let (mut stream, bytes) = requests.swap_remove(index);
            let request = serde_json::from_slice::<Request>(&bytes);
            if let Ok(request) = request {
                if let Some((path, done)) = request.delegate {
                    let accepted = if done {
                        if let Some(settled) = delegates.get_mut(&path) {
                            *settled = true;
                            true
                        } else {
                            false
                        }
                    } else if stopping.is_none() {
                        delegates.insert(path, false);
                        true
                    } else {
                        false
                    };
                    let _ = stream.write_all(if accepted { b"0" } else { b"125" });
                    continue;
                }
                if stopping.is_some() {
                    let _ = stream.write_all(b"125");
                    continue;
                }
                let mut command = super::command(&request.args)?;
                command
                    .env_clear()
                    .envs(request.env)
                    .current_dir(request.cwd);
                if request.quiet {
                    command
                        .stdin(std::process::Stdio::null())
                        .stdout(std::process::Stdio::null())
                        .stderr(std::process::Stdio::null());
                }
                match spawn(command, request.session, None) {
                    Ok(mut child) => {
                        child.reply = Some(stream);
                        owned.push(child);
                    }
                    Err(_) => {
                        let _ = stream.write_all(b"127");
                    }
                }
            } else {
                let _ = stream.write_all(b"125");
            }
        }
        for (index, child) in owned.iter_mut().enumerate() {
            if child.killed {
                continue;
            }
            let previously_exited = child.status.is_some();
            if let Some(status) = child.observe()?
                && !previously_exited
            {
                if index == 0 {
                    result = status.code().unwrap_or(1);
                    super::receipt(root, "status", status.into_raw().to_string())?;
                } else {
                    // This registered worker ended naturally. Drain its group
                    // while retaining its identity, then notify its requester.
                    child.finish()?;
                    if let Some(mut reply) = child.reply.take() {
                        let _ = write!(reply, "{}", status.code().unwrap_or(1));
                    }
                }
            }
        }
        if root.join("kill-leader").exists() && owned[0].status.is_none() {
            // SAFETY: main is still our unreaped direct child. Only kill the
            // writer here; crash tests deliberately inspect its live Git children.
            unsafe {
                libc::kill(owned[0].child.id() as i32, libc::SIGKILL);
            }
        }
        let stop = INTERRUPTED.load(Ordering::Relaxed) || root.join("stop").exists();
        if stopping.is_none() && (stop || (!hold && owned[0].status.is_some())) {
            if stop {
                result = 1;
            }
            stopping = Some(Instant::now());
            for (path, done) in &delegates {
                if !done {
                    let _ = std::fs::write(path.join("stop"), "stop");
                }
            }
            for child in &owned {
                if !child.killed {
                    child.signal(libc::SIGTERM)?;
                }
            }
        }
        if stopping.is_some_and(|at| at.elapsed() >= Duration::from_secs(1)) {
            if delegates.values().any(|done| !done) {
                std::thread::sleep(Duration::from_millis(10));
                continue;
            }
            for child in &mut owned {
                child.finish()?;
            }
            #[cfg(target_os = "linux")]
            {
                if !portable {
                    adopted(Some(libc::SIGKILL))?;
                }
                // SAFETY: only this thread reaps; registered leaders were
                // already waited above and will never be signalled again.
                while unsafe { libc::waitpid(-1, std::ptr::null_mut(), libc::WNOHANG) } > 0 {}
                if !adopted(None)? {
                    std::thread::sleep(Duration::from_millis(10));
                    continue;
                }
            }
            // SIGKILL has reached every group member before its leader was
            // reaped. Probe only now; never signal these numeric identities again.
            let groups_gone = owned.iter().all(|child| {
                // SAFETY: signal zero probes existence without modifying a process.
                (unsafe { libc::kill(-(child.child.id() as i32), 0) }) == -1
                    && io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
            });
            if groups_gone {
                break;
            }
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    super::receipt(root, "drained", "drained")?;
    delegate(&parent, root, true)?;
    Ok(result)
}

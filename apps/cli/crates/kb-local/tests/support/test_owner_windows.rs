//! Same suspended-admission / kill-on-close boundary as src/win.rs. This
//! test binary inherits its console handles; it does not hand off store locks.
use super::*;
use std::{
    mem::size_of,
    os::windows::{
        ffi::OsStrExt,
        io::{AsRawHandle, FromRawHandle, OwnedHandle},
    },
    ptr::{null, null_mut},
    time::Duration,
};
use windows_sys::Win32::{
    Foundation::*,
    System::{JobObjects::*, Threading::*},
};

fn check(ok: i32) -> io::Result<()> {
    if ok == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}
fn quote(arg: &std::ffi::OsStr, line: &mut Vec<u16>) {
    line.push(34);
    let mut slashes = 0;
    for c in arg.encode_wide() {
        if c == 92 {
            slashes += 1;
            continue;
        }
        if c == 34 {
            line.extend(std::iter::repeat_n(92, slashes * 2 + 1));
        } else {
            line.extend(std::iter::repeat_n(92, slashes));
        }
        slashes = 0;
        line.push(c);
    }
    line.extend(std::iter::repeat_n(92, slashes * 2));
    line.push(34);
}

pub fn run(args: &[OsString]) -> io::Result<i32> {
    let root = Path::new(&args[0]);
    let hold = args.get(1).is_some_and(|a| a == "--hold");
    let mut command = super::command(&args[if hold { 2 } else { 1 }..])?;
    // Resolve executable using Rust's PATH rules before calling CreateProcess.
    // The child is still created suspended and cannot run outside the job.
    let program = command.get_program().to_owned();
    let mut application = program.clone();
    if Path::new(&program).components().count() == 1 {
        let found = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
            .map(|dir| dir.join(&program).with_extension("exe"))
            .find(|path| path.is_file());
        let Some(found) = found else {
            super::receipt(root, "drained", "drained")?;
            return Ok(127);
        };
        application = found.into_os_string();
    }
    command = Command::new(application);
    command.args(&args[if hold { 3 } else { 2 }..]);
    let mut line = Vec::new();
    quote(command.get_program(), &mut line);
    for arg in command.get_args() {
        line.push(32);
        quote(arg, &mut line);
    }
    line.push(0);
    // SAFETY: null attributes produce a noninheritable anonymous job.
    let raw_job = unsafe { CreateJobObjectW(null(), null()) };
    if raw_job.is_null() {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: non-null owned handle returned above, wrapped exactly once.
    let job = unsafe { OwnedHandle::from_raw_handle(raw_job) };
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    // SAFETY: live job and correctly sized limits structure.
    unsafe {
        check(SetInformationJobObject(
            job.as_raw_handle(),
            JobObjectExtendedLimitInformation,
            (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
            size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        ))?;
    }
    let startup = STARTUPINFOW {
        cb: size_of::<STARTUPINFOW>() as u32,
        ..Default::default()
    };
    let mut child = PROCESS_INFORMATION::default();
    // Rust's inherited standard handles are inherited by CreateProcess when
    // STARTF_USESTDHANDLES is absent, matching the wrapper's configured stdio.
    // SAFETY: mutable nul-terminated command line, valid output structures;
    // suspended admission ensures assignment precedes all child execution.
    if unsafe {
        CreateProcessW(
            null(),
            line.as_mut_ptr(),
            null(),
            null(),
            1,
            CREATE_SUSPENDED,
            null(),
            null(),
            &startup,
            &mut child,
        )
    } == 0
    {
        super::receipt(root, "drained", "drained")?;
        return Ok(127);
    }
    // SAFETY: both handles were returned owned by CreateProcessW.
    let process = unsafe { OwnedHandle::from_raw_handle(child.hProcess) };
    // SAFETY: distinct owned thread handle.
    let thread = unsafe { OwnedHandle::from_raw_handle(child.hThread) };
    // SAFETY: live job/process/thread handles, suspended child cannot escape.
    unsafe {
        if AssignProcessToJobObject(job.as_raw_handle(), process.as_raw_handle()) == 0 {
            TerminateProcess(process.as_raw_handle(), 125);
            WaitForSingleObject(process.as_raw_handle(), INFINITE);
            return Err(io::Error::last_os_error());
        }
        if ResumeThread(thread.as_raw_handle()) == u32::MAX {
            return Err(io::Error::last_os_error());
        }
    }
    drop(thread);
    super::receipt(root, "pid", child.dwProcessId.to_string())?;
    let mut code = None;
    loop {
        // SAFETY: process handle remains owned through this polling loop.
        if code.is_none()
            && unsafe { WaitForSingleObject(process.as_raw_handle(), 0) } == WAIT_OBJECT_0
        {
            let mut status = 1;
            // SAFETY: valid process and output pointer.
            unsafe {
                check(GetExitCodeProcess(process.as_raw_handle(), &mut status))?;
            }
            super::receipt(root, "status", status.to_string())?;
            code = Some(status as i32);
        }
        if root.join("kill-leader").exists() && code.is_none() {
            // SAFETY: owned handle pins the process identity.
            unsafe {
                check(TerminateProcess(process.as_raw_handle(), 1))?;
            }
        }
        let stop = root.join("stop").exists();
        if stop || (!hold && code.is_some()) {
            // SAFETY: job remains owned; termination reaches every member.
            unsafe {
                check(TerminateJobObject(job.as_raw_handle(), 1))?;
            }
            loop {
                let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
                // SAFETY: live job, valid correctly sized output structure.
                unsafe {
                    check(QueryInformationJobObject(
                        job.as_raw_handle(),
                        JobObjectBasicAccountingInformation,
                        (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                        size_of::<JOBOBJECT_BASIC_ACCOUNTING_INFORMATION>() as u32,
                        null_mut(),
                    ))?;
                }
                if accounting.ActiveProcesses == 0 {
                    break;
                }
                std::thread::sleep(Duration::from_millis(10));
            }
            super::receipt(root, "drained", "drained")?;
            return Ok(if stop { 1 } else { code.unwrap_or(1) });
        }
        std::thread::sleep(Duration::from_millis(10));
    }
}

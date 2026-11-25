//! Audited Windows boundary: private ACLs, explicit child handle lists,
//! and named kill-on-close jobs. All other kb-local code denies unsafe.
#![allow(unsafe_code)] // FFI is confined to this OS boundary; each block is audited.

use std::ffi::OsStr;
use std::fs::File;
use std::io;
use std::mem::{size_of, size_of_val};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::os::windows::process::ExitStatusExt;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus};
use std::ptr::{null, null_mut};
use std::sync::Mutex;

use windows_sys::Win32::Foundation::*;
use windows_sys::Win32::Security::Authorization::*;
use windows_sys::Win32::Security::*;
use windows_sys::Win32::Storage::FileSystem::*;
use windows_sys::Win32::System::JobObjects::*;
use windows_sys::Win32::System::Pipes::CreatePipe;
use windows_sys::Win32::System::Threading::*;

// Win32 ACCESS_ALLOWED_ACE_TYPE (winnt.h); no SystemServices feature for one constant.
const ACCESS_ALLOWED_ACE_TYPE: u8 = 0;

fn wide(value: &OsStr) -> io::Result<Vec<u16>> {
    let mut value: Vec<_> = value.encode_wide().collect();
    if value.contains(&0) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "embedded NUL"));
    }
    value.push(0);
    Ok(value)
}

fn bool_result(result: i32) -> io::Result<()> {
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

// IO_STATUS_BLOCK's first field is the NTSTATUS/pointer union (pointer-sized
// on every supported MSVC target). This is confined to the audited FFI.
#[repr(C)]
struct IoStatusBlock {
    status: isize,
    information: usize,
}
#[link(name = "ntdll")]
unsafe extern "system" {
    fn NtFlushBuffersFileEx(
        handle: HANDLE,
        flags: u32,
        parameters: *const std::ffi::c_void,
        size: u32,
        status: *mut IoStatusBlock,
    ) -> i32;
    fn RtlNtStatusToDosError(status: i32) -> u32;
}
fn flush_directory_handle(file: &File) -> io::Result<()> {
    let mut iosb = IoStatusBlock {
        status: 0,
        information: 0,
    };
    // SAFETY: file owns a live writable directory handle through this
    // synchronous call; IO_STATUS_BLOCK is correctly aligned and initialized.
    // Flags=0 flushes data, metadata AND storage cache; data-only flags are
    // deliberately excluded. Parameters must be NULL/0 per the native API.
    let status = unsafe { NtFlushBuffersFileEx(file.as_raw_handle(), 0, null(), 0, &mut iosb) };
    if status < 0 {
        // SAFETY: pure documented conversion of the returned NTSTATUS.
        return Err(io::Error::from_raw_os_error(
            unsafe { RtlNtStatusToDosError(status) } as i32,
        ));
    }
    Ok(())
}
/// Windows 10+ directory-entry barrier. The flush needs a handle with
/// FILE_WRITE_DATA or FILE_APPEND_DATA (add-file / add-subdirectory on a
/// directory), so exactly one of those is requested: GENERIC_WRITE would
/// also demand attribute/EA rights that `C:\` grants a standard user only
/// for creating folders. A directory that grants neither is refused here.
/// https://learn.microsoft.com/windows-hardware/drivers/ddi/ntifs/nf-ntifs-ntflushbuffersfileex
pub(crate) fn sync_directory(path: &Path) -> io::Result<()> {
    match open_flushable_directory(path)? {
        Some(file) => flush_directory_handle(&file),
        None => Err(io::Error::from_raw_os_error(ERROR_ACCESS_DENIED as i32)),
    }
}

/// [`sync_directory`] for an existing ancestor outside every kb-managed
/// tree (for example `C:\Users`). Creating or renaming an entry into a
/// directory requires add-file or add-subdirectory access to it, so when this
/// user holds neither, no link this user's processes made can be pending
/// there and the barrier has nothing of ours to persist: that is `Ok`. "Holds
/// neither" is an access check against the directory's own security
/// descriptor, not a failed open: a refusal the DACL does not explain (a
/// filter driver, a sharing conflict) propagates. Only ACL-capable volumes
/// can refuse this way, and those (NTFS, ReFS) journal directory entries:
/// the flush of the writable descendant that follows (the store or
/// credential directory itself) also makes every earlier entry durable. Any
/// directory this user can add entries to is still flushed, and a failed
/// flush still propagates.
pub(crate) fn sync_ancestor_directory(path: &Path) -> io::Result<()> {
    match open_flushable_directory(path)? {
        Some(file) => flush_directory_handle(&file),
        None => Ok(()),
    }
}

/// A directory handle allowed to flush, pinned to the identity `path` had
/// when first opened without following a link; `None` when this user may
/// neither add files nor subdirectories to it.
fn open_flushable_directory(path: &Path) -> io::Result<Option<File>> {
    use std::os::windows::fs::OpenOptionsExt;
    // Keep the OS error itself (callers treat a missing directory, NotFound,
    // as an absence barrier); only other refusals become `Other`.
    let pinned = crate::paths::open_directory(path).map_err(|error| match error {
        crate::StoreError::Io(error) => error,
        other => io::Error::other(other),
    })?;
    for add_entry in [FILE_APPEND_DATA, FILE_WRITE_DATA] {
        #[cfg(test)]
        if DENY_FLUSHABLE_OPENS.get() {
            continue;
        }
        let opened = std::fs::OpenOptions::new()
            .access_mode(add_entry | FILE_READ_ATTRIBUTES | SYNCHRONIZE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path);
        let file = match opened {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::PermissionDenied => continue,
            Err(error) => return Err(error),
        };
        if crate::paths::is_link(&file.metadata()?)
            || file_identity(&pinned)? != file_identity(&file)?
        {
            return Err(io::Error::other(
                "directory identity changed at durability barrier",
            ));
        }
        return Ok(Some(file));
    }
    if may_add_entries(&pinned)? {
        return Err(io::Error::from_raw_os_error(ERROR_ACCESS_DENIED as i32));
    }
    Ok(None)
}

// Test hook: every write-capable open of a flushable directory is treated
// as refused, as a filter driver or a mandatory label would refuse it.
#[cfg(test)]
std::thread_local! {
    static DENY_FLUSHABLE_OPENS: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
}

/// Whether this process's token holds a discretionary right to add a file or
/// a subdirectory to the open directory `dir` (owner, group and DACL, via
/// `AccessCheck` with an impersonation copy of the token): only the DACL
/// decides, never a filter, a sharing mode or a mandatory integrity label.
/// A label or filter that refuses what the DACL grants therefore fails the
/// barrier closed rather than skipping it.
fn may_add_entries(dir: &File) -> io::Result<bool> {
    let mut owner = null_mut();
    let mut group = null_mut();
    let mut dacl = null_mut();
    let mut descriptor = null_mut();
    // SAFETY: the directory handle is live (opened with GENERIC_READ, so
    // READ_CONTROL); the API-owned descriptor is freed by its guard.
    let descriptor = unsafe {
        let status = GetSecurityInfo(
            dir.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | GROUP_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            &mut group,
            &mut dacl,
            null_mut(),
            &mut descriptor,
        );
        if status != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        LocalAllocation(descriptor)
    };
    let mut primary = null_mut();
    let mut impersonation = null_mut();
    // SAFETY: current-process pseudo handle; both returned token handles are
    // owned exactly once.
    let impersonation = unsafe {
        bool_result(OpenProcessToken(
            GetCurrentProcess(),
            TOKEN_QUERY | TOKEN_DUPLICATE,
            &mut primary,
        ))?;
        let primary = owned(primary)?;
        bool_result(DuplicateToken(
            primary.as_raw_handle(),
            SecurityImpersonation,
            &mut impersonation,
        ))?;
        owned(impersonation)?
    };
    let mapping = GENERIC_MAPPING {
        GenericRead: FILE_GENERIC_READ,
        GenericWrite: FILE_GENERIC_WRITE,
        GenericExecute: FILE_GENERIC_EXECUTE,
        GenericAll: FILE_ALL_ACCESS,
    };
    for add_entry in [FILE_APPEND_DATA, FILE_WRITE_DATA] {
        // Room for the privilege set AccessCheck may report (none expected).
        let mut privileges = [0usize; 16];
        let mut length = size_of_val(&privileges) as u32;
        let mut granted = 0u32;
        let mut allowed = 0;
        // SAFETY: live descriptor and impersonation token; every output
        // buffer is sized and lives through the synchronous call.
        unsafe {
            bool_result(AccessCheck(
                descriptor.0,
                impersonation.as_raw_handle(),
                add_entry,
                &mapping,
                privileges.as_mut_ptr().cast(),
                &mut length,
                &mut granted,
                &mut allowed,
            ))?;
        }
        if allowed != 0 {
            return Ok(true);
        }
    }
    Ok(false)
}

/// File barrier for a regular file already opened no-follow as `pinned`.
/// FlushFileBuffers needs a write-capable handle, and Git marks the packs,
/// indexes and loose objects it writes FILE_ATTRIBUTE_READONLY, which refuses
/// every write-capable open even to the owner. Only then is that attribute
/// cleared for the flush and restored afterwards (also on failure). Every
/// handle must name `pinned`'s file; nothing is written.
pub(crate) fn sync_file(pinned: &File, path: &Path) -> io::Result<()> {
    use std::os::windows::fs::OpenOptionsExt;
    let same_file = |file: &File| -> io::Result<()> {
        if crate::paths::is_link(&file.metadata()?)
            || file_identity(file)? != file_identity(pinned)?
        {
            return Err(io::Error::other(
                "file identity changed at durability barrier",
            ));
        }
        Ok(())
    };
    let open = |access: u32| {
        std::fs::OpenOptions::new()
            .access_mode(access | FILE_READ_ATTRIBUTES | SYNCHRONIZE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)
    };
    let refused = match open(FILE_WRITE_DATA) {
        Ok(file) => {
            same_file(&file)?;
            return file.sync_all();
        }
        Err(error) if error.kind() == io::ErrorKind::PermissionDenied => error,
        Err(error) => return Err(error),
    };
    let attributes = open(FILE_WRITE_ATTRIBUTES)?;
    same_file(&attributes)?;
    let original = basic_info(&attributes)?;
    if original.FileAttributes & FILE_ATTRIBUTE_READONLY == 0 {
        return Err(refused);
    }
    let mut writable = original;
    writable.FileAttributes &= !FILE_ATTRIBUTE_READONLY;
    if writable.FileAttributes == 0 {
        writable.FileAttributes = FILE_ATTRIBUTE_NORMAL;
    }
    set_attributes(&attributes, writable.FileAttributes)?;
    let flushed = open(FILE_WRITE_DATA).and_then(|file| {
        same_file(&file)?;
        file.sync_all()
    });
    let restored = set_attributes(&attributes, original.FileAttributes);
    flushed.and(restored)
}

fn basic_info(file: &File) -> io::Result<FILE_BASIC_INFO> {
    // SAFETY: the handle is borrowed live; the output is a fully sized,
    // zero-initialized Win32 structure the call only writes into.
    unsafe {
        let mut info: FILE_BASIC_INFO = std::mem::zeroed();
        bool_result(GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileBasicInfo,
            (&mut info as *mut FILE_BASIC_INFO).cast(),
            size_of::<FILE_BASIC_INFO>() as u32,
        ))?;
        Ok(info)
    }
}

/// Set only the attribute word; zero timestamps leave every time unchanged.
fn set_attributes(file: &File, attributes: u32) -> io::Result<()> {
    // SAFETY: the handle (opened with FILE_WRITE_ATTRIBUTES) is borrowed live
    // and the input is a fully initialized FILE_BASIC_INFO.
    unsafe {
        let mut info: FILE_BASIC_INFO = std::mem::zeroed();
        info.FileAttributes = attributes;
        bool_result(SetFileInformationByHandle(
            file.as_raw_handle(),
            FileBasicInfo,
            (&info as *const FILE_BASIC_INFO).cast(),
            size_of::<FILE_BASIC_INFO>() as u32,
        ))
    }
}

/// Same-volume atomic no-replace move, with native write-through metadata.
/// REPLACE_EXISTING and COPY_ALLOWED are deliberately absent: unsupported
/// filesystems fail rather than overwriting or using a copy/delete fallback.
pub(crate) fn publish_no_replace(source: &Path, destination: &Path) -> io::Result<()> {
    let source = wide(source.as_os_str())?;
    let destination = wide(destination.as_os_str())?;
    // SAFETY: both NUL-terminated paths live through the synchronous call;
    // only generated owner-only paths reach this audited OS boundary.
    unsafe {
        bool_result(MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_WRITE_THROUGH,
        ))
    }
}

fn owned(handle: HANDLE) -> io::Result<OwnedHandle> {
    if handle.is_null() || handle == INVALID_HANDLE_VALUE {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: the caller supplies a newly owned Win32 handle, checked above.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle) })
}

struct LocalAllocation(*mut std::ffi::c_void);
impl Drop for LocalAllocation {
    fn drop(&mut self) {
        // SAFETY: this pointer was returned by a LocalAlloc-family Win32 API.
        unsafe {
            LocalFree(self.0);
        }
    }
}

fn process_token(access: u32) -> io::Result<OwnedHandle> {
    let mut token = null_mut();
    // SAFETY: current-process pseudo handle; the returned handle is owned once.
    unsafe {
        bool_result(OpenProcessToken(GetCurrentProcess(), access, &mut token))?;
    }
    owned(token)
}

/// One token information class, in a word-aligned buffer (for TOKEN_USER,
/// TOKEN_OWNER and the SIDs they embed).
fn token_information(
    token: &OwnedHandle,
    class: TOKEN_INFORMATION_CLASS,
) -> io::Result<Vec<usize>> {
    let mut bytes = 0;
    // SAFETY: live token handle; the size query writes only `bytes`, and the
    // buffer outlives the second synchronous call that fills it.
    unsafe {
        GetTokenInformation(token.as_raw_handle(), class, null_mut(), 0, &mut bytes);
        if bytes == 0 {
            return Err(io::Error::last_os_error());
        }
        let mut buffer = vec![0usize; (bytes as usize).div_ceil(size_of::<usize>())];
        bool_result(GetTokenInformation(
            token.as_raw_handle(),
            class,
            buffer.as_mut_ptr().cast(),
            bytes,
            &mut bytes,
        ))?;
        Ok(buffer)
    }
}

fn user_token() -> io::Result<(OwnedHandle, Vec<usize>)> {
    user_owns_new_objects()?;
    let token = process_token(TOKEN_QUERY)?;
    let user = token_information(&token, TokenUser)?;
    Ok((token, user))
}

/// Objects created without a security descriptor (files from `OpenOptions`,
/// SQLite's journals, Git's objects in children, which start with a copy of
/// this token) are owned by the token's default owner. For an elevated
/// administrator on Windows Server that is `BUILTIN\Administrators` (policy
/// "Default owner for objects created by members of the Administrators
/// group"), which every owner-only check here refuses, so kb would refuse
/// the store it just created. Make this user the default owner once per
/// process, as Cygwin/MSYS do at startup. Every private descriptor and
/// check reads the token through [`user_token`], and [`crate::paths`]'s
/// store-file opener calls this before it creates, so it runs before the
/// first such object. A token whose default owner is already the user (a
/// standard or non-elevated account) is only read, never adjusted.
pub(crate) fn user_owns_new_objects() -> io::Result<()> {
    static RESULT: std::sync::OnceLock<Result<(), i32>> = std::sync::OnceLock::new();
    RESULT
        .get_or_init(|| {
            make_user_default_owner()
                .map_err(|error| error.raw_os_error().unwrap_or(ERROR_ACCESS_DENIED as i32))
        })
        .map_err(io::Error::from_raw_os_error)
}

fn make_user_default_owner() -> io::Result<()> {
    let token = process_token(TOKEN_QUERY)?;
    let user = token_information(&token, TokenUser)?;
    let owner = token_information(&token, TokenOwner)?;
    // SAFETY: GetTokenInformation filled both aligned buffers; their embedded
    // SIDs stay alive for the comparison and the synchronous set below.
    unsafe {
        let user = &*user.as_ptr().cast::<TOKEN_USER>();
        let owner = &*owner.as_ptr().cast::<TOKEN_OWNER>();
        if EqualSid(owner.Owner, user.User.Sid) != 0 {
            return Ok(());
        }
        let adjust = process_token(TOKEN_ADJUST_DEFAULT)?;
        let default_owner = TOKEN_OWNER {
            Owner: user.User.Sid,
        };
        bool_result(SetTokenInformation(
            adjust.as_raw_handle(),
            TokenOwner,
            (&default_owner as *const TOKEN_OWNER).cast(),
            size_of::<TOKEN_OWNER>() as u32,
        ))
    }
}

fn private_descriptor(directory: bool) -> io::Result<LocalAllocation> {
    let (_token, user) = user_token()?;
    let mut sid = null_mut();
    // SAFETY: GetTokenInformation populated this aligned TOKEN_USER buffer;
    // its embedded SID remains alive until conversion completes.
    unsafe {
        let user = &*user.as_ptr().cast::<TOKEN_USER>();
        bool_result(ConvertSidToStringSidW(user.User.Sid, &mut sid))?;
        let sid = LocalAllocation(sid.cast());
        let mut len = 0;
        while *sid.0.cast::<u16>().add(len) != 0 {
            len += 1;
        }
        let sid_text = String::from_utf16_lossy(std::slice::from_raw_parts(sid.0.cast(), len));
        let inherit = if directory { "OICI" } else { "" };
        let sddl = wide(OsStr::new(&format!(
            "O:{sid_text}D:P(A;{inherit};FA;;;{sid_text})"
        )))?;
        let mut descriptor = null_mut();
        bool_result(ConvertStringSecurityDescriptorToSecurityDescriptorW(
            sddl.as_ptr(),
            SDDL_REVISION_1,
            &mut descriptor,
            null_mut(),
        ))?;
        Ok(LocalAllocation(descriptor))
    }
}

fn attributes(descriptor: &LocalAllocation) -> SECURITY_ATTRIBUTES {
    SECURITY_ATTRIBUTES {
        nLength: size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: descriptor.0,
        bInheritHandle: 0,
    }
}

/// One instance of the shared embedding worker's named pipe, with the
/// same owner-only protected DACL as private files; remote clients refused.
pub(crate) fn create_private_pipe(
    name: &str,
    first: bool,
) -> io::Result<tokio::net::windows::named_pipe::NamedPipeServer> {
    let descriptor = private_descriptor(false)?;
    let mut attrs = attributes(&descriptor);
    let mut options = tokio::net::windows::named_pipe::ServerOptions::new();
    options
        .first_pipe_instance(first)
        .reject_remote_clients(true);
    // SAFETY: `attrs` and the descriptor it points to stay alive for this
    // synchronous CreateNamedPipeW call, which copies the security descriptor.
    unsafe {
        options.create_with_security_attributes_raw(
            name,
            (&mut attrs as *mut SECURITY_ATTRIBUTES).cast(),
        )
    }
}

pub(crate) fn create_private_dir(path: &Path) -> io::Result<()> {
    let path = wide(path.as_os_str())?;
    let descriptor = private_descriptor(true)?;
    let attrs = attributes(&descriptor);
    // SAFETY: path/descriptor/attributes are valid for this synchronous call.
    unsafe { bool_result(CreateDirectoryW(path.as_ptr(), &attrs)) }
}

pub(crate) fn make_private(path: &Path) -> io::Result<()> {
    let path = wide(path.as_os_str())?;
    let descriptor = private_descriptor(true)?;
    // SAFETY: the canonical, no-reparse fresh root is owner-controlled. The
    // descriptor contains the current user's owner SID and protected DACL.
    unsafe {
        bool_result(SetFileSecurityW(
            path.as_ptr(),
            OWNER_SECURITY_INFORMATION
                | DACL_SECURITY_INFORMATION
                | PROTECTED_DACL_SECURITY_INFORMATION,
            descriptor.0,
        ))
    }
}

/// The owner-only shape for the CLI's credential files and directories:
/// this user as owner and a protected DACL with one full-control entry for
/// this user (inheritable on a directory, so children start owner-only).
pub(crate) fn make_owner_only(path: &Path, directory: bool) -> io::Result<()> {
    let path = wide(path.as_os_str())?;
    let descriptor = private_descriptor(directory)?;
    // SAFETY: NUL-terminated path and a live descriptor holding the current
    // user's owner SID and protected DACL, for this synchronous call.
    unsafe {
        bool_result(SetFileSecurityW(
            path.as_ptr(),
            OWNER_SECURITY_INFORMATION
                | DACL_SECURITY_INFORMATION
                | PROTECTED_DACL_SECURITY_INFORMATION,
            descriptor.0,
        ))
    }
}

/// Exactly [`make_owner_only`]'s shape, read without following a reparse
/// point: this user owns it, the DACL is protected (nothing inherited) and
/// holds exactly one entry, an allow of full control for this user.
pub(crate) fn is_owner_only(path: &Path) -> io::Result<bool> {
    use std::os::windows::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new()
        .access_mode(READ_CONTROL | FILE_READ_ATTRIBUTES)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)?;
    if crate::paths::is_link(&file.metadata()?) {
        return Ok(false);
    }
    let (_token, user) = user_token()?;
    let mut owner = null_mut();
    let mut acl = null_mut();
    let mut descriptor = null_mut();
    // SAFETY: valid open handle, live aligned user buffer, and API-owned
    // descriptor covering the owner SID, DACL and ACE until LocalFree.
    unsafe {
        let status = GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut acl,
            null_mut(),
            &mut descriptor,
        );
        if status != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        let descriptor = LocalAllocation(descriptor);
        let user = &*user.as_ptr().cast::<TOKEN_USER>();
        let mut control = 0u16;
        let mut revision = 0u32;
        bool_result(GetSecurityDescriptorControl(
            descriptor.0,
            &mut control,
            &mut revision,
        ))?;
        if owner.is_null()
            || EqualSid(owner, user.User.Sid) == 0
            || control & SE_DACL_PROTECTED == 0
            || acl.is_null()
            || (*acl).AceCount != 1
        {
            return Ok(false);
        }
        let mut ace = null_mut();
        bool_result(GetAce(acl, 0, &mut ace))?;
        if (*ace.cast::<ACE_HEADER>()).AceType != ACCESS_ALLOWED_ACE_TYPE {
            return Ok(false);
        }
        let ace = &*ace.cast::<ACCESS_ALLOWED_ACE>();
        let sid = std::ptr::addr_of!(ace.SidStart).cast_mut().cast();
        Ok(ace.Mask == FILE_ALL_ACCESS && EqualSid(sid, user.User.Sid) != 0)
    }
}

/// DPAPI for this user (CurrentUser scope, no entropy, never any UI): the
/// same protection as .NET `ProtectedData` with `CurrentUser`, so blobs
/// written either way open either way.
pub(crate) fn dpapi(data: &[u8], encrypt: bool) -> io::Result<zeroize::Zeroizing<Vec<u8>>> {
    use windows_sys::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
    };
    let input = CRYPT_INTEGER_BLOB {
        cbData: u32::try_from(data.len())
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "credential too large"))?,
        pbData: data.as_ptr().cast_mut(),
    };
    let mut output = CRYPT_INTEGER_BLOB {
        cbData: 0,
        pbData: null_mut(),
    };
    // SAFETY: the input blob borrows `data` (never written) for this
    // synchronous call; optional pointers are null; the API allocates the
    // output with LocalAlloc, which the allocation guard frees after the
    // bytes are copied and the buffer is wiped.
    unsafe {
        bool_result(if encrypt {
            CryptProtectData(
                &input,
                null(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        } else {
            CryptUnprotectData(
                &input,
                null_mut(),
                null(),
                null(),
                null(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut output,
            )
        })?;
        if output.pbData.is_null() {
            return Ok(zeroize::Zeroizing::new(Vec::new()));
        }
        let _allocation = LocalAllocation(output.pbData.cast());
        let bytes = std::slice::from_raw_parts_mut(output.pbData, output.cbData as usize);
        let copy = zeroize::Zeroizing::new(bytes.to_vec());
        zeroize::Zeroize::zeroize(bytes);
        Ok(copy)
    }
}

pub(crate) fn check_private(path: &Path) -> io::Result<bool> {
    let path = wide(path.as_os_str())?;
    // SAFETY: no-follow open, no data access, owned handle. Reparse handles
    // are inspected themselves instead of following their target.
    let file = unsafe {
        owned(CreateFileW(
            path.as_ptr(),
            READ_CONTROL | FILE_READ_ATTRIBUTES,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            null(),
            OPEN_EXISTING,
            FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS,
            null_mut(),
        ))?
    };
    check_private_handle(file.as_raw_handle(), SE_FILE_OBJECT)
}

pub(crate) fn check_private_file(file: &File) -> io::Result<bool> {
    check_private_handle(file.as_raw_handle(), SE_FILE_OBJECT)
}

/// Ancestors need integrity, not confidentiality: public read access on the
/// volume root and Users directory is normal. Only this user, SYSTEM, local
/// administrators and the TrustedInstaller servicing account (the default
/// owner of the system volume root on Windows 10/11) may own an ancestor,
/// replace entries or change ownership/security/reparse data.
pub(crate) fn check_directory_integrity(path: &Path) -> io::Result<bool> {
    use std::os::windows::fs::OpenOptionsExt;
    let file = std::fs::OpenOptions::new()
        .access_mode(READ_CONTROL | FILE_READ_ATTRIBUTES)
        .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)?;
    if crate::paths::is_link(&file.metadata()?) {
        return Ok(false);
    }
    check_security_handle(file.as_raw_handle(), SE_FILE_OBJECT, true)
}

/// Bytes available to this user on the volume holding `root` (a drive root),
/// honouring per-user disk quotas.
pub(crate) fn available_disk_bytes(root: &Path) -> io::Result<u64> {
    let root = wide(root.as_os_str())?;
    let mut available = 0u64;
    // SAFETY: NUL-terminated path; the output is a live u64 and the two
    // optional outputs are null.
    unsafe {
        bool_result(GetDiskFreeSpaceExW(
            root.as_ptr(),
            &mut available,
            null_mut(),
            null_mut(),
        ))?;
    }
    Ok(available)
}

/// Volume serial plus file index: the identity of an open file or directory.
pub(crate) fn file_identity(file: &File) -> io::Result<[u32; 3]> {
    // SAFETY: the handle is borrowed live; the output is a fully sized,
    // zero-initialized Win32 structure the call only writes into.
    unsafe {
        let mut info: BY_HANDLE_FILE_INFORMATION = std::mem::zeroed();
        bool_result(GetFileInformationByHandle(file.as_raw_handle(), &mut info))?;
        Ok([
            info.dwVolumeSerialNumber,
            info.nFileIndexHigh,
            info.nFileIndexLow,
        ])
    }
}

/// The file's ChangeTime (any data, attribute or security change moves it).
pub(crate) fn file_change_time(file: &File) -> io::Result<i64> {
    // SAFETY: the handle is borrowed live; the output is a fully sized,
    // zero-initialized Win32 structure the call only writes into.
    unsafe {
        let mut info: FILE_BASIC_INFO = std::mem::zeroed();
        bool_result(GetFileInformationByHandleEx(
            file.as_raw_handle(),
            FileBasicInfo,
            (&mut info as *mut FILE_BASIC_INFO).cast(),
            size_of::<FILE_BASIC_INFO>() as u32,
        ))?;
        Ok(info.ChangeTime)
    }
}

/// `NT SERVICE\TrustedInstaller`: a service SID (SHA-1 of the service name),
/// identical on every Windows installation. It owns `C:\` by default and is
/// more privileged than SYSTEM, so trusting it adds no unprivileged principal.
const TRUSTED_INSTALLER_SID: &str =
    "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464";

fn trusted_installer_sid() -> io::Result<LocalAllocation> {
    let text = wide(OsStr::new(TRUSTED_INSTALLER_SID))?;
    let mut sid = null_mut();
    // SAFETY: NUL-terminated input; the API allocates the SID, which the
    // returned allocation frees.
    unsafe {
        bool_result(ConvertStringSidToSidW(text.as_ptr(), &mut sid))?;
    }
    Ok(LocalAllocation(sid))
}

fn check_private_handle(handle: HANDLE, object_type: SE_OBJECT_TYPE) -> io::Result<bool> {
    check_security_handle(handle, object_type, false)
}

fn check_security_handle(
    handle: HANDLE,
    object_type: SE_OBJECT_TYPE,
    directory_integrity: bool,
) -> io::Result<bool> {
    let (_token, user) = user_token()?;
    let mut owner = null_mut();
    let mut acl = null_mut();
    let mut descriptor = null_mut();
    // SAFETY: valid open handle, live aligned user buffer, and API-owned
    // descriptor covers every ACE/SID until LocalFree. Unknown ACEs fail shut.
    unsafe {
        let status = GetSecurityInfo(
            handle,
            object_type,
            OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
            &mut owner,
            null_mut(),
            &mut acl,
            null_mut(),
            &mut descriptor,
        );
        if status != ERROR_SUCCESS {
            return Err(io::Error::from_raw_os_error(status as i32));
        }
        let _descriptor = LocalAllocation(descriptor);
        let user = &*user.as_ptr().cast::<TOKEN_USER>();
        let installer = if directory_integrity {
            Some(trusted_installer_sid()?)
        } else {
            None
        };
        let trusted = |sid| {
            EqualSid(sid, user.User.Sid) != 0
                || (directory_integrity
                    && (IsWellKnownSid(sid, WinLocalSystemSid) != 0
                        || IsWellKnownSid(sid, WinBuiltinAdministratorsSid) != 0
                        || installer
                            .as_ref()
                            .is_some_and(|installer| EqualSid(sid, installer.0) != 0)))
        };
        if owner.is_null() || !trusted(owner) || acl.is_null() || (*acl).AceCount == 0 {
            return Ok(false);
        }
        for index in 0..(*acl).AceCount {
            let mut ace = null_mut();
            bool_result(GetAce(acl, u32::from(index), &mut ace))?;
            let header = &*ace.cast::<ACE_HEADER>();
            if header.AceType != ACCESS_ALLOWED_ACE_TYPE {
                return Ok(false);
            }
            let ace = &*ace.cast::<ACCESS_ALLOWED_ACE>();
            let sid = std::ptr::addr_of!(ace.SidStart).cast_mut().cast();
            // Add-file/subdirectory rights alone cannot alter an existing,
            // protected child. Inherit-only entries do not apply to this dir.
            let mutates_directory = u32::from(header.AceFlags) & INHERIT_ONLY_ACE == 0
                && ace.Mask
                    & (DELETE
                        | WRITE_DAC
                        | WRITE_OWNER
                        | FILE_DELETE_CHILD
                        | FILE_WRITE_ATTRIBUTES
                        | FILE_WRITE_EA
                        | GENERIC_WRITE
                        | GENERIC_ALL)
                    != 0;
            if !trusted(sid) && (!directory_integrity || mutates_directory) {
                return Ok(false);
            }
        }
        Ok(true)
    }
}

/// The owner process is the only long-lived job handle holder; its child
/// supervisors retain a non-inheritable copy until wait, so dropping a guard
/// cannot prematurely kill a live read. Children inherit no job handle.
/// A successor first acquires the persistent byte lock, then polls
/// the old named job with short-lived handles (closing each lets owner death
/// trigger KILL_ON_JOB_CLOSE). It cannot return a guard until ActiveProcesses
/// is zero. The name binds the lock FILE ID, not case-sensitive path spelling.
#[derive(Debug)]
pub(crate) struct DrainJob {
    // Drop job first: this kills the suspended broker and every child.
    job: Option<OwnedHandle>,
    broker: Mutex<Option<OwnedHandle>>,
}

impl DrainJob {
    pub(crate) fn unused() -> Self {
        Self {
            job: None,
            broker: Mutex::new(None),
        }
    }

    pub(crate) fn acquire(file: &File) -> io::Result<Option<Self>> {
        let mut info = BY_HANDLE_FILE_INFORMATION::default();
        // SAFETY: a valid store-lock file and correctly sized output struct.
        unsafe {
            bool_result(GetFileInformationByHandle(file.as_raw_handle(), &mut info))?;
        }
        let name = wide(OsStr::new(&format!(
            "Global\\kb-local-drain-v1-{:x}-{:x}-{:x}",
            info.dwVolumeSerialNumber, info.nFileIndexHigh, info.nFileIndexLow
        )))?;
        let descriptor = private_descriptor(false)?;
        let attrs = attributes(&descriptor);
        {
            // SAFETY: non-inheritable job and a private live security descriptor.
            let job = unsafe { owned(CreateJobObjectW(&attrs, name.as_ptr()))? };
            // CreateJobObject opens an existing name without applying attrs.
            // Refuse a precreated/broadened object that another user could pin
            // open, which would suppress the owner's kill-on-close boundary.
            if !check_private_handle(job.as_raw_handle(), SE_KERNEL_OBJECT)? {
                return Err(io::Error::new(
                    io::ErrorKind::PermissionDenied,
                    "job access control is not private",
                ));
            }
            let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
            // SAFETY: job handle and output struct remain alive for both calls.
            unsafe {
                bool_result(QueryInformationJobObject(
                    job.as_raw_handle(),
                    JobObjectBasicAccountingInformation,
                    (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                    size_of_val(&accounting) as u32,
                    null_mut(),
                ))?;
                if accounting.ActiveProcesses == 0 {
                    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
                    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
                    bool_result(SetInformationJobObject(
                        job.as_raw_handle(),
                        JobObjectExtendedLimitInformation,
                        (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                        size_of_val(&limits) as u32,
                    ))?;
                    return Ok(Some(Self {
                        job: Some(job),
                        broker: Mutex::new(None),
                    }));
                }
            }
            drop(job); // Never pin a dead owner's kill-on-close job while waiting.
            Ok(None)
        }
    }

    fn anonymous() -> io::Result<Self> {
        let descriptor = private_descriptor(false)?;
        let attrs = attributes(&descriptor);
        // SAFETY: private non-inheritable job, valid security attributes.
        let job = unsafe { owned(CreateJobObjectW(&attrs, null()))? };
        if !check_private_handle(job.as_raw_handle(), SE_KERNEL_OBJECT)? {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "job access control is not private",
            ));
        }
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        // SAFETY: owned job and correctly sized limit struct.
        unsafe {
            bool_result(SetInformationJobObject(
                job.as_raw_handle(),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                size_of_val(&limits) as u32,
            ))?;
        }
        Ok(Self {
            job: Some(job),
            broker: Mutex::new(None),
        })
    }

    fn broker(&self) -> io::Result<OwnedHandle> {
        let mut broker = self
            .broker
            .lock()
            .map_err(|_| io::Error::other("broker lock poisoned"))?;
        if broker.is_none() {
            *broker = Some(suspended_broker(self.handle()?)?);
        }
        broker
            .as_ref()
            .ok_or_else(|| io::Error::other("broker missing"))?
            .try_clone()
    }

    fn handle(&self) -> io::Result<HANDLE> {
        self.job
            .as_ref()
            .map(AsRawHandle::as_raw_handle)
            .ok_or_else(|| io::Error::other("store job missing"))
    }
}

pub enum Input {
    Null,
    Pipe,
    From(File),
}

/// Supervision uses the same operations as std::process::Child. OwnedHandle
/// supplies thread-safe handle ownership without manually implementing Send.
pub struct ProcessChild {
    process: OwnedHandle,
    // This child and every descendant: `kill` must reach a launcher's real
    // process (Git for Windows' `cmd\git.exe` runs `mingw64\bin\git.exe`).
    tree: OwnedHandle,
    id: u32,
    pub stdin: Option<File>,
    pub stdout: Option<File>,
    // Unlocked readers still isolate their stdio duplicates in a broker.
    // Locked readers/writers borrow their guard's shared job instead.
    _standalone_job: Option<DrainJob>,
    // Retain the locked job when the guard drops before this child exits.
    // All copies remain in the owner process, so owner death still kills it.
    shared_job: Option<OwnedHandle>,
}

impl ProcessChild {
    pub fn id(&self) -> u32 {
        self.id
    }
    pub fn kill(&mut self) -> io::Result<()> {
        // SAFETY: the child's own job handle remains owned for this call.
        unsafe { bool_result(TerminateJobObject(self.tree.as_raw_handle(), 1)) }
    }
    pub fn wait(&mut self) -> io::Result<ExitStatus> {
        // SAFETY: process handle remains owned until the exit status is read.
        unsafe {
            if WaitForSingleObject(self.process.as_raw_handle(), INFINITE) == WAIT_FAILED {
                return Err(io::Error::last_os_error());
            }
            let mut code = 0;
            bool_result(GetExitCodeProcess(self.process.as_raw_handle(), &mut code))?;
            // Successful wait ends this supervisor's ownership. If the guard
            // is already gone, closing this last copy drains the broker/job.
            drop(self.shared_job.take());
            Ok(ExitStatus::from_raw(code))
        }
    }
    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        // SAFETY: owned process handle; zero timeout never blocks the mutex
        // used by the deadline killer. A signaled process can then be waited
        // immediately using the same status/job-release path as wait().
        match unsafe { WaitForSingleObject(self.process.as_raw_handle(), 0) } {
            WAIT_OBJECT_0 => self.wait().map(Some),
            WAIT_TIMEOUT => Ok(None),
            _ => Err(io::Error::last_os_error()),
        }
    }
}

// Inheritable handles exist ONLY in the suspended broker's handle table.
// std::process::Command on another owner thread can inherit all owner handles,
// so temporarily setting inheritance in the owner would leak despite our own
// HANDLE_LIST. PARENT_PROCESS makes the broker the inheritance source.
struct RemoteHandle<'a> {
    process: &'a OwnedHandle,
    handle: HANDLE,
}
impl<'a> RemoteHandle<'a> {
    fn new(handle: HANDLE, process: &'a OwnedHandle) -> io::Result<Self> {
        let mut remote = null_mut();
        // SAFETY: source belongs to this process; target is our suspended
        // broker. The inheritable duplicate is created in that process only.
        unsafe {
            bool_result(DuplicateHandle(
                GetCurrentProcess(),
                handle,
                process.as_raw_handle(),
                &mut remote,
                0,
                1,
                DUPLICATE_SAME_ACCESS,
            ))?;
        }
        Ok(Self {
            process,
            handle: remote,
        })
    }
}
impl Drop for RemoteHandle<'_> {
    fn drop(&mut self) {
        let mut local = null_mut();
        // SAFETY: this remote handle is uniquely owned, and the process
        // handle remains alive. CLOSE_SOURCE closes it in the broker; the
        // returned local copy is explicitly non-inheritable and closed here.
        unsafe {
            if DuplicateHandle(
                self.process.as_raw_handle(),
                self.handle,
                GetCurrentProcess(),
                &mut local,
                0,
                0,
                DUPLICATE_SAME_ACCESS | DUPLICATE_CLOSE_SOURCE,
            ) != 0
            {
                drop(owned(local));
            }
        }
        // If the broker was externally killed, its handle table is already
        // gone. Otherwise the job's final closure bounds remaining handles.
    }
}

fn suspended_broker(job: HANDLE) -> io::Result<OwnedHandle> {
    // Map our own executable but NEVER resume it: no command dispatch, code,
    // stdin, external executable, or additional helper artifact is required.
    let application = wide(std::env::current_exe()?.as_os_str())?;
    let mut line = vec![0u16];
    let env = [0u16; 2];
    let jobs = [job];
    let mut attributes = AttributeList::new(1)?;
    attributes.set(PROC_THREAD_ATTRIBUTE_JOB_LIST, &jobs)?;
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.lpAttributeList = attributes.ptr();
    let mut process = PROCESS_INFORMATION::default();
    // SAFETY: buffers/list/job live through creation. No handles are inherited.
    // Job assignment is atomic with creation; owner death cannot leave an
    // unassigned suspended process. Thread is never resumed and closes here.
    unsafe {
        bool_result(CreateProcessW(
            application.as_ptr(),
            line.as_mut_ptr(),
            null(),
            null(),
            0,
            EXTENDED_STARTUPINFO_PRESENT
                | CREATE_UNICODE_ENVIRONMENT
                | CREATE_NO_WINDOW
                | CREATE_SUSPENDED,
            env.as_ptr().cast(),
            null(),
            &startup.StartupInfo,
            &mut process,
        ))?;
        drop(owned(process.hThread)?);
        owned(process.hProcess)
    }
}

fn pipe() -> io::Result<(File, File)> {
    let mut read = null_mut();
    let mut write = null_mut();
    // SAFETY: output pointers are valid. Both new handles are non-inheritable
    // and transferred once into RAII File ownership after success.
    unsafe {
        bool_result(CreatePipe(&mut read, &mut write, null(), 0))?;
        Ok((File::from_raw_handle(read), File::from_raw_handle(write)))
    }
}

struct AttributeList {
    buffer: Vec<usize>,
}
impl AttributeList {
    fn new(count: u32) -> io::Result<Self> {
        let mut bytes = 0;
        // SAFETY: null first probe obtains required size; word-aligned buffer
        // is at least that size, and remains fixed until deletion on drop.
        unsafe {
            InitializeProcThreadAttributeList(null_mut(), count, 0, &mut bytes);
            if bytes == 0 {
                return Err(io::Error::last_os_error());
            }
            let mut list = Self {
                buffer: vec![0; bytes.div_ceil(size_of::<usize>())],
            };
            if let Err(error) = bool_result(InitializeProcThreadAttributeList(
                list.ptr(),
                count,
                0,
                &mut bytes,
            )) {
                // Failed initialization must not call Delete on this buffer.
                list.buffer.clear();
                return Err(error);
            }
            Ok(list)
        }
    }
    fn ptr(&mut self) -> LPPROC_THREAD_ATTRIBUTE_LIST {
        self.buffer.as_mut_ptr().cast()
    }
    fn set(&mut self, key: u32, handles: &[HANDLE]) -> io::Result<()> {
        // SAFETY: initialized list; caller keeps each handle array alive until
        // CreateProcessW finishes (Update stores these pointers, not copies).
        unsafe {
            bool_result(UpdateProcThreadAttribute(
                self.ptr(),
                0,
                key as usize,
                handles.as_ptr().cast(),
                size_of_val(handles),
                null_mut(),
                null(),
            ))
        }
    }
}
impl Drop for AttributeList {
    fn drop(&mut self) {
        // SAFETY: the buffer contains an initialized list, unless init failed.
        if !self.buffer.is_empty() {
            unsafe {
                DeleteProcThreadAttributeList(self.ptr());
            }
        }
    }
}

fn quote(arg: &OsStr, out: &mut Vec<u16>) -> io::Result<()> {
    out.push(b'"' as u16);
    let mut slashes = 0;
    for c in arg.encode_wide() {
        if c == 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "embedded NUL"));
        }
        if c == b'\\' as u16 {
            slashes += 1;
            continue;
        }
        out.extend(std::iter::repeat_n(
            b'\\' as u16,
            if c == b'"' as u16 {
                2 * slashes + 1
            } else {
                slashes
            },
        ));
        out.push(c);
        slashes = 0;
    }
    out.extend(std::iter::repeat_n(b'\\' as u16, 2 * slashes));
    out.push(b'"' as u16);
    Ok(())
}

fn executable(command: &Command) -> io::Result<PathBuf> {
    let program = Path::new(command.get_program());
    if program.is_absolute() {
        return Ok(program.to_path_buf());
    }
    // Hardened Git commands explicitly carry PATH. Do not search the store's
    // current directory, implicitly execute a .cmd, or use a shell.
    let path = command
        .get_envs()
        .find(|(key, _)| key.eq_ignore_ascii_case("PATH"))
        .and_then(|(_, value)| value)
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "child PATH missing"))?;
    for dir in std::env::split_paths(path) {
        let candidate = dir.join(program).with_extension("exe");
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    Err(io::Error::new(
        io::ErrorKind::NotFound,
        "child executable missing",
    ))
}

pub(crate) fn spawn(
    command: &Command,
    input: Input,
    owner: Option<&crate::locks::LockOwner>,
) -> io::Result<ProcessChild> {
    spawn_inner(command, input, owner, true)
}

pub(crate) fn spawn_credential(
    command: &Command,
    owner: Option<&crate::locks::LockOwner>,
) -> io::Result<ProcessChild> {
    // Retain kill-on-close/job drain without putting any lock handle in the
    // child's explicit inheritance list. The worker opens its own effect lock.
    spawn_inner(command, Input::Pipe, owner, false)
}

/// A private job for one child and its descendants, nested in the drain job
/// the child inherits from its broker (whose kill-on-close and drain still
/// cover the whole tree). No kill-on-close here: only an explicit kill ends it.
fn tree_job() -> io::Result<OwnedHandle> {
    let descriptor = private_descriptor(false)?;
    let attrs = attributes(&descriptor);
    // SAFETY: private non-inheritable anonymous job, valid security attributes.
    let job = unsafe { owned(CreateJobObjectW(&attrs, null()))? };
    if !check_private_handle(job.as_raw_handle(), SE_KERNEL_OBJECT)? {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "job access control is not private",
        ));
    }
    Ok(job)
}

fn spawn_inner(
    command: &Command,
    input: Input,
    owner: Option<&crate::locks::LockOwner>,
    inherit_lock: bool,
) -> io::Result<ProcessChild> {
    let application = wide(executable(command)?.as_os_str())?;
    let mut line = Vec::new();
    quote(command.get_program(), &mut line)?;
    for arg in command.get_args() {
        line.push(b' ' as u16);
        quote(arg, &mut line)?;
    }
    line.push(0);
    let mut envs: Vec<_> = command
        .get_envs()
        .filter_map(|(key, value)| value.map(|v| (key, v)))
        .collect();
    envs.sort_by_key(|(key, _)| key.to_string_lossy().to_ascii_uppercase());
    let mut env = Vec::new();
    for (key, value) in envs {
        let key = wide(key)?;
        env.extend_from_slice(&key[..key.len() - 1]);
        env.push(b'=' as u16);
        env.extend(wide(value)?);
    }
    if env.is_empty() {
        env.push(0);
    }
    env.push(0);
    let cwd = command
        .get_current_dir()
        .map(|p| wide(p.as_os_str()))
        .transpose()?;
    let nul = File::options().read(true).write(true).open("NUL")?;
    let (child_in, stdin) = match input {
        Input::Null => (nul.try_clone()?, None),
        Input::Pipe => {
            let (read, write) = pipe()?;
            (read, Some(write))
        }
        Input::From(file) => (file, None),
    };
    let (stdout, child_out) = pipe()?;
    let standalone_job = if owner.is_none() {
        Some(DrainJob::anonymous()?)
    } else {
        None
    };
    let job = owner
        .map(|o| &o.job)
        .or(standalone_job.as_ref())
        .ok_or_else(|| io::Error::other("job missing"))?;
    let shared_job = if owner.is_some() {
        job.job.as_ref().map(OwnedHandle::try_clone).transpose()?
    } else {
        None
    };
    let tree = tree_job()?;
    let broker = job.broker()?;
    let input_dup = RemoteHandle::new(child_in.as_raw_handle(), &broker)?;
    let output_dup = RemoteHandle::new(child_out.as_raw_handle(), &broker)?;
    let error_dup = RemoteHandle::new(nul.as_raw_handle(), &broker)?;
    let lock_dup = owner
        .filter(|_| inherit_lock)
        .map(|o| RemoteHandle::new(o.file.as_raw_handle(), &broker))
        .transpose()?;
    let mut handles = vec![input_dup.handle, output_dup.handle, error_dup.handle];
    if let Some(lock) = &lock_dup {
        handles.push(lock.handle);
    }
    let parents = [broker.as_raw_handle()];
    let mut attributes = AttributeList::new(2)?;
    attributes.set(PROC_THREAD_ATTRIBUTE_HANDLE_LIST, &handles)?;
    // The parent broker already belongs to the owner's job (or an anonymous
    // reader job). PARENT_PROCESS inherits that job atomically, before exec.
    attributes.set(PROC_THREAD_ATTRIBUTE_PARENT_PROCESS, &parents)?;
    let mut startup = STARTUPINFOEXW::default();
    startup.StartupInfo.cb = size_of::<STARTUPINFOEXW>() as u32;
    startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
    startup.StartupInfo.hStdInput = input_dup.handle;
    startup.StartupInfo.hStdOutput = output_dup.handle;
    startup.StartupInfo.hStdError = error_dup.handle;
    startup.lpAttributeList = attributes.ptr();
    let mut process = PROCESS_INFORMATION::default();
    // SAFETY: all buffers, handle arrays, duplicates and the job stay alive
    // through CreateProcessW. HANDLE_LIST names broker-table handles only;
    // PARENT_PROCESS inherits the broker's job before the first instruction.
    // The job handle itself is never inherited. Owner handles never become
    // inheritable, including during a concurrent unrelated std Command spawn.
    // The child starts suspended and runs only once it is in its own tree job,
    // so every descendant it creates is in that job too.
    unsafe {
        bool_result(CreateProcessW(
            application.as_ptr(),
            line.as_mut_ptr(),
            null(),
            null(),
            1,
            EXTENDED_STARTUPINFO_PRESENT
                | CREATE_UNICODE_ENVIRONMENT
                | CREATE_NO_WINDOW
                | CREATE_SUSPENDED,
            env.as_ptr().cast(),
            cwd.as_ref().map_or(null(), |c| c.as_ptr()),
            &startup.StartupInfo,
            &mut process,
        ))?;
        let thread = owned(process.hThread)?;
        let child = owned(process.hProcess)?;
        if AssignProcessToJobObject(tree.as_raw_handle(), child.as_raw_handle()) == 0
            || ResumeThread(thread.as_raw_handle()) == u32::MAX
        {
            let error = io::Error::last_os_error();
            TerminateProcess(child.as_raw_handle(), 1);
            return Err(error);
        }
        drop(thread);
        Ok(ProcessChild {
            process: child,
            tree,
            id: process.dwProcessId,
            stdin,
            stdout: Some(stdout),
            _standalone_job: standalone_job,
            shared_job,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// An ancestor this user may not add entries to (`C:\Users` for a
    /// standard account) is skipped by the ancestor barrier only because its
    /// DACL says so; a managed sync of it still refuses. A private directory
    /// grants add rights and is flushed.
    #[test]
    fn ancestor_barrier_skips_only_what_the_acl_denies() {
        let base = std::env::temp_dir().join(format!(
            "kb-win-ancestor-{}",
            crate::state::new_uuid_v4().expect("uuid")
        ));
        create_private_dir(&base).expect("private directory");
        let own = crate::paths::open_directory(&base).expect("open");
        assert!(may_add_entries(&own).expect("access check"));
        sync_ancestor_directory(&base).expect("flushed");
        drop(own);
        std::fs::remove_dir(&base).expect("fixture cleanup");
        let drive = std::env::var("SystemDrive").expect("system drive");
        let users = PathBuf::from(format!("{drive}\\Users"));
        let handle = crate::paths::open_directory(&users).expect("open Users");
        let may_add = may_add_entries(&handle).expect("access check");
        sync_ancestor_directory(&users).expect("ancestor barrier");
        // Elevated sessions may add to it (and then flush); others may not.
        assert_eq!(sync_directory(&users).is_ok(), may_add);
        // Opens refused although the DACL grants add rights (a filter, a
        // label): the ancestor barrier fails closed instead of skipping.
        let granted = std::env::temp_dir().join(format!(
            "kb-win-ancestor-denied-{}",
            crate::state::new_uuid_v4().expect("uuid")
        ));
        create_private_dir(&granted).expect("private directory");
        DENY_FLUSHABLE_OPENS.set(true);
        let refused = sync_ancestor_directory(&granted);
        let skipped = (!may_add).then(|| sync_ancestor_directory(&users));
        DENY_FLUSHABLE_OPENS.set(false);
        assert_eq!(
            refused
                .expect_err("a refusal the DACL does not explain")
                .raw_os_error(),
            Some(ERROR_ACCESS_DENIED as i32)
        );
        // Where the DACL itself denies add rights, the skip still applies.
        if let Some(skipped) = skipped {
            skipped.expect("no add rights: nothing of ours to flush");
        }
        std::fs::remove_dir(&granted).expect("fixture cleanup");
    }

    /// A file created without a security descriptor is owned by this user,
    /// also where the token's default owner was `BUILTIN\Administrators`
    /// (an elevated administrator on Windows Server, such as hosted CI under
    /// PowerShell), so the owner-only checks accept what kb itself creates.
    #[test]
    fn objects_created_without_a_descriptor_are_owned_by_this_user() {
        user_owns_new_objects().expect("default owner");
        let token = process_token(TOKEN_QUERY).expect("token");
        let user = token_information(&token, TokenUser).expect("user");
        let owner = token_information(&token, TokenOwner).expect("owner");
        let base = std::env::temp_dir().join(format!(
            "kb-win-default-owner-{}",
            crate::state::new_uuid_v4().expect("uuid")
        ));
        create_private_dir(&base).expect("private directory");
        let path = base.join("created.txt");
        std::fs::write(&path, b"x").expect("plain create");
        let file = File::open(&path).expect("open");
        let mut file_owner = null_mut();
        let mut descriptor = null_mut();
        // SAFETY: aligned token buffers; live handle; the API-owned descriptor
        // (which holds `file_owner`) is freed by its guard after the checks.
        unsafe {
            let user = &*user.as_ptr().cast::<TOKEN_USER>();
            let owner = &*owner.as_ptr().cast::<TOKEN_OWNER>();
            assert_ne!(EqualSid(owner.Owner, user.User.Sid), 0, "default owner");
            let status = GetSecurityInfo(
                file.as_raw_handle(),
                SE_FILE_OBJECT,
                OWNER_SECURITY_INFORMATION,
                &mut file_owner,
                null_mut(),
                null_mut(),
                null_mut(),
                &mut descriptor,
            );
            assert_eq!(status, ERROR_SUCCESS);
            let _descriptor = LocalAllocation(descriptor);
            assert_ne!(EqualSid(file_owner, user.User.Sid), 0, "file owner");
        }
        assert!(check_private_file(&file).expect("check"));
        drop(file);
        std::fs::remove_dir_all(&base).expect("fixture cleanup");
    }

    /// The CLI credential shape: set and checked natively, refused when the
    /// DACL is broadened or only inherited; DPAPI round-trips, refuses a
    /// tampered blob and opens one written by .NET `ProtectedData`
    /// (credentials saved before the helpers became native).
    #[test]
    fn owner_only_shape_and_dpapi_match_the_credential_contract() {
        let base = std::env::temp_dir().join(format!(
            "kb-win-owner-only-{}",
            crate::state::new_uuid_v4().expect("uuid")
        ));
        std::fs::create_dir(&base).expect("fixture");
        assert!(!is_owner_only(&base).expect("inherited ACL read"));
        make_owner_only(&base, true).expect("owner-only directory");
        assert!(is_owner_only(&base).expect("owner-only directory read"));
        let file = base.join("credential.json");
        std::fs::write(&file, b"{}").expect("fixture file");
        assert!(
            !is_owner_only(&file).expect("inherited entry read"),
            "an inherited entry is not the protected shape"
        );
        make_owner_only(&file, false).expect("owner-only file");
        assert!(is_owner_only(&file).expect("owner-only file read"));
        let output = Command::new("icacls")
            .arg(&file)
            .args(["/grant", "*S-1-1-0:R"])
            .output()
            .expect("fixture ACL");
        assert!(output.status.success(), "{output:?}");
        assert!(!is_owner_only(&file).expect("broadened read"));

        let secret = b"disposable-dpapi-canary";
        let blob = dpapi(secret, true).expect("protect");
        assert!(!blob.windows(secret.len()).any(|w| w == secret));
        assert_eq!(dpapi(&blob, false).expect("unprotect").as_slice(), secret);
        let mut tampered = blob.to_vec();
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        assert!(dpapi(&tampered, false).is_err());
        let output = Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes('disposable-dpapi-canary'),$null,[Security.Cryptography.DataProtectionScope]::CurrentUser))",
            ])
            .output()
            .expect(".NET DPAPI fixture");
        assert!(output.status.success(), "{output:?}");
        use base64::Engine as _;
        let legacy = base64::engine::general_purpose::STANDARD
            .decode(String::from_utf8_lossy(&output.stdout).trim())
            .expect("base64 blob");
        assert_eq!(
            dpapi(&legacy, false).expect("legacy blob").as_slice(),
            secret
        );
        std::fs::remove_dir_all(base).expect("fixture cleanup");
    }

    /// A kill reaches the child's descendants, as Git for Windows needs
    /// (`cmd\git.exe` runs `mingw64\bin\git.exe`): here Git runs a shell
    /// alias that runs `ping`, which writes to the inherited stdout pipe. Once
    /// killed, no surviving writer may keep that pipe open.
    #[test]
    fn kill_reaches_a_launchers_descendants() {
        use std::io::Read;
        let mut command = Command::new("git");
        command.args(["-c", "alias.kb-slow=!ping -n 120 127.0.0.1", "kb-slow"]);
        for key in ["PATH", "SystemRoot"] {
            if let Some(value) = std::env::var_os(key) {
                command.env(key, value);
            }
        }
        let mut child = spawn(&command, Input::Null, None).expect("spawn");
        let mut stdout = child.stdout.take().expect("stdout");
        // The grandchild is running once its first output arrives.
        let mut first = [0u8; 16];
        assert!(stdout.read(&mut first).expect("ping output") > 0);
        child.kill().expect("kill");
        let (done, drained) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let mut rest = Vec::new();
            let _ = done.send(stdout.read_to_end(&mut rest).map(|_| ()));
        });
        drained
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("every writer of the pipe was killed")
            .expect("pipe read to end");
        assert!(!child.wait().expect("reaped").success());
    }

    #[test]
    fn directory_integrity_allows_public_reads_but_rejects_public_mutation() {
        let base = std::env::temp_dir().join(format!(
            "kb-win-model-ancestor-{}",
            crate::state::new_uuid_v4().expect("uuid")
        ));
        create_private_dir(&base).expect("private ancestor");
        for (rights, trusted) in [("R", true), ("M", false)] {
            let output = Command::new("icacls")
                .arg(&base)
                .args(["/grant:r", &format!("*S-1-1-0:{rights}")])
                .output()
                .expect("fixture ACL");
            assert!(output.status.success(), "{output:?}");
            assert_eq!(
                check_directory_integrity(&base).expect("integrity"),
                trusted
            );
            assert!(!check_private(&base).expect("public reads are not private"));
        }
        std::fs::remove_dir(base).expect("fixture cleanup");
    }

    #[test]
    fn directory_barrier_flushes_metadata_and_rejects_read_only_handle() {
        let base = std::env::temp_dir().join(format!(
            "kb-win-flush-{}",
            crate::state::new_uuid_v4().expect("uuid")
        ));
        create_private_dir(&base).expect("private directory");
        let store =
            crate::Store::open(&base.join("store")).expect("durable Windows store initialization");
        sync_directory(&base).expect("native writable directory barrier");
        let readonly = crate::paths::open_directory(&base).expect("read-only directory handle");
        assert!(
            flush_directory_handle(&readonly).is_err(),
            "a failed native barrier must propagate"
        );
        let mut model =
            crate::model_catalog::descriptor("embeddinggemma-2-q8_0").expect("descriptor");
        model.size_bytes = 3;
        model.sha256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".into();
        // The per-user model cache publishes durably beside the store.
        let cache = crate::model_download::ModelCache::new(base.join("models")).expect("cache");
        // Wherever the cache decided to publish (the configured directory
        // when its chain is protected): the returned path is the file.
        let published = cache
            .publish_reader(&model, std::io::Cursor::new(b"abc"))
            .expect("durable model publication");
        let identity = store.store_uuid().clone();
        drop(store);
        let reopened = crate::Store::open(&base.join("store")).expect("reopen");
        assert_eq!(*reopened.store_uuid(), identity);
        assert!(
            crate::model_download::verify_artifact(&published, &model)
                .expect("verified published bytes")
        );
        drop(reopened);
        drop(readonly);
        std::fs::remove_dir_all(base).expect("fixture cleanup");
    }

    #[test]
    fn a_configured_dir_others_can_change_publishes_into_verified() {
        let base = std::env::temp_dir().join(format!(
            "kb-win-model-fallback-{}",
            crate::state::new_uuid_v4().expect("uuid")
        ));
        create_private_dir(&base).expect("private base");
        let shared = base.join("shared");
        create_private_dir(&shared).expect("configured dir");
        let output = Command::new("icacls")
            .arg(&shared)
            .args(["/grant", "*S-1-1-0:(OI)(CI)M"])
            .output()
            .expect("fixture ACL");
        assert!(output.status.success(), "{output:?}");
        let mut model =
            crate::model_catalog::descriptor("embeddinggemma-2-q8_0").expect("descriptor");
        model.size_bytes = 3;
        model.sha256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad".into();
        let cache =
            crate::model_download::ModelCache::with_private(shared.clone(), base.join("private"))
                .expect("cache");
        let published = cache
            .publish_reader(&model, std::io::Cursor::new(b"abc"))
            .expect("published");
        assert_eq!(
            published.parent().and_then(|p| p.canonicalize().ok()),
            base.join("private").join("verified").canonicalize().ok(),
            "the untrusted configured directory is not used"
        );
        assert!(!shared.join(&model.file_name).exists());
        assert!(cache.resolve(&model).expect("found").trusted);
        std::fs::remove_dir_all(base).expect("fixture cleanup");
    }

    #[test]
    fn preexisting_named_job_with_broadened_acl_is_refused() {
        let base = std::env::temp_dir().join(format!("kb-win-job-acl-{}", std::process::id()));
        std::fs::create_dir(&base).expect("fixture");
        let file = File::options()
            .read(true)
            .write(true)
            .create_new(true)
            .open(base.join("store.lock"))
            .expect("fixture lock");
        let job = DrainJob::acquire(&file).expect("job").expect("fresh job");
        let sddl = wide(OsStr::new("D:P(A;;GA;;;WD)")).expect("sddl");
        let mut descriptor = null_mut();
        let mut acl = null_mut();
        let mut present = 0;
        let mut defaulted = 0;
        // SAFETY: fixture-owned job; converted descriptor lives through the
        // ACL extraction and update. Only this temporary named job is changed.
        unsafe {
            bool_result(ConvertStringSecurityDescriptorToSecurityDescriptorW(
                sddl.as_ptr(),
                SDDL_REVISION_1,
                &mut descriptor,
                null_mut(),
            ))
            .expect("descriptor");
            let descriptor = LocalAllocation(descriptor);
            bool_result(GetSecurityDescriptorDacl(
                descriptor.0,
                &mut present,
                &mut acl,
                &mut defaulted,
            ))
            .expect("dacl");
            assert_ne!(present, 0);
            assert_eq!(
                SetSecurityInfo(
                    job.handle().expect("job"),
                    SE_KERNEL_OBJECT,
                    DACL_SECURITY_INFORMATION,
                    null_mut(),
                    null_mut(),
                    acl,
                    null(),
                ),
                ERROR_SUCCESS
            );
        }
        assert!(
            DrainJob::acquire(&file).is_err(),
            "an existing job's ACL must be checked, not adopted"
        );
        drop(job);
        drop(file);
        std::fs::remove_dir_all(base).expect("cleanup");
    }

    #[test]
    fn broker_is_suspended_in_the_job_and_duplicates_are_remote() {
        let base = std::env::temp_dir().join(format!("kb-win-broker-{}", std::process::id()));
        std::fs::create_dir(&base).expect("fixture");
        let file = File::options()
            .read(true)
            .write(true)
            .create_new(true)
            .open(base.join("store.lock"))
            .expect("fixture lock");
        let job = DrainJob::acquire(&file).expect("job").expect("fresh job");
        let broker = job.broker().expect("broker");
        let remote = RemoteHandle::new(file.as_raw_handle(), &broker).expect("remote duplicate");
        let mut in_job = 0;
        let mut flags = 0;
        let mut round_trip = null_mut();
        // SAFETY: all handles are owned by this fixture; duplicate is alive
        // in the broker until after the inspection and round trip.
        unsafe {
            assert_ne!(GetProcessId(broker.as_raw_handle()), GetCurrentProcessId());
            assert_eq!(WaitForSingleObject(broker.as_raw_handle(), 0), WAIT_TIMEOUT);
            bool_result(IsProcessInJob(
                broker.as_raw_handle(),
                job.handle().expect("job"),
                &mut in_job,
            ))
            .expect("membership");
            assert_eq!(in_job, 1);
            bool_result(GetHandleInformation(file.as_raw_handle(), &mut flags)).expect("flags");
            assert_eq!(
                flags & HANDLE_FLAG_INHERIT,
                0,
                "owner's lock is never inheritable"
            );
            bool_result(DuplicateHandle(
                broker.as_raw_handle(),
                remote.handle,
                GetCurrentProcess(),
                &mut round_trip,
                0,
                0,
                DUPLICATE_SAME_ACCESS,
            ))
            .expect("round trip");
            let copy = owned(round_trip).expect("copy");
            let mut original_info = BY_HANDLE_FILE_INFORMATION::default();
            let mut copy_info = BY_HANDLE_FILE_INFORMATION::default();
            bool_result(GetFileInformationByHandle(
                file.as_raw_handle(),
                &mut original_info,
            ))
            .expect("original");
            bool_result(GetFileInformationByHandle(
                copy.as_raw_handle(),
                &mut copy_info,
            ))
            .expect("copy");
            assert_eq!(original_info.nFileIndexLow, copy_info.nFileIndexLow);
            assert_eq!(original_info.nFileIndexHigh, copy_info.nFileIndexHigh);
        }
        drop(remote);
        drop(job);
        // SAFETY: this non-inheritable process handle survives job closure.
        unsafe {
            assert_eq!(
                WaitForSingleObject(broker.as_raw_handle(), 10_000),
                WAIT_OBJECT_0
            );
        }
        drop(file);
        std::fs::remove_dir_all(base).expect("cleanup");
    }
}

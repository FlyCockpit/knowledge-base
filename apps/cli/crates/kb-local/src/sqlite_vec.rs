//! The sole SQLite extension registration boundary. Static symbols
//! only; SQLite loadable extensions remain disabled on every connection.
#![allow(unsafe_code)] // One audited static entrypoint; crate remains deny.
use crate::StoreError;
use rusqlite::{Connection, ffi};
pub(crate) fn register() -> Result<(), StoreError> {
    // SAFETY: sqlite-vec 0.1.9 exports sqlite3_vec_init with the SQLite
    // extension-init ABI (sqlite3*, char**, sqlite3_api_routines* -> int).
    // Its Rust declaration erases that signature. This cast restores exactly
    // that ABI; the statically linked function outlives all connections.
    // SQLite serializes/idempotently registers auto extensions. The same
    // bundled SQLite library supplies its API table; no foreign handle enters.
    let rc = unsafe {
        ffi::sqlite3_auto_extension(Some(std::mem::transmute::<
            unsafe extern "C" fn(),
            unsafe extern "C" fn(
                *mut ffi::sqlite3,
                *mut *mut std::ffi::c_char,
                *const ffi::sqlite3_api_routines,
            ) -> std::ffi::c_int,
        >(sqlite_vec::sqlite3_vec_init)))
    };
    if rc != ffi::SQLITE_OK {
        return Err(StoreError::IndexUnavailable);
    }
    Ok(())
}
pub(crate) fn verify(c: &Connection) -> Result<(), StoreError> {
    let version: String = c.query_row("SELECT vec_version()", [], |r| r.get(0))?;
    if version != "v0.1.9" {
        return Err(StoreError::IndexUnavailable);
    }
    Ok(())
}

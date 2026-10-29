//! Thin wasm-bindgen wrapper around vodozemac for Winkey SOC-3 E2EE.
//!
//! Provides minimal necessary bindings:
//! - Account (Curve25519 identity, Ed25519 signing, One-Time Keys)
//! - Session (Olm Double Ratchet 1-1 outbound/inbound, encrypt/decrypt)
//! - GroupSession (Megolm outbound sender keys)
//! - InboundGroupSession (Megolm inbound group ratchet)
//! - Pickle/unpickle with 32-byte cryptographic keys

mod account;
mod group_session;
mod inbound_group_session;
mod pickle;
mod session;

#[cfg(test)]
mod tests;

pub use account::Account;
pub use group_session::GroupSession;
pub use inbound_group_session::InboundGroupSession;
pub use session::Session;

use wasm_bindgen::prelude::*;

/// Initializer for WASM environment (panic hook and logging)
#[wasm_bindgen(start)]
pub fn init_panic_hook() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

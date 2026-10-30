use wasm_bindgen::prelude::*;

/// Parses a 32-byte pickle key from a JavaScript Uint8Array or slice.
pub fn parse_pickle_key(key: &[u8]) -> Result<[u8; 32], JsValue> {
    if key.len() != 32 {
        return Err(JsValue::from_str(
            "Pickle key must be exactly 32 bytes (256 bits)",
        ));
    }
    let mut arr = [0u8; 32];
    arr.copy_from_slice(key);
    Ok(arr)
}

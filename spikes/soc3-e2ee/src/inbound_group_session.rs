use crate::pickle::parse_pickle_key;
use serde::Serialize;
use wasm_bindgen::prelude::*;
use zeroize::Zeroize;

#[derive(Serialize)]
pub struct DecryptedGroupMessageDto {
    pub plaintext: Vec<u8>,
    pub message_index: u32,
}

#[wasm_bindgen]
pub struct InboundGroupSession {
    inner: vodozemac::megolm::InboundGroupSession,
}

#[wasm_bindgen]
impl InboundGroupSession {
    #[wasm_bindgen(constructor)]
    pub fn new(session_key: &str) -> Result<InboundGroupSession, JsValue> {
        let key = vodozemac::megolm::GroupSessionKey::from_base64(session_key)
            .map_err(|e| JsValue::from_str(&format!("Invalid group session key: {e}")))?;
        let session = vodozemac::megolm::InboundGroupSession::new(&key);
        Ok(InboundGroupSession { inner: session })
    }

    #[wasm_bindgen(js_name = sessionId)]
    pub fn session_id(&self) -> String {
        self.inner.session_id()
    }

    #[wasm_bindgen(js_name = firstKnownIndex)]
    pub fn first_known_index(&self) -> u32 {
        self.inner.first_known_index()
    }

    pub fn decrypt(&mut self, ciphertext: &str) -> Result<String, JsValue> {
        let msg = vodozemac::megolm::MegolmMessage::from_base64(ciphertext)
            .map_err(|e| JsValue::from_str(&format!("Invalid Megolm ciphertext: {e}")))?;

        let decrypted = self
            .inner
            .decrypt(&msg)
            .map_err(|e| JsValue::from_str(&format!("Decryption failed: {e}")))?;

        let dto = DecryptedGroupMessageDto {
            plaintext: decrypted.plaintext,
            message_index: decrypted.message_index,
        };

        serde_json::to_string(&dto).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    pub fn pickle(&self, pickle_key: &[u8]) -> Result<String, JsValue> {
        let mut key_arr = parse_pickle_key(pickle_key)?;
        let pickle = self.inner.pickle().encrypt(&key_arr);
        key_arr.zeroize();
        Ok(pickle)
    }

    #[wasm_bindgen(js_name = fromPickle)]
    pub fn from_pickle(pickle: &str, pickle_key: &[u8]) -> Result<InboundGroupSession, JsValue> {
        let mut key_arr = parse_pickle_key(pickle_key)?;
        let encrypted_pickle =
            vodozemac::megolm::InboundGroupSessionPickle::from_encrypted(pickle, &key_arr)
                .map_err(|e| JsValue::from_str(&format!("Bad pickle or incorrect key: {e}")))?;
        key_arr.zeroize();

        let session = vodozemac::megolm::InboundGroupSession::from_pickle(encrypted_pickle);
        Ok(InboundGroupSession { inner: session })
    }
}

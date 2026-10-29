use crate::pickle::parse_pickle_key;
use wasm_bindgen::prelude::*;
use zeroize::Zeroize;

#[wasm_bindgen]
pub struct GroupSession {
    inner: vodozemac::megolm::GroupSession,
}

#[wasm_bindgen]
impl GroupSession {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: vodozemac::megolm::GroupSession::new(),
        }
    }

    #[wasm_bindgen(js_name = sessionId)]
    pub fn session_id(&self) -> String {
        self.inner.session_id()
    }

    #[wasm_bindgen(js_name = sessionKey)]
    pub fn session_key(&self) -> String {
        self.inner.session_key().to_base64()
    }

    #[wasm_bindgen(js_name = messageIndex)]
    pub fn message_index(&self) -> u32 {
        self.inner.message_index()
    }

    pub fn encrypt(&mut self, plaintext: &[u8]) -> String {
        let msg = self.inner.encrypt(plaintext);
        msg.to_base64()
    }

    pub fn pickle(&self, pickle_key: &[u8]) -> Result<String, JsValue> {
        let mut key_arr = parse_pickle_key(pickle_key)?;
        let pickle = self.inner.pickle().encrypt(&key_arr);
        key_arr.zeroize();
        Ok(pickle)
    }

    #[wasm_bindgen(js_name = fromPickle)]
    pub fn from_pickle(pickle: &str, pickle_key: &[u8]) -> Result<GroupSession, JsValue> {
        let mut key_arr = parse_pickle_key(pickle_key)?;
        let encrypted_pickle =
            vodozemac::megolm::GroupSessionPickle::from_encrypted(pickle, &key_arr)
                .map_err(|e| JsValue::from_str(&format!("Bad pickle or incorrect key: {e}")))?;
        key_arr.zeroize();

        let session = vodozemac::megolm::GroupSession::from_pickle(encrypted_pickle);
        Ok(GroupSession { inner: session })
    }
}

use crate::pickle::parse_pickle_key;
use serde::Serialize;
use wasm_bindgen::prelude::*;
use zeroize::Zeroize;

#[derive(Serialize)]
struct OlmMessageDto {
    #[serde(rename = "type")]
    msg_type: usize,
    body: String,
}

#[wasm_bindgen]
pub struct Session {
    inner: vodozemac::olm::Session,
}

impl Session {
    pub(crate) fn from_inner(session: vodozemac::olm::Session) -> Self {
        Self { inner: session }
    }
}

#[wasm_bindgen]
impl Session {
    #[wasm_bindgen(js_name = sessionId)]
    pub fn session_id(&self) -> String {
        self.inner.session_id()
    }

    pub fn encrypt(&mut self, plaintext: &[u8]) -> Result<String, JsValue> {
        let msg = self.inner.encrypt(plaintext);
        let (msg_type, body_bytes) = msg.to_parts();
        let dto = OlmMessageDto {
            msg_type: msg_type as usize,
            body: String::from_utf8_lossy(&body_bytes).to_string(),
        };
        serde_json::to_string(&dto).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    pub fn decrypt(&mut self, message_type: usize, ciphertext: &str) -> Result<Vec<u8>, JsValue> {
        let olm_msg = match message_type {
            0 => vodozemac::olm::OlmMessage::from_parts(0, ciphertext.as_bytes())
                .map_err(|e| JsValue::from_str(&format!("Invalid PreKey message: {e}")))?,
            1 => vodozemac::olm::OlmMessage::from_parts(1, ciphertext.as_bytes())
                .map_err(|e| JsValue::from_str(&format!("Invalid Normal message: {e}")))?,
            _ => return Err(JsValue::from_str("Invalid Olm message type (must be 0 or 1)")),
        };

        let plaintext = self
            .inner
            .decrypt(&olm_msg)
            .map_err(|e| JsValue::from_str(&format!("Decryption failed: {e}")))?;

        Ok(plaintext)
    }

    pub fn pickle(&self, pickle_key: &[u8]) -> Result<String, JsValue> {
        let mut key_arr = parse_pickle_key(pickle_key)?;
        let pickle = self.inner.pickle().encrypt(&key_arr);
        key_arr.zeroize();
        Ok(pickle)
    }

    #[wasm_bindgen(js_name = fromPickle)]
    pub fn from_pickle(pickle: &str, pickle_key: &[u8]) -> Result<Session, JsValue> {
        let mut key_arr = parse_pickle_key(pickle_key)?;
        let encrypted_pickle = vodozemac::olm::SessionPickle::from_encrypted(pickle, &key_arr)
            .map_err(|e| JsValue::from_str(&format!("Bad pickle or incorrect key: {e}")))?;
        key_arr.zeroize();

        let session = vodozemac::olm::Session::from_pickle(encrypted_pickle);
        Ok(Session { inner: session })
    }
}

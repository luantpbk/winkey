use crate::pickle::parse_pickle_key;
use wasm_bindgen::prelude::*;
use zeroize::Zeroize;

#[wasm_bindgen]
pub struct Session {
    inner: vodozemac::olm::Session,
    initial_plaintext: Option<Vec<u8>>,
    initial_ciphertext: Option<String>,
}

impl Session {
    pub(crate) fn from_inner(session: vodozemac::olm::Session) -> Self {
        Self {
            inner: session,
            initial_plaintext: None,
            initial_ciphertext: None,
        }
    }

    pub(crate) fn from_inbound(
        session: vodozemac::olm::Session,
        plaintext: Vec<u8>,
        ciphertext: String,
    ) -> Self {
        Self {
            inner: session,
            initial_plaintext: Some(plaintext),
            initial_ciphertext: Some(ciphertext),
        }
    }
}

#[wasm_bindgen]
impl Session {
    #[wasm_bindgen(js_name = sessionId)]
    pub fn session_id(&self) -> String {
        self.inner.session_id()
    }

    pub fn encrypt(&mut self, plaintext: &str) -> Result<String, JsValue> {
        let msg = self
            .inner
            .encrypt(plaintext.as_bytes())
            .map_err(|e| JsValue::from_str(&format!("Encryption failed: {e}")))?;
        serde_json::to_string(&msg).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    pub fn decrypt(&mut self, message_type: usize, ciphertext: &str) -> Result<Vec<u8>, JsValue> {
        if message_type == 0 {
            if let Some(ref init_c) = self.initial_ciphertext {
                if init_c == ciphertext {
                    if let Some(ref init_p) = self.initial_plaintext {
                        return Ok(init_p.clone());
                    }
                }
            }
        }

        let json = serde_json::json!({
            "type": message_type,
            "body": ciphertext,
        });
        let olm_msg: vodozemac::olm::OlmMessage = serde_json::from_value(json)
            .map_err(|e| JsValue::from_str(&format!("Invalid Olm message: {e}")))?;

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
        Ok(Session {
            inner: session,
            initial_plaintext: None,
            initial_ciphertext: None,
        })
    }
}

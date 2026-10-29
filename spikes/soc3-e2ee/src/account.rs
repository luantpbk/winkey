use crate::pickle::parse_pickle_key;
use crate::session::Session;
use serde::Serialize;
use wasm_bindgen::prelude::*;
use zeroize::Zeroize;

#[derive(Serialize)]
struct IdentityKeysDto {
    curve25519: String,
    ed25519: String,
}

#[wasm_bindgen]
pub struct Account {
    inner: vodozemac::olm::Account,
}

#[wasm_bindgen]
impl Account {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        Self {
            inner: vodozemac::olm::Account::new(),
        }
    }

    #[wasm_bindgen(js_name = identityKeys)]
    pub fn identity_keys(&self) -> Result<String, JsValue> {
        let keys = self.inner.identity_keys();
        let dto = IdentityKeysDto {
            curve25519: keys.curve25519.to_base64(),
            ed25519: keys.ed25519.to_base64(),
        };
        serde_json::to_string(&dto).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen(js_name = curve25519Key)]
    pub fn curve25519_key(&self) -> String {
        self.inner.identity_keys().curve25519.to_base64()
    }

    #[wasm_bindgen(js_name = ed25519Key)]
    pub fn ed25519_key(&self) -> String {
        self.inner.identity_keys().ed25519.to_base64()
    }

    #[wasm_bindgen(js_name = generateOneTimeKeys)]
    pub fn generate_one_time_keys(&mut self, count: usize) {
        self.inner.generate_one_time_keys(count);
    }

    #[wasm_bindgen(js_name = oneTimeKeys)]
    pub fn one_time_keys(&self) -> Result<String, JsValue> {
        let otks = self.inner.one_time_keys();
        let map: std::collections::BTreeMap<String, String> = otks
            .into_iter()
            .map(|(key_id, key)| (key_id.to_string(), key.to_base64()))
            .collect();
        serde_json::to_string(&map).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen(js_name = markKeysAsPublished)]
    pub fn mark_keys_as_published(&mut self) {
        self.inner.mark_keys_as_published();
    }

    #[wasm_bindgen(js_name = createOutboundSession)]
    pub fn create_outbound_session(
        &self,
        their_identity_key: &str,
        their_one_time_key: &str,
    ) -> Result<Session, JsValue> {
        let id_key = vodozemac::Curve25519PublicKey::from_base64(their_identity_key)
            .map_err(|e| JsValue::from_str(&format!("Invalid identity key: {e}")))?;
        let otk = vodozemac::Curve25519PublicKey::from_base64(their_one_time_key)
            .map_err(|e| JsValue::from_str(&format!("Invalid one-time key: {e}")))?;

        let session = self.inner.create_outbound_session(id_key, otk);
        Ok(Session::from_inner(session))
    }

    #[wasm_bindgen(js_name = createInboundSession)]
    pub fn create_inbound_session(
        &mut self,
        their_identity_key: &str,
        message_type: usize,
        ciphertext: &str,
    ) -> Result<Session, JsValue> {
        let id_key = vodozemac::Curve25519PublicKey::from_base64(their_identity_key)
            .map_err(|e| JsValue::from_str(&format!("Invalid identity key: {e}")))?;

        let olm_msg = match message_type {
            0 => vodozemac::olm::OlmMessage::from_parts(0, ciphertext.as_bytes())
                .map_err(|e| JsValue::from_str(&format!("Invalid PreKey message: {e}")))?,
            1 => vodozemac::olm::OlmMessage::from_parts(1, ciphertext.as_bytes())
                .map_err(|e| JsValue::from_str(&format!("Invalid Normal message: {e}")))?,
            _ => return Err(JsValue::from_str("Invalid Olm message type (must be 0 or 1)")),
        };

        let result = self
            .inner
            .create_inbound_session(id_key, &olm_msg)
            .map_err(|e| JsValue::from_str(&format!("Failed to create inbound session: {e}")))?;

        Ok(Session::from_inner(result.session))
    }

    pub fn pickle(&self, pickle_key: &[u8]) -> Result<String, JsValue> {
        let mut key_arr = parse_pickle_key(pickle_key)?;
        let pickle = self.inner.pickle().encrypt(&key_arr);
        key_arr.zeroize();
        Ok(pickle)
    }

    #[wasm_bindgen(js_name = fromPickle)]
    pub fn from_pickle(pickle: &str, pickle_key: &[u8]) -> Result<Account, JsValue> {
        let mut key_arr = parse_pickle_key(pickle_key)?;
        let encrypted_pickle = vodozemac::olm::AccountPickle::from_encrypted(pickle, &key_arr)
            .map_err(|e| JsValue::from_str(&format!("Bad pickle or incorrect key: {e}")))?;
        key_arr.zeroize();

        let account = vodozemac::olm::Account::from_pickle(encrypted_pickle);
        Ok(Account { inner: account })
    }
}

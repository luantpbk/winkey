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

#[derive(Serialize)]
struct OneTimeKeysDto {
    curve25519: std::collections::BTreeMap<String, String>,
}

#[derive(Serialize)]
struct FallbackKeyDto {
    key_id: String,
    key: String,
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
            .map(|(key_id, key)| (key_id.to_base64(), key.to_base64()))
            .collect();
        let dto = OneTimeKeysDto { curve25519: map };
        serde_json::to_string(&dto).map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen(js_name = markKeysAsPublished)]
    pub fn mark_keys_as_published(&mut self) {
        self.inner.mark_keys_as_published();
    }

    #[wasm_bindgen]
    pub fn sign(&self, message: &str) -> String {
        self.inner.sign(message.as_bytes()).to_base64()
    }

    #[wasm_bindgen(js_name = generateFallbackKey)]
    pub fn generate_fallback_key(&mut self) {
        self.inner.generate_fallback_key();
    }

    #[wasm_bindgen(js_name = fallbackKey)]
    pub fn fallback_key(&self) -> Result<String, JsValue> {
        let map = self.inner.fallback_key();
        if let Some((key_id, key)) = map.into_iter().next() {
            let dto = FallbackKeyDto {
                key_id: key_id.to_base64(),
                key: key.to_base64(),
            };
            serde_json::to_string(&dto).map_err(|e| JsValue::from_str(&e.to_string()))
        } else {
            Ok("null".to_string())
        }
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

        let session = self
            .inner
            .create_outbound_session(vodozemac::olm::SessionConfig::version_1(), id_key, otk)
            .map_err(|e| JsValue::from_str(&format!("Failed to create outbound session: {e}")))?;
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

        let json = serde_json::json!({
            "type": message_type,
            "body": ciphertext,
        });
        let olm_msg: vodozemac::olm::OlmMessage = serde_json::from_value(json)
            .map_err(|e| JsValue::from_str(&format!("Invalid Olm message: {e}")))?;

        let prekey_msg = match olm_msg {
            vodozemac::olm::OlmMessage::PreKey(pk) => pk,
            _ => return Err(JsValue::from_str("createInboundSession requires a PreKey message")),
        };

        let result = self
            .inner
            .create_inbound_session(vodozemac::olm::SessionConfig::version_1(), id_key, &prekey_msg)
            .map_err(|e| JsValue::from_str(&format!("Failed to create inbound session: {e}")))?;

        Ok(Session::from_inbound(
            result.session,
            result.plaintext,
            ciphertext.to_string(),
        ))
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

#[wasm_bindgen(js_name = verifyEd25519Signature)]
pub fn verify_ed25519_signature(public_key: &str, message: &str, signature: &str) -> Result<bool, JsValue> {
    let pk = vodozemac::Ed25519PublicKey::from_base64(public_key)
        .map_err(|e| JsValue::from_str(&format!("Invalid ed25519 public key: {e}")))?;
    let sig = vodozemac::Ed25519Signature::from_base64(signature)
        .map_err(|e| JsValue::from_str(&format!("Invalid signature: {e}")))?;
    Ok(pk.verify(message.as_bytes(), &sig).is_ok())
}

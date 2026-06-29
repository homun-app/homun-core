use rand::RngCore;
use sha2::{Digest, Sha256};

const DEFAULT_PIN_ITERATIONS: u32 = 120_000;
const SALT_LEN: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct LocalPinVerifier {
    pub algorithm: String,
    pub iterations: u32,
    pub salt_hex: String,
    pub digest_hex: String,
}

impl LocalPinVerifier {
    pub fn create(pin: &str) -> Result<Self, String> {
        validate_pin(pin)?;
        let mut salt = [0_u8; SALT_LEN];
        rand::rngs::OsRng.fill_bytes(&mut salt);
        let digest = derive_pin_digest(pin.as_bytes(), &salt, DEFAULT_PIN_ITERATIONS);
        Ok(Self {
            algorithm: "sha256-iterated".to_string(),
            iterations: DEFAULT_PIN_ITERATIONS,
            salt_hex: hex_encode(&salt),
            digest_hex: hex_encode(&digest),
        })
    }

    pub fn verify(&self, pin: &str) -> bool {
        if validate_pin(pin).is_err() || self.algorithm != "sha256-iterated" {
            return false;
        }
        let Ok(salt) = hex_decode(&self.salt_hex) else {
            return false;
        };
        let Ok(expected) = hex_decode(&self.digest_hex) else {
            return false;
        };
        let digest = derive_pin_digest(pin.as_bytes(), &salt, self.iterations);
        constant_time_eq(&digest, &expected)
    }
}

pub fn validate_pin(pin: &str) -> Result<(), String> {
    let trimmed = pin.trim();
    if trimmed.len() < 6 || trimmed.len() > 12 {
        return Err("PIN must be 6-12 digits".to_string());
    }
    if !trimmed.chars().all(|c| c.is_ascii_digit()) {
        return Err("PIN must contain only digits".to_string());
    }
    Ok(())
}

fn derive_pin_digest(pin: &[u8], salt: &[u8], iterations: u32) -> [u8; 32] {
    let mut state = Sha256::new();
    state.update(salt);
    state.update(pin);
    let mut digest: [u8; 32] = state.finalize().into();
    for _ in 1..iterations {
        let mut next = Sha256::new();
        next.update(digest);
        next.update(salt);
        next.update(pin);
        digest = next.finalize().into();
    }
    digest
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    if left.len() != right.len() {
        return false;
    }
    let mut diff = 0_u8;
    for (a, b) in left.iter().zip(right.iter()) {
        diff |= a ^ b;
    }
    diff == 0
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
}

fn hex_decode(value: &str) -> Result<Vec<u8>, String> {
    if value.len() % 2 != 0 {
        return Err("invalid hex length".to_string());
    }
    let mut bytes = Vec::with_capacity(value.len() / 2);
    let chars: Vec<_> = value.as_bytes().to_vec();
    for pair in chars.chunks(2) {
        let high = hex_nibble(pair[0])?;
        let low = hex_nibble(pair[1])?;
        bytes.push((high << 4) | low);
    }
    Ok(bytes)
}

fn hex_nibble(byte: u8) -> Result<u8, String> {
    match byte {
        b'0'..=b'9' => Ok(byte - b'0'),
        b'a'..=b'f' => Ok(byte - b'a' + 10),
        b'A'..=b'F' => Ok(byte - b'A' + 10),
        _ => Err("invalid hex digit".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_pin_verifier_accepts_only_the_original_pin() {
        let verifier = LocalPinVerifier::create("123456").expect("pin verifier");

        assert!(verifier.verify("123456"));
        assert!(!verifier.verify("654321"));
    }

    #[test]
    fn local_pin_verifier_does_not_serialize_plaintext_pin() {
        let verifier = LocalPinVerifier::create("123456").expect("pin verifier");
        let serialized = serde_json::to_string(&verifier).expect("json");

        assert!(!serialized.contains("123456"));
        assert!(serialized.contains("sha256-iterated"));
    }

    #[test]
    fn local_pin_rejects_short_or_non_numeric_values() {
        assert!(LocalPinVerifier::create("12345").is_err());
        assert!(LocalPinVerifier::create("12345a").is_err());
    }
}

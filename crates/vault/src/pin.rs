use argon2::{Algorithm, Argon2, Params, Version};
use rand::RngCore;

/// Argon2id is memory-hard: unlike an iterated SHA-256 hash (cheap and highly
/// parallel on a GPU/ASIC), it forces the attacker to allocate a large working
/// set per guess. A 6–12 digit PIN has a tiny keyspace, so if the vault DB is
/// stolen the ONLY thing standing between the attacker and the master key is the
/// per-guess cost — memory-hardness is what makes an offline brute force
/// expensive instead of trivial. Params follow the OWASP desktop baseline.
const ARGON2_MEM_KIB: u32 = 19_456; // 19 MiB working set per guess
const ARGON2_TIME_COST: u32 = 2; // passes over memory
const ARGON2_PARALLELISM: u32 = 1; // lanes
const ARGON2_OUTPUT_LEN: usize = 32;
const PIN_KDF_ALGORITHM: &str = "argon2id";
const SALT_LEN: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct LocalPinVerifier {
    pub algorithm: String,
    // Argon2 params are stored on the verifier so `verify` (and `pin_wrap_key`)
    // re-derive with exactly the params `create` used. Keeping them here — rather
    // than hardcoding — means a future params bump stays verifiable against
    // records written under the old cost.
    pub mem_kib: u32,
    pub time_cost: u32,
    pub parallelism: u32,
    pub salt_hex: String,
    pub digest_hex: String,
}

impl LocalPinVerifier {
    pub fn create(pin: &str) -> Result<Self, String> {
        validate_pin(pin)?;
        let mut salt = [0_u8; SALT_LEN];
        rand::rngs::OsRng.fill_bytes(&mut salt);
        let digest = derive_pin_digest(
            pin.as_bytes(),
            &salt,
            ARGON2_MEM_KIB,
            ARGON2_TIME_COST,
            ARGON2_PARALLELISM,
        )?;
        Ok(Self {
            algorithm: PIN_KDF_ALGORITHM.to_string(),
            mem_kib: ARGON2_MEM_KIB,
            time_cost: ARGON2_TIME_COST,
            parallelism: ARGON2_PARALLELISM,
            salt_hex: hex_encode(&salt),
            digest_hex: hex_encode(&digest),
        })
    }

    pub fn verify(&self, pin: &str) -> bool {
        if validate_pin(pin).is_err() || self.algorithm != PIN_KDF_ALGORITHM {
            return false;
        }
        let Ok(salt) = hex_decode(&self.salt_hex) else {
            return false;
        };
        let Ok(expected) = hex_decode(&self.digest_hex) else {
            return false;
        };
        // Re-derive with the params stored on the verifier, never hardcoded ones.
        let Ok(digest) = derive_pin_digest(
            pin.as_bytes(),
            &salt,
            self.mem_kib,
            self.time_cost,
            self.parallelism,
        ) else {
            return false;
        };
        constant_time_eq(&digest, &expected)
    }
}

/// Argon2id derivation over `(salt, input)` producing a raw 32-byte key/digest.
/// Uses the low-level `hash_password_into` (not the PHC-string helper): the
/// caller already owns an explicit salt and wants raw key bytes, not an encoded
/// hash string. Shared by the PIN verifier and the master-key pin-wrap so both
/// use identical cost parameters.
pub(crate) fn derive_pin_digest(
    input: &[u8],
    salt: &[u8],
    mem_kib: u32,
    time_cost: u32,
    parallelism: u32,
) -> Result<[u8; ARGON2_OUTPUT_LEN], String> {
    let params = Params::new(mem_kib, time_cost, parallelism, Some(ARGON2_OUTPUT_LEN))
        .map_err(|error| format!("invalid argon2 params: {error}"))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0_u8; ARGON2_OUTPUT_LEN];
    argon
        .hash_password_into(input, salt, &mut out)
        .map_err(|error| format!("argon2 derivation failed: {error}"))?;
    Ok(out)
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
        assert!(serialized.contains("argon2id"));
    }

    #[test]
    fn local_pin_rejects_short_or_non_numeric_values() {
        assert!(LocalPinVerifier::create("12345").is_err());
        assert!(LocalPinVerifier::create("12345a").is_err());
    }
}

//! Thin wrappers for loading PEM-encoded TLS certificates and private keys.
//!
//! Centralizes the `rustls_pki_types` PEM parsing API so future library
//! changes (e.g. a future rustls bump that reshapes `PemObject`) touch
//! a single file instead of every TLS loading site.
//!
//! Replaces direct usage of the now-unmaintained `rustls-pemfile` crate
//! (RUSTSEC-2025-0134). The new API has three meaningful improvements:
//!
//! 1. **Errors propagate**: the old `rustls_pemfile::certs(...).filter_map(|r| r.ok())`
//!    pattern silently dropped malformed certificates. Here a corrupt file
//!    surfaces as an error with the file path attached.
//!
//! 2. **One call replaces fs::read + parse**: `pem_file_iter` and
//!    `from_pem_file` open and parse in a single operation.
//!
//! 3. **Trait-based API**: `PemObject` is generic, so adding CRL or
//!    public-key loading later is a one-liner with the same surface.

use std::path::Path;

use anyhow::{Context, Result};
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, PrivateKeyDer};

/// Load a PEM-encoded certificate chain from disk.
///
/// Returns the certificates in the order they appear in the file
/// (leaf first, intermediates after, per the standard cert chain
/// convention rustls expects). Empty files and files containing no
/// certificates produce an empty vector — the caller must check.
///
/// # Errors
/// - File cannot be opened (permissions, missing path)
/// - File contains malformed PEM blocks (the previous `rustls-pemfile`
///   wrapper silently dropped these — this implementation surfaces them)
pub fn load_cert_chain(path: &Path) -> Result<Vec<CertificateDer<'static>>> {
    CertificateDer::pem_file_iter(path)
        .with_context(|| format!("Failed to open TLS cert file: {}", path.display()))?
        .collect::<Result<Vec<_>, _>>()
        .with_context(|| format!("Failed to parse TLS cert file: {}", path.display()))
}

/// Load a PEM-encoded private key from disk.
///
/// Accepts PKCS#1, PKCS#8, and SEC1 encodings — the same set supported
/// by rustls' `with_single_cert()` when paired with the `aws-lc-rs` or
/// `ring` crypto providers.
///
/// # Errors
/// - File cannot be opened (permissions, missing path)
/// - File contains no private key, or contains a key in an unsupported format
pub fn load_private_key(path: &Path) -> Result<PrivateKeyDer<'static>> {
    PrivateKeyDer::from_pem_file(path)
        .with_context(|| format!("Failed to load TLS private key: {}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    /// Helper that generates a self-signed cert + key into a temp dir
    /// using the same `rcgen` path the production code uses.
    fn write_self_signed(dir: &Path) -> (std::path::PathBuf, std::path::PathBuf) {
        use rcgen::{CertificateParams, KeyPair};

        let key_pair = KeyPair::generate().expect("rcgen keypair");
        let params = CertificateParams::new(vec!["localhost".to_string()]).expect("rcgen params");
        let cert = params.self_signed(&key_pair).expect("rcgen self_signed");

        let cert_path = dir.join("cert.pem");
        let key_path = dir.join("key.pem");
        std::fs::write(&cert_path, cert.pem()).unwrap();
        std::fs::write(&key_path, key_pair.serialize_pem()).unwrap();
        (cert_path, key_path)
    }

    #[test]
    fn load_cert_chain_round_trip() {
        let dir = TempDir::new().unwrap();
        let (cert_path, _key_path) = write_self_signed(dir.path());

        let certs = load_cert_chain(&cert_path).expect("load chain");
        assert_eq!(certs.len(), 1, "self-signed cert should produce one entry");
    }

    #[test]
    fn load_private_key_round_trip() {
        let dir = TempDir::new().unwrap();
        let (_cert_path, key_path) = write_self_signed(dir.path());

        let _key = load_private_key(&key_path).expect("load key");
        // PrivateKeyDer is opaque — `_key` cannot be compared structurally,
        // but rustls itself rejects malformed keys at use time. The fact
        // that loading succeeded is the meaningful assertion here.
    }

    #[test]
    fn load_cert_chain_missing_file_error_includes_path() {
        let err = load_cert_chain(Path::new("/nonexistent/cert.pem"))
            .expect_err("missing file must error");
        let msg = format!("{err:#}");
        assert!(
            msg.contains("/nonexistent/cert.pem"),
            "error message must include the path for debuggability: {msg}"
        );
    }

    #[test]
    fn load_private_key_missing_file_error_includes_path() {
        let err = load_private_key(Path::new("/nonexistent/key.pem"))
            .expect_err("missing file must error");
        let msg = format!("{err:#}");
        assert!(
            msg.contains("/nonexistent/key.pem"),
            "error message must include the path for debuggability: {msg}"
        );
    }

    /// Regression test for the silent-failure bug in the old API.
    ///
    /// `rustls_pemfile::certs(...).filter_map(|r| r.ok())` used to drop
    /// malformed PEM blocks without complaint. The new wrapper must
    /// propagate the error so misconfigurations surface immediately.
    #[test]
    fn load_cert_chain_corrupted_file_errors() {
        let dir = TempDir::new().unwrap();
        let bad_path = dir.path().join("bad.pem");
        std::fs::write(
            &bad_path,
            "-----BEGIN CERTIFICATE-----\nnot valid base64!\n-----END CERTIFICATE-----\n",
        )
        .unwrap();

        let result = load_cert_chain(&bad_path);
        assert!(
            result.is_err(),
            "corrupted PEM must error, not silently return empty"
        );
    }
}

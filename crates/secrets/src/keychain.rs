use crate::{SecretError, SecretMaterial, SecretMetadata, SecretRef, SecretResult, SecretStore};
use std::process::Command;

pub struct SystemKeychainSecretStore {
    service: String,
}

impl SystemKeychainSecretStore {
    pub fn new(service: impl Into<String>) -> Self {
        Self {
            service: service.into(),
        }
    }

    pub fn service(&self) -> &str {
        &self.service
    }

    pub fn account_for(&self, reference: &SecretRef) -> String {
        reference.as_str().to_string()
    }
}

impl SecretStore for SystemKeychainSecretStore {
    fn put(&self, reference: SecretRef, material: SecretMaterial) -> SecretResult<SecretMetadata> {
        put_system_secret(self.service(), &self.account_for(&reference), material)?;
        Ok(SecretMetadata::new(reference))
    }

    fn get(&self, reference: &SecretRef) -> SecretResult<Option<SecretMaterial>> {
        get_system_secret(self.service(), &self.account_for(reference))
    }

    fn delete(&self, reference: &SecretRef) -> SecretResult<()> {
        delete_system_secret(self.service(), &self.account_for(reference))
    }

    fn metadata(&self, reference: &SecretRef) -> SecretResult<Option<SecretMetadata>> {
        Ok(self
            .get(reference)?
            .map(|_| SecretMetadata::new(reference.clone())))
    }
}

#[cfg(target_os = "macos")]
fn put_system_secret(service: &str, account: &str, material: SecretMaterial) -> SecretResult<()> {
    let password = material.expose_utf8()?;
    let status = Command::new("security")
        .args([
            "add-generic-password",
            "-a",
            account,
            "-s",
            service,
            "-w",
            &password,
            "-U",
        ])
        .status()?;
    if status.success() {
        Ok(())
    } else {
        Err(SecretError::Unsupported(format!(
            "security add-generic-password exited with {status}"
        )))
    }
}

#[cfg(not(target_os = "macos"))]
fn put_system_secret(_service: &str, _account: &str, _material: SecretMaterial) -> SecretResult<()> {
    Err(SecretError::Unsupported(
        "system keychain backend is not implemented for this platform".to_string(),
    ))
}

#[cfg(target_os = "macos")]
fn get_system_secret(service: &str, account: &str) -> SecretResult<Option<SecretMaterial>> {
    let output = Command::new("security")
        .args(["find-generic-password", "-w", "-a", account, "-s", service])
        .output()?;
    if output.status.success() {
        let mut password = String::from_utf8(output.stdout)?;
        while password.ends_with('\n') || password.ends_with('\r') {
            password.pop();
        }
        Ok(Some(SecretMaterial::from_string(password)))
    } else {
        Ok(None)
    }
}

#[cfg(not(target_os = "macos"))]
fn get_system_secret(_service: &str, _account: &str) -> SecretResult<Option<SecretMaterial>> {
    Err(SecretError::Unsupported(
        "system keychain backend is not implemented for this platform".to_string(),
    ))
}

#[cfg(target_os = "macos")]
fn delete_system_secret(service: &str, account: &str) -> SecretResult<()> {
    let _ = Command::new("security")
        .args(["delete-generic-password", "-a", account, "-s", service])
        .status()?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
fn delete_system_secret(_service: &str, _account: &str) -> SecretResult<()> {
    Err(SecretError::Unsupported(
        "system keychain backend is not implemented for this platform".to_string(),
    ))
}

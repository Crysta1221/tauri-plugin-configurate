/// OS keyring integration via the `keyring` crate.
///
/// Each entry is stored with:
///   - service  = `opts.service`          (e.g. "my-app")
///   - user     = `{account}/{id}`        (e.g. "default/api-key")
///
/// `/` is used as the separator (not `:`) because Windows Credential Manager
/// builds the target name as `{user}.{service}`, and `:` in that string can
/// be misinterpreted by some OS keyring backends.
use crate::error::{Error, Result};
use crate::models::KeyringOptions;

/// Validates that a keyring `id` does not contain characters that would
/// interfere with the `{account}/{id}` user string format.
fn validate_id(id: &str) -> Result<()> {
    if id.is_empty() {
        return Err(Error::InvalidPayload(
            "keyring id must not be empty".to_string(),
        ));
    }
    if id.contains('/') {
        return Err(Error::InvalidPayload(format!(
            "keyring id '{}' must not contain '/' (it is used as a separator in the keyring user string)",
            id
        )));
    }
    Ok(())
}

fn validate_opts(opts: &KeyringOptions) -> Result<()> {
    if opts.service.trim().is_empty() {
        return Err(Error::InvalidPayload(
            "keyring service must not be empty".to_string(),
        ));
    }
    if opts.account.trim().is_empty() {
        return Err(Error::InvalidPayload(
            "keyring account must not be empty".to_string(),
        ));
    }
    if opts.service.chars().any(char::is_control) {
        return Err(Error::InvalidPayload(
            "keyring service must not contain control characters".to_string(),
        ));
    }
    if opts.account.chars().any(char::is_control) {
        return Err(Error::InvalidPayload(
            "keyring account must not contain control characters".to_string(),
        ));
    }
    Ok(())
}

/// Builds the OS keyring user string: `{account}/{id}`.
fn build_user(opts: &KeyringOptions, id: &str) -> String {
    format!("{}/{}", opts.account, id)
}

/// Stores `value` in the OS keyring.
/// service = `opts.service`, user = `{account}/{id}`.
/// If an existing entry exists it will be overwritten.
pub fn set(opts: &KeyringOptions, id: &str, value: &str) -> Result<()> {
    validate_opts(opts)?;
    validate_id(id)?;
    let user = build_user(opts, id);
    let entry = keyring::Entry::new(&opts.service, &user)?;
    entry.set_password(value)?;
    Ok(())
}

/// Retrieves the value from the OS keyring.
/// service = `opts.service`, user = `{account}/{id}`.
pub fn get(opts: &KeyringOptions, id: &str) -> Result<String> {
    validate_opts(opts)?;
    validate_id(id)?;
    let user = build_user(opts, id);
    let entry = keyring::Entry::new(&opts.service, &user)?;
    let password = entry.get_password()?;
    Ok(password)
}

/// Like `get`, but returns `Ok(None)` when the entry does not exist instead of an error.
/// Used for optional keyring fields.
pub fn get_optional(opts: &KeyringOptions, id: &str) -> Result<Option<String>> {
    validate_opts(opts)?;
    validate_id(id)?;
    let user = build_user(opts, id);
    let entry = keyring::Entry::new(&opts.service, &user)?;
    match entry.get_password() {
        Ok(pwd) => Ok(Some(pwd)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}

/// Deletes the entry from the OS keyring.
/// Returns `Ok(())` even when the entry does not exist.
pub fn delete(opts: &KeyringOptions, id: &str) -> Result<()> {
    validate_opts(opts)?;
    validate_id(id)?;
    let user = build_user(opts, id);
    let entry = keyring::Entry::new(&opts.service, &user)?;
    match entry.delete_credential() {
        Ok(_) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.into()),
    }
}

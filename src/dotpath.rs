/// Utilities for traversing and mutating `serde_json::Value` via dot-separated paths.
/// Example path: `"database.password"` refers to `value["database"]["password"]`.
use crate::error::{Error, Result};
use serde_json::Value;

/// Sets the value at the given dot-separated `path` inside `root` to `new_val`.
/// Intermediate objects are created automatically if they are missing.
pub fn set(root: &mut Value, path: &str, new_val: Value) -> Result<()> {
    if path.is_empty() {
        return Err(Error::Dotpath("path must not be empty".to_string()));
    }

    let parts: Vec<&str> = path.split('.').collect();
    if parts.iter().any(|segment| segment.is_empty()) {
        return Err(Error::Dotpath(format!(
            "invalid path '{}': empty segment is not allowed",
            path
        )));
    }

    let mut current = root;

    for (i, part) in parts.iter().enumerate() {
        if i == parts.len() - 1 {
            match current {
                Value::Object(map) => {
                    map.insert((*part).to_string(), new_val);
                    return Ok(());
                }
                _ => {
                    return Err(Error::Dotpath(format!(
                        "expected object at segment '{}' of path '{}'",
                        part, path
                    )))
                }
            }
        } else {
            match current {
                Value::Object(map) => {
                    current = map
                        .entry((*part).to_string())
                        .or_insert_with(|| Value::Object(serde_json::Map::new()));
                }
                _ => {
                    return Err(Error::Dotpath(format!(
                        "expected object at segment '{}' of path '{}'",
                        part, path
                    )))
                }
            }
        }
    }

    // All non-empty paths with valid segments are handled inside the loop;
    // the final iteration always returns from the `i == parts.len() - 1` branch.
    unreachable!("path '{}' was not resolved inside loop", path)
}


/// Replaces the value at the given dot-separated `path` inside `root` with `null`.
pub fn nullify(root: &mut Value, path: &str) -> Result<()> {
    set(root, path, Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn set_simple_key() {
        let mut root = json!({});
        set(&mut root, "name", json!("Alice")).unwrap();
        assert_eq!(root["name"], "Alice");
    }

    #[test]
    fn set_nested_creates_intermediates() {
        let mut root = json!({});
        set(&mut root, "db.password", json!("secret")).unwrap();
        assert_eq!(root["db"]["password"], "secret");
    }

    #[test]
    fn set_overwrites_existing_value() {
        let mut root = json!({"count": 1});
        set(&mut root, "count", json!(2)).unwrap();
        assert_eq!(root["count"], 2);
    }

    #[test]
    fn set_empty_path_errors() {
        let mut root = json!({});
        assert!(set(&mut root, "", json!("x")).is_err());
    }

    #[test]
    fn set_double_dot_segment_errors() {
        let mut root = json!({});
        // "a..b" splits into ["a", "", "b"] — the empty segment is rejected
        assert!(set(&mut root, "a..b", json!("x")).is_err());
    }

    #[test]
    fn set_leading_dot_segment_errors() {
        let mut root = json!({});
        // ".a" splits into ["", "a"] — the empty leading segment is rejected
        assert!(set(&mut root, ".a", json!("x")).is_err());
    }

    #[test]
    fn set_non_object_intermediate_errors() {
        let mut root = json!({"db": "not-an-object"});
        assert!(set(&mut root, "db.password", json!("secret")).is_err());
    }

    #[test]
    fn nullify_sets_null() {
        let mut root = json!({"secret": "value"});
        nullify(&mut root, "secret").unwrap();
        assert_eq!(root["secret"], serde_json::Value::Null);
    }

    #[test]
    fn set_deeply_nested() {
        let mut root = json!({});
        set(&mut root, "a.b.c.d", json!(42)).unwrap();
        assert_eq!(root["a"]["b"]["c"]["d"], 42);
    }
}


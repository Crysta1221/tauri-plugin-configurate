/// Utilities for traversing and mutating `serde_json::Value` via dot-separated paths.
/// Example path: `"database.password"` refers to `value["database"]["password"]`.
use crate::error::{Error, Result};
use serde_json::Value;

/// Validates that a dot-separated `path` is non-empty and contains no empty segments
/// (i.e. no leading dots, trailing dots, or consecutive dots).
///
/// Returns an error for paths such as `""`, `".path"`, `"path."`, `"path..name"`.
pub fn validate_path(path: &str) -> Result<()> {
    if path.is_empty() {
        return Err(Error::Dotpath("path must not be empty".to_string()));
    }
    if path.split('.').any(|segment| segment.is_empty()) {
        return Err(Error::Dotpath(format!(
            "invalid path '{}': empty segment is not allowed",
            path
        )));
    }
    Ok(())
}

fn is_array_index_segment(segment: &str) -> bool {
    !segment.is_empty() && segment.chars().all(|ch| ch.is_ascii_digit())
}

fn parse_array_index(segment: &str, path: &str) -> Result<usize> {
    if !is_array_index_segment(segment) {
        return Err(Error::Dotpath(format!(
            "expected array index at segment '{}' of path '{}'",
            segment, path
        )));
    }
    segment.parse::<usize>().map_err(|_| {
        Error::Dotpath(format!(
            "invalid array index '{}' in path '{}'",
            segment, path
        ))
    })
}

/// Sets the value at the given dot-separated `path` inside `root` to `new_val`.
/// Intermediate objects/arrays are created automatically if they are missing.
pub fn set(root: &mut Value, path: &str, new_val: Value) -> Result<()> {
    validate_path(path)?;

    let parts: Vec<&str> = path.split('.').collect();
    let mut current = root;

    for (i, part) in parts.iter().enumerate() {
        let is_last = i == parts.len() - 1;
        let next_is_index = if is_last {
            false
        } else {
            is_array_index_segment(parts[i + 1])
        };

        match current {
            Value::Object(map) => {
                if is_last {
                    map.insert((*part).to_string(), new_val);
                    return Ok(());
                }
                current = map.entry((*part).to_string()).or_insert_with(|| {
                    if next_is_index {
                        Value::Array(Vec::new())
                    } else {
                        Value::Object(serde_json::Map::new())
                    }
                });
            }
            Value::Array(arr) => {
                let idx = parse_array_index(part, path)?;
                if idx >= arr.len() {
                    arr.resize_with(idx + 1, || Value::Null);
                }
                if is_last {
                    arr[idx] = new_val;
                    return Ok(());
                }
                if arr[idx].is_null() {
                    arr[idx] = if next_is_index {
                        Value::Array(Vec::new())
                    } else {
                        Value::Object(serde_json::Map::new())
                    };
                }
                match &mut arr[idx] {
                    Value::Object(_) | Value::Array(_) => {
                        current = &mut arr[idx];
                    }
                    _ => {
                        return Err(Error::Dotpath(format!(
                            "expected object or array at segment '{}' of path '{}'",
                            part, path
                        )))
                    }
                }
            }
            _ => {
                return Err(Error::Dotpath(format!(
                    "expected object or array at segment '{}' of path '{}'",
                    part, path
                )))
            }
        }
    }

    // All non-empty paths with valid segments are handled inside the loop;
    // the final iteration always returns from the `i == parts.len() - 1` branch.
    unreachable!("path '{}' was not resolved inside loop", path)
}

/// Returns a reference to the value at the given dot-separated `path` inside `root`.
/// Returns `None` if any segment is missing or if an intermediate node is not traversable.
pub fn get<'a>(root: &'a Value, path: &str) -> Option<&'a Value> {
    if validate_path(path).is_err() {
        return None;
    }

    let mut current = root;
    for part in path.split('.') {
        match current {
            Value::Object(map) => {
                current = map.get(part)?;
            }
            Value::Array(arr) => {
                if !is_array_index_segment(part) {
                    return None;
                }
                let idx = part.parse::<usize>().ok()?;
                current = arr.get(idx)?;
            }
            _ => return None,
        }
    }
    Some(current)
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
    fn set_nested_with_array_index_creates_intermediates() {
        let mut root = json!({});
        set(&mut root, "timetable.0.time", json!("08:30")).unwrap();
        assert_eq!(root["timetable"][0]["time"], "08:30");
    }

    #[test]
    fn set_overwrites_existing_value() {
        let mut root = json!({"count": 1});
        set(&mut root, "count", json!(2)).unwrap();
        assert_eq!(root["count"], 2);
    }

    #[test]
    fn set_array_index_overwrites_existing_value() {
        let mut root = json!({"timetable": [{"time": "08:30"}]});
        set(&mut root, "timetable.0.time", json!("09:00")).unwrap();
        assert_eq!(root["timetable"][0]["time"], "09:00");
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
    fn set_array_with_non_index_segment_errors() {
        let mut root = json!({"items": []});
        assert!(set(&mut root, "items.foo", json!(1)).is_err());
    }

    #[test]
    fn nullify_sets_null() {
        let mut root = json!({"secret": "value"});
        nullify(&mut root, "secret").unwrap();
        assert_eq!(root["secret"], serde_json::Value::Null);
    }

    #[test]
    fn nullify_array_index_sets_null() {
        let mut root = json!({"items": ["a", "b"]});
        nullify(&mut root, "items.1").unwrap();
        assert_eq!(root["items"][1], serde_json::Value::Null);
    }

    #[test]
    fn set_deeply_nested() {
        let mut root = json!({});
        set(&mut root, "a.b.c.d", json!(42)).unwrap();
        assert_eq!(root["a"]["b"]["c"]["d"], 42);
    }

    #[test]
    fn get_array_index_path() {
        let root = json!({"timetable": [{"time": "08:30"}]});
        assert_eq!(get(&root, "timetable.0.time"), root.pointer("/timetable/0/time"));
    }
}

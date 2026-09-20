//! Idempotent shell-profile block writer for PATH / ANDROID_HOME exports.

use std::fs;
use std::io;
use std::path::Path;

const BEGIN: &str = "# >>> epistl dev-setup >>>";
const END: &str = "# <<< epistl dev-setup <<<";

/// Ensure each non-empty line of `block_body` is present in the epistl
/// marker block in `profile_path`. Merges with any existing epistl block
/// (union by exact line) so node / moon / android exports accumulate
/// instead of last-writer-wins.
pub fn ensure_profile_block(profile_path: &Path, block_body: &str) -> io::Result<ProfileOutcome> {
    let incoming: Vec<&str> = block_body
        .lines()
        .map(str::trim_end)
        .filter(|l| !l.is_empty())
        .collect();

    let existing = if profile_path.exists() {
        fs::read_to_string(profile_path)?
    } else {
        String::new()
    };

    let prior_lines = extract_block_lines(&existing);
    let merged = merge_lines(prior_lines.as_deref().unwrap_or(&[]), &incoming);
    let new_body = merged.join("\n");
    let new_block = format!("{BEGIN}\n{new_body}\n{END}\n");

    let updated = match replace_block(&existing, &new_block) {
        Some(s) if s == existing => {
            return Ok(ProfileOutcome::AlreadyPresent);
        }
        Some(s) => s,
        None => {
            let mut s = existing;
            if !s.is_empty() && !s.ends_with('\n') {
                s.push('\n');
            }
            s.push('\n');
            s.push_str(&new_block);
            s
        }
    };

    if let Some(parent) = profile_path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(profile_path, updated)?;
    Ok(ProfileOutcome::Updated)
}

/// Lines currently inside the epistl marker block, if any.
fn extract_block_lines(existing: &str) -> Option<Vec<String>> {
    let start = existing.find(BEGIN)?;
    let end_rel = existing[start..].find(END)?;
    let body_start = start + BEGIN.len();
    let body_end = start + end_rel;
    let body = existing[body_start..body_end].trim_matches('\n');
    Some(
        body.lines()
            .map(str::trim_end)
            .filter(|l| !l.is_empty())
            .map(str::to_string)
            .collect(),
    )
}

/// Preserve existing order; append any incoming line not already present.
fn merge_lines(existing: &[String], incoming: &[&str]) -> Vec<String> {
    let mut out = existing.to_vec();
    for line in incoming {
        if !out.iter().any(|e| e == line) {
            out.push((*line).to_string());
        }
    }
    out
}

/// What `ensure_profile_block` did.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProfileOutcome {
    Updated,
    AlreadyPresent,
}

fn replace_block(existing: &str, new_block: &str) -> Option<String> {
    let start = existing.find(BEGIN)?;
    let end_rel = existing[start..].find(END)?;
    let end = start + end_rel + END.len();
    // Consume a trailing newline after END if present.
    let end = if existing[end..].starts_with('\n') {
        end + 1
    } else {
        end
    };
    let mut out = String::new();
    out.push_str(&existing[..start]);
    out.push_str(new_block);
    out.push_str(&existing[end..]);
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir {
        path: std::path::PathBuf,
    }

    impl TempDir {
        fn new(label: &str) -> Self {
            static COUNTER: AtomicU64 = AtomicU64::new(0);
            let nanos = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let n = COUNTER.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "dev-setup-profile-{label}-{}-{}-{nanos}",
                std::process::id(),
                n
            ));
            fs::create_dir_all(&path).unwrap();
            TempDir { path }
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }

    #[test]
    fn appends_block_to_empty_profile() {
        let dir = TempDir::new("empty");
        let profile = dir.path.join(".bashrc");
        let outcome = ensure_profile_block(&profile, "export FOO=1").unwrap();
        assert_eq!(outcome, ProfileOutcome::Updated);
        let contents = fs::read_to_string(&profile).unwrap();
        assert!(contents.contains(BEGIN));
        assert!(contents.contains("export FOO=1"));
        assert!(contents.contains(END));
    }

    #[test]
    fn merges_new_lines_without_dropping_existing() {
        let dir = TempDir::new("merge");
        let profile = dir.path.join(".bashrc");
        fs::write(
            &profile,
            format!("# top\n{BEGIN}\neval \"$(fnm env)\"\nexport PATH=\"$HOME/.local/bin:$PATH\"\n{END}\n# bottom\n"),
        )
        .unwrap();
        let outcome = ensure_profile_block(
            &profile,
            "export PATH=\"$HOME/.moon/bin:$HOME/.local/bin:$PATH\"",
        )
        .unwrap();
        assert_eq!(outcome, ProfileOutcome::Updated);
        let contents = fs::read_to_string(&profile).unwrap();
        assert!(contents.contains("eval \"$(fnm env)\""));
        assert!(contents.contains("export PATH=\"$HOME/.local/bin:$PATH\""));
        assert!(contents.contains("export PATH=\"$HOME/.moon/bin:$HOME/.local/bin:$PATH\""));
        assert!(contents.contains("# top"));
        assert!(contents.contains("# bottom"));
    }

    #[test]
    fn node_then_moon_lines_both_survive() {
        let dir = TempDir::new("node-moon");
        let profile = dir.path.join(".bashrc");
        ensure_profile_block(
            &profile,
            "eval \"$(fnm env)\"\nexport PATH=\"$HOME/.local/bin:$PATH\"",
        )
        .unwrap();
        ensure_profile_block(
            &profile,
            "export PATH=\"$HOME/.moon/bin:$HOME/.local/bin:$PATH\"",
        )
        .unwrap();
        let contents = fs::read_to_string(&profile).unwrap();
        assert!(contents.contains("eval \"$(fnm env)\""));
        assert!(contents.contains("export PATH=\"$HOME/.moon/bin:$HOME/.local/bin:$PATH\""));
        // Exactly one epistl block.
        assert_eq!(contents.matches(BEGIN).count(), 1);
    }

    #[test]
    fn already_present_when_identical() {
        let dir = TempDir::new("same");
        let profile = dir.path.join(".bashrc");
        let body = "export FOO=1";
        ensure_profile_block(&profile, body).unwrap();
        let outcome = ensure_profile_block(&profile, body).unwrap();
        assert_eq!(outcome, ProfileOutcome::AlreadyPresent);
    }
}

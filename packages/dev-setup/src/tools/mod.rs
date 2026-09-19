//! Shared outcome type and tool submodules.

pub mod android;
pub mod docker;
pub mod ios;
pub mod moon;
pub mod node;
pub mod npm;
pub mod rust;
pub mod sccache;

/// What happened when handling one tool.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ToolOutcome {
    /// Already present; nothing to do.
    Present(String),
    /// Detect-only mode reported absence.
    Absent(String),
    /// Successfully installed.
    Installed(String),
    /// Printed guidance only (cannot / chose not to auto-install).
    Guided(String),
    /// User declined the install prompt.
    Skipped(String),
    /// Install attempted and failed.
    Failed(String),
}

impl ToolOutcome {
    pub fn is_failure(&self) -> bool {
        matches!(self, ToolOutcome::Failed(_) | ToolOutcome::Absent(_))
    }

    /// Guided / skipped are non-fatal for optional tools.
    pub fn is_blocking_failure(&self, required: bool) -> bool {
        match self {
            ToolOutcome::Failed(_) => true,
            ToolOutcome::Absent(_) => required,
            ToolOutcome::Guided(_) => required,
            ToolOutcome::Skipped(_) => required,
            ToolOutcome::Present(_) | ToolOutcome::Installed(_) => false,
        }
    }

    pub fn message(&self) -> &str {
        match self {
            ToolOutcome::Present(m)
            | ToolOutcome::Absent(m)
            | ToolOutcome::Installed(m)
            | ToolOutcome::Guided(m)
            | ToolOutcome::Skipped(m)
            | ToolOutcome::Failed(m) => m,
        }
    }
}

/// Format a report line for stdout.
pub fn format_outcome(name: &str, outcome: &ToolOutcome) -> String {
    let tag = match outcome {
        ToolOutcome::Present(_) => "present",
        ToolOutcome::Absent(_) => "absent",
        ToolOutcome::Installed(_) => "installed",
        ToolOutcome::Guided(_) => "guide",
        ToolOutcome::Skipped(_) => "skipped",
        ToolOutcome::Failed(_) => "failed",
    };
    format!("{name}: [{tag}] {}", outcome.message())
}

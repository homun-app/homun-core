#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ShellRisk {
    ReadOnly,
    Write,
    NetworkOrInstall,
    Destructive,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShellCommandDecision {
    pub risk: ShellRisk,
    pub approval_required: bool,
    pub reason: String,
}

#[derive(Debug, Default, Clone)]
pub struct ShellCommandPolicy;

impl ShellCommandPolicy {
    pub fn classify(&self, command: &str) -> ShellCommandDecision {
        let normalized = command.trim().to_ascii_lowercase();
        let risk = if contains_any(
            &normalized,
            &["rm ", "rm\t", "rm -", "sudo ", "mkfs", "dd "],
        ) {
            ShellRisk::Destructive
        } else if contains_any(
            &normalized,
            &[
                "npm install",
                "pnpm install",
                "yarn add",
                "curl ",
                "wget ",
                "brew install",
            ],
        ) {
            ShellRisk::NetworkOrInstall
        } else if contains_any(
            &normalized,
            &[
                "touch ",
                "mkdir ",
                "mv ",
                "cp ",
                "sed -i",
                ">",
                "tee ",
                "git commit",
            ],
        ) {
            ShellRisk::Write
        } else {
            ShellRisk::ReadOnly
        };

        ShellCommandDecision {
            risk,
            approval_required: risk != ShellRisk::ReadOnly,
            reason: match risk {
                ShellRisk::ReadOnly => "read_only".to_string(),
                ShellRisk::Write => "filesystem_write".to_string(),
                ShellRisk::NetworkOrInstall => "network_or_install".to_string(),
                ShellRisk::Destructive => "destructive".to_string(),
            },
        }
    }
}

fn contains_any(value: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| value.contains(needle))
}

//! Gateway prompt packet composition.
//!
//! This owner assembles the engine prompt packets from core, workspace,
//! project, thread and runtime inputs. It does not own memory policy, plan
//! state, tool routing or the agent loop.

use crate::gateway_capability_routing::active_routing_binding;
use crate::gateway_project_files::project_root_for_thread;
use crate::{AppState, lock_store};
use local_first_engine::{PromptPacket, PromptPacketMetadata, PromptPacketSource};

pub(crate) const MAX_PROJECT_INSTRUCTION_CHARS: usize = 32 * 1024;

pub(crate) fn read_project_instruction(root: &std::path::Path, relative: &str) -> Option<String> {
    let root = root.canonicalize().ok()?;
    let path = root.join(relative).canonicalize().ok()?;
    if !path.starts_with(&root) || !path.is_file() {
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    Some(text.chars().take(MAX_PROJECT_INSTRUCTION_CHARS).collect())
}

pub(crate) fn compose_gateway_prompt_packets(
    state: &AppState,
    thread_id: Option<&str>,
    core: String,
    workspace: String,
    runtime: String,
) -> (String, Vec<PromptPacketMetadata>) {
    let mut packets = vec![PromptPacket {
        id: "homun-core".to_string(),
        source: PromptPacketSource::Core,
        priority: 10,
        content: core,
    }];
    if !workspace.trim().is_empty() {
        packets.push(PromptPacket {
            id: "workspace-context".to_string(),
            source: PromptPacketSource::Workspace,
            priority: 20,
            content: workspace,
        });
    }
    if let Some(root) = project_root_for_thread(state, thread_id) {
        for (id, relative, priority) in [
            ("project-agents", "AGENTS.md", 30),
            ("project-homun", ".homun/instructions.md", 31),
        ] {
            if let Some(content) = read_project_instruction(&root, relative) {
                packets.push(PromptPacket {
                    id: id.to_string(),
                    source: PromptPacketSource::Project,
                    priority,
                    content,
                });
            }
        }
    }
    if let Some(thread_id) = thread_id {
        let thread = lock_store(state)
            .ok()
            .and_then(|store| store.thread(thread_id).ok().flatten());
        let binding = active_routing_binding(state, Some(thread_id));
        let mut lines = Vec::new();
        if let Some(source) = thread.and_then(|thread| thread.source) {
            lines.push(format!(
                "THREAD PERIMETER: this conversation originates from the {source} channel; keep its configured contact and permission boundary."
            ));
        }
        if let Some(binding) = binding {
            lines.push(format!(
                "THREAD ROUTING: preserve the explicit plugin route {}/{} until the binding is removed.",
                binding.plugin_id, binding.route_id
            ));
        }
        if !lines.is_empty() {
            packets.push(PromptPacket {
                id: "thread-context".to_string(),
                source: PromptPacketSource::Thread,
                priority: 40,
                content: lines.join("\n"),
            });
        }
    }
    packets.push(PromptPacket {
        id: "runtime-control".to_string(),
        source: PromptPacketSource::Runtime,
        priority: 100,
        content: format!(
            "{}\n\nRUNTIME CONTROL: preserve verified plan progress, do not repeat an effect whose receipt is uncertain, and obey the currently offered tool surface.",
            runtime.trim()
        ),
    });
    local_first_engine::compose_prompt_packets(&packets)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_prompt_root() -> std::path::PathBuf {
        let root =
            std::env::temp_dir().join(format!("gateway-prompt-packets-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).expect("create temp prompt root");
        root
    }

    #[test]
    fn gateway_prompt_packets_read_project_instruction_truncates_large_files() {
        let root = temp_prompt_root();
        let body = "x".repeat(MAX_PROJECT_INSTRUCTION_CHARS + 128);
        std::fs::write(root.join("AGENTS.md"), body).expect("write project instruction");

        let result =
            read_project_instruction(&root, "AGENTS.md").expect("read project instruction");

        assert_eq!(result.chars().count(), MAX_PROJECT_INSTRUCTION_CHARS);
        std::fs::remove_dir_all(root).expect("cleanup temp prompt root");
    }

    #[test]
    fn gateway_prompt_packets_read_project_instruction_rejects_path_escape() {
        let root = temp_prompt_root();
        let outside = root
            .parent()
            .expect("temp root parent")
            .join(format!("outside-{}.md", uuid::Uuid::new_v4()));
        std::fs::write(&outside, "outside").expect("write outside file");

        let result = read_project_instruction(&root, "../outside.md");
        let result_exact = outside
            .file_name()
            .and_then(|name| name.to_str())
            .and_then(|name| read_project_instruction(&root, &format!("../{name}")));

        assert!(result.is_none());
        assert!(result_exact.is_none());
        let _ = std::fs::remove_file(outside);
        std::fs::remove_dir_all(root).expect("cleanup temp prompt root");
    }
}

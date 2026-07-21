use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PromptPacketSource {
    Core,
    Workspace,
    Project,
    Thread,
    Runtime,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PromptPacket {
    pub id: String,
    pub source: PromptPacketSource,
    pub priority: i32,
    pub content: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PromptPacketMetadata {
    pub id: String,
    pub source: PromptPacketSource,
    pub priority: i32,
    pub chars: usize,
    pub sha256: String,
}

pub fn compose_prompt_packets(packets: &[PromptPacket]) -> (String, Vec<PromptPacketMetadata>) {
    let mut ordered = packets.iter().enumerate().collect::<Vec<_>>();
    ordered.sort_by_key(|(ordinal, packet)| (packet.priority, *ordinal));
    let content = ordered
        .iter()
        .map(|(_, packet)| packet.content.trim())
        .filter(|content| !content.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    let metadata = ordered
        .into_iter()
        .filter(|(_, packet)| !packet.content.trim().is_empty())
        .map(|(_, packet)| PromptPacketMetadata {
            id: packet.id.clone(),
            source: packet.source,
            priority: packet.priority,
            chars: packet.content.chars().count(),
            sha256: format!("{:x}", Sha256::digest(packet.content.as_bytes())),
        })
        .collect();
    (content, metadata)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn prompt_packets_keep_stable_priority_and_insertion_order() {
        let packets = vec![
            PromptPacket {
                id: "b".into(),
                source: PromptPacketSource::Project,
                priority: 20,
                content: "B".into(),
            },
            PromptPacket {
                id: "a".into(),
                source: PromptPacketSource::Core,
                priority: 10,
                content: "A".into(),
            },
            PromptPacket {
                id: "c".into(),
                source: PromptPacketSource::Project,
                priority: 20,
                content: "C".into(),
            },
        ];
        let (content, metadata) = compose_prompt_packets(&packets);
        assert_eq!(content, "A\n\nB\n\nC");
        assert_eq!(
            metadata.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(),
            vec!["a", "b", "c"]
        );
    }

    #[test]
    fn layered_prompt_keeps_each_authority_source_inspectable() {
        let packets = vec![
            PromptPacket {
                id: "runtime".into(),
                source: PromptPacketSource::Runtime,
                priority: 100,
                content: "runtime".into(),
            },
            PromptPacket {
                id: "thread".into(),
                source: PromptPacketSource::Thread,
                priority: 40,
                content: "thread".into(),
            },
            PromptPacket {
                id: "workspace".into(),
                source: PromptPacketSource::Workspace,
                priority: 20,
                content: "workspace".into(),
            },
            PromptPacket {
                id: "project".into(),
                source: PromptPacketSource::Project,
                priority: 30,
                content: "project".into(),
            },
            PromptPacket {
                id: "core".into(),
                source: PromptPacketSource::Core,
                priority: 10,
                content: "core".into(),
            },
        ];

        let (content, metadata) = compose_prompt_packets(&packets);

        assert_eq!(content, "core\n\nworkspace\n\nproject\n\nthread\n\nruntime");
        assert_eq!(
            metadata
                .iter()
                .map(|packet| packet.source)
                .collect::<Vec<_>>(),
            vec![
                PromptPacketSource::Core,
                PromptPacketSource::Workspace,
                PromptPacketSource::Project,
                PromptPacketSource::Thread,
                PromptPacketSource::Runtime,
            ]
        );
        assert!(
            metadata
                .iter()
                .all(|packet| packet.chars > 0 && packet.sha256.len() == 64)
        );
    }
}

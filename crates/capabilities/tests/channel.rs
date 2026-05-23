use local_first_capabilities::{
    ChannelCapabilities, ChannelMessage, ChannelProvider, FakeChannelProvider,
    OutboundChannelMessage, ProviderId,
};

#[test]
fn channel_message_normalizes_sender_target_thread_and_content() {
    let message = ChannelMessage::new(
        ProviderId::new("telegram"),
        "msg_1",
        "alice",
        "chat_42",
        "ciao",
        1_779_523_200,
    )
    .in_thread(Some("thread_1".to_string()));

    assert_eq!(message.provider_id.as_str(), "telegram");
    assert_eq!(message.sender, "alice");
    assert_eq!(message.reply_target, "chat_42");
    assert_eq!(message.content, "ciao");
    assert_eq!(message.thread_id.as_deref(), Some("thread_1"));
}

#[test]
fn outbound_message_can_target_existing_thread() {
    let outbound = OutboundChannelMessage::new(ProviderId::new("discord"), "channel_1", "hello")
        .in_thread(Some("thread_9".to_string()));

    assert_eq!(outbound.provider_id.as_str(), "discord");
    assert_eq!(outbound.recipient, "channel_1");
    assert_eq!(outbound.thread_id.as_deref(), Some("thread_9"));
}

#[test]
fn fake_channel_provider_records_sent_messages() {
    let mut provider = FakeChannelProvider::new(
        ProviderId::new("telegram"),
        ChannelCapabilities {
            supports_reactions: true,
            supports_draft_updates: true,
            supports_typing: true,
        },
    );

    provider
        .send_message(&OutboundChannelMessage::new(
            ProviderId::new("telegram"),
            "chat_1",
            "working on it",
        ))
        .unwrap();
    provider.start_typing("chat_1").unwrap();
    provider.send_reaction("msg_1", "ok").unwrap();

    assert_eq!(provider.id().as_str(), "telegram");
    assert!(provider.health());
    assert_eq!(provider.sent_messages().len(), 1);
    assert_eq!(provider.sent_messages()[0].content, "working on it");
    assert_eq!(provider.typing_targets(), vec!["chat_1"]);
    assert_eq!(
        provider.reactions(),
        vec![("msg_1".to_string(), "ok".to_string())]
    );
}

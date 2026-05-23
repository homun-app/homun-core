use local_first_process_manager::{LogBuffer, LogStream};

#[test]
fn log_buffer_keeps_only_latest_lines_per_capacity() {
    let mut logs = LogBuffer::new(2);

    logs.push(LogStream::Stdout, "one");
    logs.push(LogStream::Stderr, "two");
    logs.push(LogStream::Stdout, "three");

    let entries = logs.entries();
    assert_eq!(entries.len(), 2);
    assert_eq!(entries[0].line, "two");
    assert_eq!(entries[0].stream, LogStream::Stderr);
    assert_eq!(entries[1].line, "three");
}

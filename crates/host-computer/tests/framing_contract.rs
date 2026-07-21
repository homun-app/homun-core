use local_first_host_computer::framing::{
    MAX_FRAME_BYTES, read_frame, read_json_frame, write_frame,
};
use local_first_host_computer::protocol::{HostComputerErrorCode, RpcRequest};
use tokio::io::{AsyncWriteExt, duplex};

#[tokio::test]
async fn fragmented_header_and_body_are_reassembled() {
    let payload = br#"{"jsonrpc":"2.0"}"#;
    let (mut writer, mut reader) = duplex(64);
    let length = (payload.len() as u32).to_be_bytes();

    let sender = tokio::spawn(async move {
        for byte in length {
            writer.write_all(&[byte]).await.unwrap();
        }
        for chunk in payload.chunks(3) {
            writer.write_all(chunk).await.unwrap();
        }
    });

    assert_eq!(read_frame(&mut reader).await.unwrap(), payload);
    sender.await.unwrap();
}

#[tokio::test]
async fn consecutive_frames_remain_separate() {
    let (mut writer, mut reader) = duplex(128);
    let sender = tokio::spawn(async move {
        write_frame(&mut writer, b"one").await.unwrap();
        write_frame(&mut writer, b"two").await.unwrap();
    });

    assert_eq!(read_frame(&mut reader).await.unwrap(), b"one");
    assert_eq!(read_frame(&mut reader).await.unwrap(), b"two");
    sender.await.unwrap();
}

#[tokio::test]
async fn zero_length_frame_is_invalid() {
    let error = read_frame(&mut [0_u8; 4].as_slice()).await.unwrap_err();
    assert_eq!(error.code(), HostComputerErrorCode::InvalidRequest);
}

#[tokio::test]
async fn oversized_frame_is_rejected_before_allocation() {
    let bytes = ((MAX_FRAME_BYTES + 1) as u32).to_be_bytes();
    let error = read_frame(&mut bytes.as_slice()).await.unwrap_err();
    assert_eq!(error.code(), HostComputerErrorCode::PayloadTooLarge);
}

#[tokio::test]
async fn invalid_json_is_a_typed_invalid_request() {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&(4_u32).to_be_bytes());
    bytes.extend_from_slice(b"nope");

    let error = read_json_frame::<_, RpcRequest>(&mut bytes.as_slice())
        .await
        .unwrap_err();
    assert_eq!(error.code(), HostComputerErrorCode::InvalidRequest);
}

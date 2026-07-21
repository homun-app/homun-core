use serde::{Serialize, de::DeserializeOwned};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::protocol::HostComputerErrorCode;

pub const MAX_FRAME_BYTES: usize = 8 * 1024 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum FramingError {
    #[error("frame I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("frame must contain at least one byte")]
    Empty,
    #[error("frame size {actual} exceeds maximum {maximum}")]
    TooLarge { actual: usize, maximum: usize },
    #[error("frame JSON is invalid: {0}")]
    InvalidJson(#[from] serde_json::Error),
}

impl FramingError {
    pub fn code(&self) -> HostComputerErrorCode {
        match self {
            Self::TooLarge { .. } => HostComputerErrorCode::PayloadTooLarge,
            Self::Io(_) | Self::Empty | Self::InvalidJson(_) => {
                HostComputerErrorCode::InvalidRequest
            }
        }
    }
}

pub async fn read_frame<R>(reader: &mut R) -> Result<Vec<u8>, FramingError>
where
    R: AsyncRead + Unpin,
{
    let length = reader.read_u32().await? as usize;
    if length == 0 {
        return Err(FramingError::Empty);
    }
    if length > MAX_FRAME_BYTES {
        return Err(FramingError::TooLarge {
            actual: length,
            maximum: MAX_FRAME_BYTES,
        });
    }

    let mut body = vec![0; length];
    reader.read_exact(&mut body).await?;
    Ok(body)
}

pub async fn write_frame<W>(writer: &mut W, payload: &[u8]) -> Result<(), FramingError>
where
    W: AsyncWrite + Unpin,
{
    if payload.is_empty() {
        return Err(FramingError::Empty);
    }
    if payload.len() > MAX_FRAME_BYTES {
        return Err(FramingError::TooLarge {
            actual: payload.len(),
            maximum: MAX_FRAME_BYTES,
        });
    }

    writer.write_u32(payload.len() as u32).await?;
    writer.write_all(payload).await?;
    writer.flush().await?;
    Ok(())
}

pub async fn read_json_frame<R, T>(reader: &mut R) -> Result<T, FramingError>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let body = read_frame(reader).await?;
    Ok(serde_json::from_slice(&body)?)
}

pub async fn write_json_frame<W, T>(writer: &mut W, value: &T) -> Result<(), FramingError>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    write_frame(writer, &serde_json::to_vec(value)?).await
}

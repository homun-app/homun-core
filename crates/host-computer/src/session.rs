use std::collections::HashMap;

use rand::{RngCore, rngs::OsRng};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;

use crate::policy::ActionCategory;

pub const APPROVAL_TTL_MS: i64 = 5 * 60 * 1_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HostSessionPhase {
    Observing,
    AwaitingApproval,
    Acting,
    PausedByUser,
    Suspended,
    Done,
    Failed,
    Cancelled,
}

impl HostSessionPhase {
    fn is_terminal(self) -> bool {
        matches!(self, Self::Done | Self::Failed | Self::Cancelled)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingHostApproval {
    pub category: ActionCategory,
    pub summary: String,
    pub action_digest: String,
    pub expires_at_unix_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HostSessionSnapshot {
    pub session_id: String,
    pub sequence: u64,
    pub generation: u64,
    pub phase: HostSessionPhase,
    pub app: String,
    pub pending_approval: Option<PendingHostApproval>,
    pub error_code: Option<String>,
    pub updated_at_unix_ms: i64,
}

#[derive(Debug, Clone)]
struct ApprovalGrant {
    action_digest: String,
    token_hash: [u8; 32],
    expires_at_unix_ms: i64,
}

#[derive(Debug, Clone)]
struct HostSession {
    snapshot: HostSessionSnapshot,
    approved: Option<ApprovalGrant>,
}

#[derive(Debug, Error, Clone, PartialEq, Eq)]
pub enum SessionError {
    #[error("session not found")]
    NotFound,
    #[error("session already exists")]
    AlreadyExists,
    #[error("another host-computer session is active")]
    ActiveSessionExists,
    #[error("session has terminated")]
    TerminalSession,
    #[error("no approval is pending")]
    NoPendingApproval,
    #[error("action digest does not match")]
    ActionDigestMismatch,
    #[error("approval has expired")]
    ApprovalExpired,
    #[error("session generation does not match")]
    GenerationMismatch,
    #[error("session is not paused")]
    NotPaused,
}

#[derive(Debug, Default)]
pub struct HostSessionCoordinator {
    sessions: HashMap<String, HostSession>,
    active_session_id: Option<String>,
}

impl HostSessionCoordinator {
    pub fn start(
        &mut self,
        session_id: impl Into<String>,
        app: impl Into<String>,
        now_unix_ms: i64,
    ) -> Result<HostSessionSnapshot, SessionError> {
        let session_id = session_id.into();
        if self.active_session_id.is_some() {
            return Err(SessionError::ActiveSessionExists);
        }
        if self.sessions.contains_key(&session_id) {
            return Err(SessionError::AlreadyExists);
        }
        let snapshot = HostSessionSnapshot {
            session_id: session_id.clone(),
            sequence: 1,
            generation: 1,
            phase: HostSessionPhase::Observing,
            app: app.into(),
            pending_approval: None,
            error_code: None,
            updated_at_unix_ms: now_unix_ms,
        };
        self.sessions.insert(
            session_id.clone(),
            HostSession {
                snapshot: snapshot.clone(),
                approved: None,
            },
        );
        self.active_session_id = Some(session_id);
        Ok(snapshot)
    }

    pub fn snapshot(&self, session_id: &str) -> Result<HostSessionSnapshot, SessionError> {
        self.sessions
            .get(session_id)
            .map(|session| session.snapshot.clone())
            .ok_or(SessionError::NotFound)
    }

    pub fn active_snapshot(&self) -> Option<HostSessionSnapshot> {
        self.active_session_id
            .as_deref()
            .and_then(|session_id| self.sessions.get(session_id))
            .map(|session| session.snapshot.clone())
    }

    pub fn request_approval(
        &mut self,
        session_id: &str,
        action_digest: impl Into<String>,
        category: ActionCategory,
        summary: impl Into<String>,
        now_unix_ms: i64,
    ) -> Result<HostSessionSnapshot, SessionError> {
        let session = self.session_mut(session_id)?;
        let action_digest = action_digest.into();
        session.approved = None;
        session.snapshot.phase = HostSessionPhase::AwaitingApproval;
        session.snapshot.pending_approval = Some(PendingHostApproval {
            category,
            summary: summary.into(),
            action_digest,
            expires_at_unix_ms: now_unix_ms + APPROVAL_TTL_MS,
        });
        touch(session, now_unix_ms);
        Ok(session.snapshot.clone())
    }

    pub fn approve(
        &mut self,
        session_id: &str,
        action_digest: &str,
        now_unix_ms: i64,
    ) -> Result<HostSessionSnapshot, SessionError> {
        let session = self.session_mut(session_id)?;
        let pending = session
            .snapshot
            .pending_approval
            .as_ref()
            .ok_or(SessionError::NoPendingApproval)?;
        if pending.action_digest != action_digest {
            return Err(SessionError::ActionDigestMismatch);
        }
        if now_unix_ms > pending.expires_at_unix_ms {
            return Err(SessionError::ApprovalExpired);
        }
        let mut token = [0_u8; 32];
        OsRng.fill_bytes(&mut token);
        let token_hash: [u8; 32] = Sha256::digest(token).into();
        session.approved = Some(ApprovalGrant {
            action_digest: action_digest.to_string(),
            token_hash,
            expires_at_unix_ms: pending.expires_at_unix_ms,
        });
        session.snapshot.pending_approval = None;
        session.snapshot.phase = HostSessionPhase::Observing;
        touch(session, now_unix_ms);
        Ok(session.snapshot.clone())
    }

    pub fn consume_approval(
        &mut self,
        session_id: &str,
        action_digest: &str,
        now_unix_ms: i64,
    ) -> Result<bool, SessionError> {
        let session = self.session_mut(session_id)?;
        let Some(grant) = session.approved.as_ref() else {
            return Ok(false);
        };
        if grant.action_digest != action_digest || now_unix_ms > grant.expires_at_unix_ms {
            return Ok(false);
        }
        // Reading the hash here is deliberate: only the hash is retained, while the
        // approval's authority is the exact digest + atomic one-time removal.
        let _retained_token_hash = grant.token_hash;
        session.approved = None;
        session.snapshot.phase = HostSessionPhase::Acting;
        touch(session, now_unix_ms);
        Ok(true)
    }

    pub fn deny(
        &mut self,
        session_id: &str,
        action_digest: &str,
        now_unix_ms: i64,
    ) -> Result<HostSessionSnapshot, SessionError> {
        {
            let session = self.session_mut(session_id)?;
            let pending = session
                .snapshot
                .pending_approval
                .as_ref()
                .ok_or(SessionError::NoPendingApproval)?;
            if pending.action_digest != action_digest {
                return Err(SessionError::ActionDigestMismatch);
            }
        }
        self.transition_terminal(
            session_id,
            HostSessionPhase::Failed,
            Some("approval_denied".into()),
            now_unix_ms,
        )
    }

    pub fn pause(
        &mut self,
        session_id: &str,
        now_unix_ms: i64,
    ) -> Result<HostSessionSnapshot, SessionError> {
        let session = self.session_mut(session_id)?;
        session.approved = None;
        session.snapshot.pending_approval = None;
        session.snapshot.phase = HostSessionPhase::PausedByUser;
        session.snapshot.generation += 1;
        touch(session, now_unix_ms);
        Ok(session.snapshot.clone())
    }

    pub fn resume(
        &mut self,
        session_id: &str,
        generation: u64,
        now_unix_ms: i64,
    ) -> Result<HostSessionSnapshot, SessionError> {
        let session = self.session_mut(session_id)?;
        if session.snapshot.phase != HostSessionPhase::PausedByUser {
            return Err(SessionError::NotPaused);
        }
        if session.snapshot.generation != generation {
            return Err(SessionError::GenerationMismatch);
        }
        session.snapshot.phase = HostSessionPhase::Observing;
        touch(session, now_unix_ms);
        Ok(session.snapshot.clone())
    }

    pub fn cancel(
        &mut self,
        session_id: &str,
        now_unix_ms: i64,
    ) -> Result<HostSessionSnapshot, SessionError> {
        self.transition_terminal(session_id, HostSessionPhase::Cancelled, None, now_unix_ms)
    }

    pub fn cancel_active(
        &mut self,
        now_unix_ms: i64,
    ) -> Result<Option<HostSessionSnapshot>, SessionError> {
        let Some(session_id) = self.active_session_id.clone() else {
            return Ok(None);
        };
        self.cancel(&session_id, now_unix_ms).map(Some)
    }

    pub fn done(
        &mut self,
        session_id: &str,
        now_unix_ms: i64,
    ) -> Result<HostSessionSnapshot, SessionError> {
        self.transition_terminal(session_id, HostSessionPhase::Done, None, now_unix_ms)
    }

    pub fn fail(
        &mut self,
        session_id: &str,
        error_code: impl Into<String>,
        now_unix_ms: i64,
    ) -> Result<HostSessionSnapshot, SessionError> {
        self.transition_terminal(
            session_id,
            HostSessionPhase::Failed,
            Some(error_code.into()),
            now_unix_ms,
        )
    }

    pub fn mark_observing(
        &mut self,
        session_id: &str,
        now_unix_ms: i64,
    ) -> Result<HostSessionSnapshot, SessionError> {
        let session = self.session_mut(session_id)?;
        session.snapshot.phase = HostSessionPhase::Observing;
        touch(session, now_unix_ms);
        Ok(session.snapshot.clone())
    }

    pub fn mark_observing_app(
        &mut self,
        session_id: &str,
        app: impl Into<String>,
        now_unix_ms: i64,
    ) -> Result<HostSessionSnapshot, SessionError> {
        let session = self.session_mut(session_id)?;
        session.snapshot.app = app.into();
        session.snapshot.phase = HostSessionPhase::Observing;
        touch(session, now_unix_ms);
        Ok(session.snapshot.clone())
    }

    fn transition_terminal(
        &mut self,
        session_id: &str,
        phase: HostSessionPhase,
        error_code: Option<String>,
        now_unix_ms: i64,
    ) -> Result<HostSessionSnapshot, SessionError> {
        let session = self.session_mut(session_id)?;
        session.approved = None;
        session.snapshot.pending_approval = None;
        session.snapshot.phase = phase;
        session.snapshot.error_code = error_code;
        touch(session, now_unix_ms);
        let snapshot = session.snapshot.clone();
        if self.active_session_id.as_deref() == Some(session_id) {
            self.active_session_id = None;
        }
        Ok(snapshot)
    }

    fn session_mut(&mut self, session_id: &str) -> Result<&mut HostSession, SessionError> {
        let session = self
            .sessions
            .get_mut(session_id)
            .ok_or(SessionError::NotFound)?;
        if session.snapshot.phase.is_terminal() {
            return Err(SessionError::TerminalSession);
        }
        Ok(session)
    }
}

fn touch(session: &mut HostSession, now_unix_ms: i64) {
    session.snapshot.sequence += 1;
    session.snapshot.updated_at_unix_ms = now_unix_ms;
}

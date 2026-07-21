use crate::{
    ApprovalState, ArtifactCreate, ArtifactRecord, ComputerEventCreate, ComputerEventRecord,
    ComputerSessionCreate, ComputerSessionRecord, ComputerSurfaceRecord, LocalComputerReadModel,
    LocalComputerSessionStore, SessionStatus, SurfaceKind, SurfaceStatus, TakeoverState,
};
use serde_json::json;
use time::OffsetDateTime;
use uuid::Uuid;

pub struct LocalComputerSessionManager {
    store: LocalComputerSessionStore,
}

impl LocalComputerSessionManager {
    pub fn new(store: LocalComputerSessionStore) -> Self {
        Self { store }
    }

    pub fn store(&self) -> &LocalComputerSessionStore {
        &self.store
    }

    pub fn read_model(&self) -> LocalComputerReadModel<'_> {
        LocalComputerReadModel::new(&self.store)
    }

    pub fn create_session(
        &self,
        create: ComputerSessionCreate,
    ) -> Result<ComputerSessionRecord, String> {
        let now = OffsetDateTime::now_utc();
        let session = ComputerSessionRecord {
            session_id: create.session_id,
            task_id: create.task_id,
            workflow_id: create.workflow_id,
            user_id: create.user_id,
            workspace_id: create.workspace_id,
            status: SessionStatus::Running,
            active_surface: SurfaceKind::Browser,
            surfaces: default_surfaces(now),
            title: create.title,
            subtitle: create.subtitle,
            progress_current: 0,
            progress_total: create.progress_total,
            approval_state: ApprovalState::None,
            takeover_state: TakeoverState::None,
            risk_level: create.risk_level,
            last_error: None,
            started_at: now,
            updated_at: now,
        };
        self.store.upsert_session(&session)?;
        self.append_event(ComputerEventCreate {
            session_id: session.session_id.clone(),
            surface: SurfaceKind::Logs,
            kind: "computer_session_started".to_string(),
            status: "done".to_string(),
            title: session.title.clone(),
            subtitle: session.subtitle.clone(),
            payload: json!({ "task_id": session.task_id }),
            artifact_refs: vec![],
            approval_required: false,
        })?;
        Ok(session)
    }

    pub fn start_surface(
        &self,
        session_id: &str,
        surface: SurfaceKind,
        label: &str,
    ) -> Result<(), String> {
        let mut session = self.require_session_by_id(session_id)?;
        session.active_surface = surface;
        session.status = SessionStatus::Running;
        session.updated_at = OffsetDateTime::now_utc();
        if let Some(record) = session
            .surfaces
            .iter_mut()
            .find(|record| record.surface == surface)
        {
            record.label = label.to_string();
            record.status = SurfaceStatus::Running;
            record.updated_at = session.updated_at;
        }
        self.store.upsert_session(&session)?;
        self.append_event(ComputerEventCreate {
            session_id: session.session_id,
            surface,
            kind: "computer_surface_started".to_string(),
            status: "running".to_string(),
            title: label.to_string(),
            subtitle: "Surface started".to_string(),
            payload: json!({}),
            artifact_refs: vec![],
            approval_required: false,
        })?;
        Ok(())
    }

    pub fn append_event(&self, create: ComputerEventCreate) -> Result<ComputerEventRecord, String> {
        let mut session = self.require_session_by_id(&create.session_id)?;
        session.progress_current = session
            .progress_current
            .saturating_add(u32::from(create.kind == "computer_action_completed"))
            .min(session.progress_total);
        session.updated_at = OffsetDateTime::now_utc();
        if create.approval_required {
            session.approval_state = ApprovalState::WaitingUser;
            session.status = SessionStatus::WaitingUser;
        }
        self.store.upsert_session(&session)?;

        let event = ComputerEventRecord {
            event_id: Uuid::new_v4().to_string(),
            session_id: create.session_id,
            user_id: session.user_id,
            workspace_id: session.workspace_id,
            surface: create.surface,
            kind: create.kind,
            status: create.status,
            title: create.title,
            subtitle: create.subtitle,
            payload: create.payload,
            artifact_refs: create.artifact_refs,
            approval_required: create.approval_required,
            created_at: OffsetDateTime::now_utc(),
        };
        self.store.append_event(&event)?;
        Ok(event)
    }

    pub fn append_terminal_output(
        &self,
        session_id: &str,
        user_id: &str,
        workspace_id: &str,
        output: &str,
    ) -> Result<ComputerEventRecord, String> {
        self.require_session(session_id, user_id, workspace_id)?;
        self.append_event(ComputerEventCreate {
            session_id: session_id.to_string(),
            surface: SurfaceKind::Shell,
            kind: "computer_terminal_output".to_string(),
            status: "done".to_string(),
            title: "Terminal output".to_string(),
            subtitle: "Redacted transcript available".to_string(),
            payload: json!({ "output": output }),
            artifact_refs: vec![],
            approval_required: false,
        })
    }

    pub fn create_artifact(&self, create: ArtifactCreate) -> Result<ArtifactRecord, String> {
        let session = self.require_session_by_id(&create.session_id)?;
        let artifact = ArtifactRecord {
            artifact_id: create.artifact_id,
            session_id: create.session_id.clone(),
            user_id: session.user_id,
            workspace_id: session.workspace_id,
            title: create.title,
            kind: create.kind,
            path_ref: create.path_ref,
            size_bytes: create.size_bytes,
            preview_ref: create.preview_ref,
            created_at: OffsetDateTime::now_utc(),
        };
        self.store.upsert_artifact(&artifact)?;
        self.append_event(ComputerEventCreate {
            session_id: create.session_id,
            surface: SurfaceKind::Files,
            kind: "computer_artifact_created".to_string(),
            status: "done".to_string(),
            title: artifact.title.clone(),
            subtitle: artifact.kind.clone(),
            payload: json!({ "artifact_id": artifact.artifact_id }),
            artifact_refs: vec![artifact.artifact_id.clone()],
            approval_required: false,
        })?;
        Ok(artifact)
    }

    pub fn request_takeover(
        &self,
        session_id: &str,
        user_id: &str,
        workspace_id: &str,
        reason: &str,
    ) -> Result<(), String> {
        self.store.update_takeover(
            session_id,
            user_id,
            workspace_id,
            TakeoverState::Requested,
            Some(reason.to_string()),
        )?;
        self.append_event(ComputerEventCreate {
            session_id: session_id.to_string(),
            surface: SurfaceKind::Browser,
            kind: "computer_takeover_requested".to_string(),
            status: "waiting".to_string(),
            title: "Takeover richiesto".to_string(),
            subtitle: reason.to_string(),
            payload: json!({ "reason": reason }),
            artifact_refs: vec![],
            approval_required: true,
        })?;
        Ok(())
    }

    pub fn pause_session(
        &self,
        session_id: &str,
        user_id: &str,
        workspace_id: &str,
        reason: &str,
    ) -> Result<(), String> {
        self.store.update_session_status(
            session_id,
            user_id,
            workspace_id,
            SessionStatus::Paused,
        )?;
        self.append_event(ComputerEventCreate {
            session_id: session_id.to_string(),
            surface: SurfaceKind::Logs,
            kind: "computer_session_paused".to_string(),
            status: "waiting".to_string(),
            title: "Sessione in pausa".to_string(),
            subtitle: reason.to_string(),
            payload: json!({ "reason": reason }),
            artifact_refs: vec![],
            approval_required: false,
        })?;
        Ok(())
    }

    pub fn resume_session(
        &self,
        session_id: &str,
        user_id: &str,
        workspace_id: &str,
    ) -> Result<(), String> {
        self.store.update_session_status(
            session_id,
            user_id,
            workspace_id,
            SessionStatus::Running,
        )?;
        self.append_event(ComputerEventCreate {
            session_id: session_id.to_string(),
            surface: SurfaceKind::Logs,
            kind: "computer_session_resumed".to_string(),
            status: "running".to_string(),
            title: "Sessione ripresa".to_string(),
            subtitle: "Controllo restituito al runtime locale".to_string(),
            payload: json!({}),
            artifact_refs: vec![],
            approval_required: false,
        })?;
        Ok(())
    }

    pub fn request_approval(
        &self,
        session_id: &str,
        user_id: &str,
        workspace_id: &str,
        action: &str,
        explanation: &str,
    ) -> Result<(), String> {
        self.store.update_approval(
            session_id,
            user_id,
            workspace_id,
            ApprovalState::WaitingUser,
        )?;
        self.append_event(ComputerEventCreate {
            session_id: session_id.to_string(),
            surface: SurfaceKind::Logs,
            kind: "computer_waiting_approval".to_string(),
            status: "waiting".to_string(),
            title: action.to_string(),
            subtitle: explanation.to_string(),
            payload: json!({ "action": action, "explanation": explanation }),
            artifact_refs: vec![],
            approval_required: true,
        })?;
        Ok(())
    }

    fn require_session_by_id(&self, session_id: &str) -> Result<ComputerSessionRecord, String> {
        let Some(session) = self.find_session_by_id(session_id)? else {
            return Err(format!("session not found: {session_id}"));
        };
        Ok(session)
    }

    fn require_session(
        &self,
        session_id: &str,
        user_id: &str,
        workspace_id: &str,
    ) -> Result<ComputerSessionRecord, String> {
        self.store
            .session(session_id, user_id, workspace_id)?
            .ok_or_else(|| format!("session not found: {session_id}"))
    }

    fn find_session_by_id(
        &self,
        session_id: &str,
    ) -> Result<Option<ComputerSessionRecord>, String> {
        self.store.session_by_id(session_id)
    }
}

fn default_surfaces(now: OffsetDateTime) -> Vec<ComputerSurfaceRecord> {
    [
        (SurfaceKind::Browser, "Browser"),
        (SurfaceKind::Shell, "Terminale"),
        (SurfaceKind::Files, "File"),
        (SurfaceKind::Logs, "Log"),
        (SurfaceKind::HostApps, "Mac Apps"),
    ]
    .into_iter()
    .map(|(surface, label)| ComputerSurfaceRecord {
        surface,
        label: label.to_string(),
        status: SurfaceStatus::Idle,
        detail: None,
        updated_at: now,
    })
    .collect()
}

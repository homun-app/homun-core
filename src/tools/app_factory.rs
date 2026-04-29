//! Agent tools for creating and operating generated internal apps.

use std::path::PathBuf;

use anyhow::{anyhow, Result};
use async_trait::async_trait;
use serde_json::{json, Value};

use super::registry::{get_string_param, Tool, ToolContext, ToolResult};
use crate::app_factory::blueprint::{AppBlueprint, FieldDefinition, FieldType};
use crate::app_factory::{bridge::BridgePolicy, db as app_db, runtime, validation};
use crate::storage::Database;

#[derive(Clone)]
struct AppFactoryCore {
    db: Database,
    data_dir: PathBuf,
}

impl AppFactoryCore {
    fn new(db: Database, data_dir: PathBuf) -> Self {
        Self { db, data_dir }
    }

    fn require_user_id<'a>(&self, ctx: &'a ToolContext) -> Result<&'a str, ToolResult> {
        ctx.user_id
            .as_deref()
            .filter(|user_id| !user_id.trim().is_empty())
            .ok_or_else(|| ToolResult::error("Missing user_id in tool context"))
    }

    async fn load_app(
        &self,
        user_id: &str,
        slug: &str,
    ) -> Result<(app_db::InternalAppRow, AppBlueprint), ToolResult> {
        let Some(row) = app_db::load_app_for_user(self.db.pool(), user_id, slug)
            .await
            .map_err(|e| ToolResult::error(format!("Failed to load internal app: {e}")))?
        else {
            return Err(ToolResult::error(format!("Internal app not found: {slug}")));
        };
        let blueprint = serde_json::from_str::<AppBlueprint>(&row.blueprint_json)
            .map_err(|e| ToolResult::error(format!("Stored app blueprint is invalid: {e}")))?;
        validation::validate_blueprint(&blueprint).map_err(|report| {
            ToolResult::error(format!(
                "Stored app blueprint is invalid: {}",
                report.errors.join(" | ")
            ))
        })?;
        Ok((row, blueprint))
    }

    async fn open_app_pool(
        &self,
        app: &app_db::InternalAppRow,
    ) -> Result<sqlx::SqlitePool, ToolResult> {
        app_db::open_app_pool(std::path::Path::new(&app.db_path))
            .await
            .map_err(|e| ToolResult::error(format!("Failed to open app database: {e}")))
    }
}

pub struct CreateInternalAppTool {
    core: AppFactoryCore,
}

impl CreateInternalAppTool {
    pub fn new(db: Database, data_dir: PathBuf) -> Self {
        Self {
            core: AppFactoryCore::new(db, data_dir),
        }
    }
}

pub struct ListInternalAppsTool {
    core: AppFactoryCore,
}

impl ListInternalAppsTool {
    pub fn new(db: Database, data_dir: PathBuf) -> Self {
        Self {
            core: AppFactoryCore::new(db, data_dir),
        }
    }
}

pub struct UpdateInternalAppTool {
    core: AppFactoryCore,
}

impl UpdateInternalAppTool {
    pub fn new(db: Database, data_dir: PathBuf) -> Self {
        Self {
            core: AppFactoryCore::new(db, data_dir),
        }
    }
}

pub struct ConfigureAppCapabilitiesTool {
    core: AppFactoryCore,
}

impl ConfigureAppCapabilitiesTool {
    pub fn new(db: Database, data_dir: PathBuf) -> Self {
        Self {
            core: AppFactoryCore::new(db, data_dir),
        }
    }
}

pub struct AddAppFieldTool {
    core: AppFactoryCore,
}

impl AddAppFieldTool {
    pub fn new(db: Database, data_dir: PathBuf) -> Self {
        Self {
            core: AppFactoryCore::new(db, data_dir),
        }
    }
}

pub struct CreateAppRecordTool {
    core: AppFactoryCore,
}

impl CreateAppRecordTool {
    pub fn new(db: Database, data_dir: PathBuf) -> Self {
        Self {
            core: AppFactoryCore::new(db, data_dir),
        }
    }
}

pub struct QueryAppRecordsTool {
    core: AppFactoryCore,
}

impl QueryAppRecordsTool {
    pub fn new(db: Database, data_dir: PathBuf) -> Self {
        Self {
            core: AppFactoryCore::new(db, data_dir),
        }
    }
}

pub struct RunAppActionTool {
    core: AppFactoryCore,
}

impl RunAppActionTool {
    pub fn new(db: Database, data_dir: PathBuf) -> Self {
        Self {
            core: AppFactoryCore::new(db, data_dir),
        }
    }
}

pub fn app_factory_tools(db: Database, data_dir: PathBuf) -> Vec<Box<dyn Tool>> {
    vec![
        Box::new(CreateInternalAppTool::new(db.clone(), data_dir.clone())),
        Box::new(ListInternalAppsTool::new(db.clone(), data_dir.clone())),
        Box::new(UpdateInternalAppTool::new(db.clone(), data_dir.clone())),
        Box::new(ConfigureAppCapabilitiesTool::new(
            db.clone(),
            data_dir.clone(),
        )),
        Box::new(AddAppFieldTool::new(db.clone(), data_dir.clone())),
        Box::new(CreateAppRecordTool::new(db.clone(), data_dir.clone())),
        Box::new(QueryAppRecordsTool::new(db.clone(), data_dir.clone())),
        Box::new(RunAppActionTool::new(db, data_dir)),
    ]
}

#[async_trait]
impl Tool for CreateInternalAppTool {
    fn name(&self) -> &str {
        "create_internal_app"
    }

    fn description(&self) -> &str {
        "Create an internal app from a validated blueprint. Use when the user wants Homun to generate a reusable internal app with isolated storage."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "blueprint": {
                    "type": "object",
                    "description": "Internal app blueprint JSON following the App Factory schema"
                }
            },
            "required": ["blueprint"]
        })
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<ToolResult> {
        let user_id = match self.core.require_user_id(ctx) {
            Ok(user_id) => user_id,
            Err(result) => return Ok(result),
        };
        let Some(raw_blueprint) = args.get("blueprint") else {
            return Ok(ToolResult::error("Missing required parameter: blueprint"));
        };
        let blueprint = match serde_json::from_value::<AppBlueprint>(raw_blueprint.clone()) {
            Ok(blueprint) => blueprint,
            Err(e) => return Ok(ToolResult::error(format!("Invalid blueprint JSON: {e}"))),
        };
        if let Err(report) = validation::validate_blueprint(&blueprint) {
            return Ok(ToolResult::error(format!(
                "Invalid blueprint: {}",
                report.errors.join(" | ")
            )));
        }

        let id = match app_db::insert_app(
            self.core.db.pool(),
            &self.core.data_dir,
            user_id,
            ctx.profile_id,
            &blueprint,
        )
        .await
        {
            Ok(id) => id,
            Err(e) => {
                return Ok(ToolResult::error(format!(
                    "Failed to create internal app: {e}"
                )))
            }
        };

        Ok(ToolResult::success(format!(
            "Internal app created.\nid={id}\nslug={}\nname={}\nstorage=sqlite_per_app",
            blueprint.app.slug, blueprint.app.name
        )))
    }
}

#[async_trait]
impl Tool for ListInternalAppsTool {
    fn name(&self) -> &str {
        "list_internal_apps"
    }

    fn description(&self) -> &str {
        "List internal apps created from blueprints for the active user/profile. Use before creating records or running app actions."
    }

    fn parameters(&self) -> Value {
        json!({"type": "object", "properties": {}})
    }

    async fn execute(&self, _args: Value, ctx: &ToolContext) -> Result<ToolResult> {
        let user_id = match self.core.require_user_id(ctx) {
            Ok(user_id) => user_id,
            Err(result) => return Ok(result),
        };
        let rows =
            match app_db::list_apps_for_user(self.core.db.pool(), user_id, ctx.profile_id).await {
                Ok(rows) => rows,
                Err(e) => {
                    return Ok(ToolResult::error(format!(
                        "Failed to list internal apps: {e}"
                    )))
                }
            };
        let apps = rows
            .into_iter()
            .map(|row| {
                json!({
                    "id": row.id,
                    "slug": row.slug,
                    "name": row.name,
                    "description": row.description,
                    "profile_id": row.profile_id,
                    "status": row.status,
                    "storage_mode": row.storage_mode
                })
            })
            .collect::<Vec<_>>();
        Ok(ToolResult::success(serde_json::to_string_pretty(&apps)?))
    }
}

#[async_trait]
impl Tool for UpdateInternalAppTool {
    fn name(&self) -> &str {
        "update_internal_app"
    }

    fn description(&self) -> &str {
        "Update an existing internal app by replacing its validated blueprint and saving a new blueprint version. Use when the user asks to modify an app created by App Factory."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "app_slug": {"type": "string", "description": "Existing internal app slug"},
                "blueprint": {
                    "type": "object",
                    "description": "Complete updated App Factory blueprint. The app.slug must match app_slug."
                },
                "change_note": {
                    "type": "string",
                    "description": "Short human-readable summary of the requested change"
                }
            },
            "required": ["app_slug", "blueprint"]
        })
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<ToolResult> {
        let user_id = match self.core.require_user_id(ctx) {
            Ok(user_id) => user_id,
            Err(result) => return Ok(result),
        };
        let app_slug = get_string_param(&args, "app_slug")?;
        let change_note = args
            .get("change_note")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|note| !note.is_empty())
            .unwrap_or("Updated from chat");
        let Some(raw_blueprint) = args.get("blueprint") else {
            return Ok(ToolResult::error("Missing required parameter: blueprint"));
        };
        let blueprint = match serde_json::from_value::<AppBlueprint>(raw_blueprint.clone()) {
            Ok(blueprint) => blueprint,
            Err(e) => return Ok(ToolResult::error(format!("Invalid blueprint JSON: {e}"))),
        };
        if blueprint.app.slug != app_slug {
            return Ok(ToolResult::error(
                "Changing an app slug is not supported yet. Keep blueprint.app.slug equal to app_slug.",
            ));
        }
        if let Err(report) = validation::validate_blueprint(&blueprint) {
            return Ok(ToolResult::error(format!(
                "Invalid blueprint: {}",
                report.errors.join(" | ")
            )));
        }

        let (app, previous_blueprint) = match self.core.load_app(user_id, &app_slug).await {
            Ok(app) => app,
            Err(result) => return Ok(result),
        };
        let version = match app_db::update_app_blueprint(
            self.core.db.pool(),
            app.id,
            &blueprint,
            Some(change_note),
            Some(user_id),
        )
        .await
        {
            Ok(version) => version,
            Err(e) => {
                return Ok(ToolResult::error(format!(
                    "Failed to update internal app: {e}"
                )))
            }
        };

        Ok(ToolResult::success(format!(
            "Internal app updated.\nslug={app_slug}\nname={} -> {}\nversion={version}\nchange_note={change_note}",
            previous_blueprint.app.name, blueprint.app.name
        )))
    }
}

#[async_trait]
impl Tool for ConfigureAppCapabilitiesTool {
    fn name(&self) -> &str {
        "configure_app_capabilities"
    }

    fn description(&self) -> &str {
        "Configure what a blueprint-generated internal app may access through the Homun bridge policy, such as contacts, channels, knowledge namespaces, tools, profiles, and writeback scopes."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "app_slug": {"type": "string", "description": "Existing internal app slug"},
                "profiles": {"type": "array", "items": {"type": "string"}, "description": "Allowed Homun profile slugs"},
                "contacts_read": {"type": "array", "items": {"type": "string"}, "description": "Allowed contact refs: *, id, name, nickname, or tag"},
                "link_app_users_to_contacts": {"type": "boolean", "description": "Whether app users may be linked to Homun contacts"},
                "channels_send": {"type": "array", "items": {"type": "string"}, "description": "Allowed outbound channel names"},
                "channels_receive": {"type": "array", "items": {"type": "string"}, "description": "Allowed inbound channel names"},
                "knowledge_namespaces": {"type": "array", "items": {"type": "string"}, "description": "Allowed knowledge namespaces"},
                "tools": {"type": "array", "items": {"type": "string"}, "description": "Allowed bridge tools or skill-like capabilities"},
                "writeback": {"type": "array", "items": {"type": "string"}, "description": "Allowed writeback scopes"},
                "mode": {"type": "string", "enum": ["replace", "merge"], "description": "replace overwrites the policy, merge adds to existing policy. Default merge."}
            },
            "required": ["app_slug"]
        })
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<ToolResult> {
        let user_id = match self.core.require_user_id(ctx) {
            Ok(user_id) => user_id,
            Err(result) => return Ok(result),
        };
        let app_slug = get_string_param(&args, "app_slug")?;
        let mode = args.get("mode").and_then(Value::as_str).unwrap_or("merge");
        if !matches!(mode, "replace" | "merge") {
            return Ok(ToolResult::error(
                "mode must be either 'replace' or 'merge'",
            ));
        }
        let (app, _) = match self.core.load_app(user_id, &app_slug).await {
            Ok(app) => app,
            Err(result) => return Ok(result),
        };
        let mut policy = if mode == "merge" {
            match app_db::load_bridge_policy(self.core.db.pool(), app.id).await {
                Ok(Some(row)) => serde_json::from_str::<BridgePolicy>(&row.policy_json)
                    .unwrap_or_else(|_| BridgePolicy::deny_all()),
                Ok(None) => BridgePolicy::deny_all(),
                Err(e) => {
                    return Ok(ToolResult::error(format!(
                        "Failed to load app capabilities: {e}"
                    )))
                }
            }
        } else {
            BridgePolicy::deny_all()
        };

        merge_array_arg(&mut policy.profiles, &args, "profiles");
        merge_array_arg(&mut policy.contacts.read, &args, "contacts_read");
        if let Some(link) = args
            .get("link_app_users_to_contacts")
            .and_then(Value::as_bool)
        {
            policy.contacts.link_app_users = link;
        }
        merge_array_arg(&mut policy.channels.send, &args, "channels_send");
        merge_array_arg(&mut policy.channels.receive, &args, "channels_receive");
        merge_array_arg(
            &mut policy.knowledge_namespaces,
            &args,
            "knowledge_namespaces",
        );
        merge_array_arg(&mut policy.tools, &args, "tools");
        merge_array_arg(&mut policy.writeback, &args, "writeback");
        let policy = policy.normalized();

        if let Err(e) = app_db::upsert_bridge_policy(self.core.db.pool(), app.id, &policy).await {
            return Ok(ToolResult::error(format!(
                "Failed to save app capabilities: {e}"
            )));
        }

        Ok(ToolResult::success(format!(
            "Internal app capabilities configured.\napp={app_slug}\nmode={mode}\nprofiles={}\ncontacts_read={}\nchannels_send={}\nknowledge_namespaces={}\ntools={}",
            policy.profiles.join(", "),
            policy.contacts.read.join(", "),
            policy.channels.send.join(", "),
            policy.knowledge_namespaces.join(", "),
            policy.tools.join(", ")
        )))
    }
}

#[async_trait]
impl Tool for AddAppFieldTool {
    fn name(&self) -> &str {
        "add_app_field"
    }

    fn description(&self) -> &str {
        "Add a field to an entity in a blueprint-generated internal app, validate the updated blueprint, and save a new version. Use for chat requests like adding a field to an existing app."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "app_slug": {"type": "string", "description": "Existing internal app slug"},
                "entity": {"type": "string", "description": "Entity name to modify"},
                "field_name": {"type": "string", "description": "New field identifier. Optional if label is provided; generated as snake_case."},
                "label": {"type": "string", "description": "Human-readable field label"},
                "field_type": {"type": "string", "description": "Field type: string, text, number, date, boolean, enum, relation. Common aliases like email/select/textarea are normalized."},
                "required": {"type": "boolean", "description": "Whether the field is required"},
                "default": {"description": "Optional default JSON value"},
                "options": {"type": "array", "items": {"type": "string"}, "description": "Enum options"},
                "to": {"type": "string", "description": "Relation target entity"},
                "append_to_table_views": {"type": "boolean", "description": "Append the field to existing table views for the entity. Default true."},
                "change_note": {"type": "string", "description": "Short human-readable summary of the change"}
            },
            "required": ["app_slug", "entity", "label", "field_type"]
        })
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<ToolResult> {
        let user_id = match self.core.require_user_id(ctx) {
            Ok(user_id) => user_id,
            Err(result) => return Ok(result),
        };
        let app_slug = get_string_param(&args, "app_slug")?;
        let entity_name = get_string_param(&args, "entity")?;
        let label = get_string_param(&args, "label")?;
        let field_name = args
            .get("field_name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| ident_from_label(&label));
        let field_type_raw = get_string_param(&args, "field_type")?;
        let field_type = match parse_field_type(&field_type_raw) {
            Ok(field_type) => field_type,
            Err(message) => return Ok(ToolResult::error(message)),
        };
        let required = args
            .get("required")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let options = args
            .get("options")
            .and_then(Value::as_array)
            .map(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|value| !value.is_empty())
                    .map(ToOwned::to_owned)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let to = args
            .get("to")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned);
        let default = args.get("default").cloned();
        let append_to_table_views = args
            .get("append_to_table_views")
            .and_then(Value::as_bool)
            .unwrap_or(true);
        let change_note = args
            .get("change_note")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|note| !note.is_empty())
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("Add field {field_name} to {entity_name}"));

        let (app, mut blueprint) = match self.core.load_app(user_id, &app_slug).await {
            Ok(app) => app,
            Err(result) => return Ok(result),
        };
        let Some(entity) = blueprint
            .entities
            .iter_mut()
            .find(|entity| entity.name == entity_name)
        else {
            return Ok(ToolResult::error(format!(
                "Entity not found: {entity_name}"
            )));
        };
        if entity.fields.iter().any(|field| field.name == field_name) {
            return Ok(ToolResult::error(format!(
                "Field already exists: {entity_name}.{field_name}"
            )));
        }

        entity.fields.push(FieldDefinition {
            name: field_name.clone(),
            field_type,
            label: label.clone(),
            required,
            default,
            options,
            to,
        });
        if append_to_table_views {
            for view in &mut blueprint.views {
                if view.entity == entity_name && !view.columns.iter().any(|col| col == &field_name)
                {
                    view.columns.push(field_name.clone());
                }
            }
        }
        if let Err(report) = validation::validate_blueprint(&blueprint) {
            return Ok(ToolResult::error(format!(
                "Invalid updated blueprint: {}",
                report.errors.join(" | ")
            )));
        }

        let version = match app_db::update_app_blueprint(
            self.core.db.pool(),
            app.id,
            &blueprint,
            Some(&change_note),
            Some(user_id),
        )
        .await
        {
            Ok(version) => version,
            Err(e) => return Ok(ToolResult::error(format!("Failed to add app field: {e}"))),
        };

        Ok(ToolResult::success(format!(
            "Internal app field added.\napp={app_slug}\nentity={entity_name}\nfield={field_name}\nlabel={label}\nversion={version}"
        )))
    }
}

#[async_trait]
impl Tool for CreateAppRecordTool {
    fn name(&self) -> &str {
        "create_app_record"
    }

    fn description(&self) -> &str {
        "Create a record inside an internal app from a blueprint-defined entity. The record is validated against the app blueprint."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "app_slug": {"type": "string", "description": "Internal app slug"},
                "entity": {"type": "string", "description": "Blueprint entity name"},
                "data": {"type": "object", "description": "Record data to validate and store"}
            },
            "required": ["app_slug", "entity", "data"]
        })
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<ToolResult> {
        let user_id = match self.core.require_user_id(ctx) {
            Ok(user_id) => user_id,
            Err(result) => return Ok(result),
        };
        let app_slug = get_string_param(&args, "app_slug")?;
        let entity_name = get_string_param(&args, "entity")?;
        let Some(raw_data) = args.get("data") else {
            return Ok(ToolResult::error("Missing required parameter: data"));
        };
        let (app, blueprint) = match self.core.load_app(user_id, &app_slug).await {
            Ok(app) => app,
            Err(result) => return Ok(result),
        };
        let data = match runtime::validate_record_data(&blueprint, &entity_name, raw_data) {
            Ok(data) => data,
            Err(e) => return Ok(ToolResult::error(format!("Invalid record data: {e}"))),
        };
        let status = record_status(&blueprint, &entity_name, &data);
        let app_pool = match self.core.open_app_pool(&app).await {
            Ok(pool) => pool,
            Err(result) => return Ok(result),
        };
        let record_id = match app_db::insert_record(
            &app_pool,
            &entity_name,
            &data,
            status.as_deref(),
            Some(user_id),
        )
        .await
        {
            Ok(id) => id,
            Err(e) => {
                return Ok(ToolResult::error(format!(
                    "Failed to create app record: {e}"
                )))
            }
        };
        let payload = json!({"entity": entity_name, "record_id": record_id});
        let _ = app_db::insert_app_event(
            &app_pool,
            Some(record_id),
            "record.created",
            &payload,
            Some(user_id),
        )
        .await;
        app_pool.close().await;
        let _ = app_db::insert_internal_app_event(
            self.core.db.pool(),
            app.id,
            Some(record_id),
            "record.created",
            &payload,
            Some(user_id),
        )
        .await;

        Ok(ToolResult::success(format!(
            "Internal app record created.\napp={app_slug}\nentity={entity_name}\nrecord_id={record_id}\nstatus={}",
            status.unwrap_or_else(|| "none".to_string())
        )))
    }
}

#[async_trait]
impl Tool for QueryAppRecordsTool {
    fn name(&self) -> &str {
        "query_app_records"
    }

    fn description(&self) -> &str {
        "Query records from an internal app created from a blueprint. Supports simple exact-match JSON filters."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "app_slug": {"type": "string", "description": "Internal app slug"},
                "entity": {"type": "string", "description": "Blueprint entity name"},
                "limit": {"type": "number", "description": "Maximum records to return, default 100"},
                "filters": {"type": "object", "description": "Exact-match filters over JSON fields"}
            },
            "required": ["app_slug", "entity"]
        })
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<ToolResult> {
        let user_id = match self.core.require_user_id(ctx) {
            Ok(user_id) => user_id,
            Err(result) => return Ok(result),
        };
        let app_slug = get_string_param(&args, "app_slug")?;
        let entity_name = get_string_param(&args, "entity")?;
        let limit = args
            .get("limit")
            .and_then(Value::as_i64)
            .unwrap_or(100)
            .clamp(1, 500);
        let filters = args.get("filters").and_then(Value::as_object);
        let (app, blueprint) = match self.core.load_app(user_id, &app_slug).await {
            Ok(app) => app,
            Err(result) => return Ok(result),
        };
        if let Err(e) = runtime::entity(&blueprint, &entity_name) {
            return Ok(ToolResult::error(e.to_string()));
        }
        let app_pool = match self.core.open_app_pool(&app).await {
            Ok(pool) => pool,
            Err(result) => return Ok(result),
        };
        let rows = match app_db::list_records(&app_pool, &entity_name, limit).await {
            Ok(rows) => rows,
            Err(e) => {
                return Ok(ToolResult::error(format!(
                    "Failed to query app records: {e}"
                )))
            }
        };
        app_pool.close().await;

        let mut records = Vec::new();
        for row in rows {
            let data = serde_json::from_str::<Value>(&row.data_json)?;
            if filters_match(&data, filters) {
                records.push(json!({
                    "id": row.id,
                    "entity": row.entity_name,
                    "data": data,
                    "status": row.status,
                    "created_at": row.created_at,
                    "updated_at": row.updated_at
                }));
            }
        }
        Ok(ToolResult::success(serde_json::to_string_pretty(&records)?))
    }
}

#[async_trait]
impl Tool for RunAppActionTool {
    fn name(&self) -> &str {
        "run_app_action"
    }

    fn description(&self) -> &str {
        "Run a workflow action on a record in an internal app. The action is validated against the app blueprint workflow."
    }

    fn parameters(&self) -> Value {
        json!({
            "type": "object",
            "properties": {
                "app_slug": {"type": "string", "description": "Internal app slug"},
                "entity": {"type": "string", "description": "Blueprint entity name"},
                "record_id": {"type": "number", "description": "Record id"},
                "action": {"type": "string", "description": "Blueprint workflow transition name"}
            },
            "required": ["app_slug", "entity", "record_id", "action"]
        })
    }

    async fn execute(&self, args: Value, ctx: &ToolContext) -> Result<ToolResult> {
        let user_id = match self.core.require_user_id(ctx) {
            Ok(user_id) => user_id,
            Err(result) => return Ok(result),
        };
        let app_slug = get_string_param(&args, "app_slug")?;
        let entity_name = get_string_param(&args, "entity")?;
        let action = get_string_param(&args, "action")?;
        let record_id = args
            .get("record_id")
            .and_then(Value::as_i64)
            .ok_or_else(|| anyhow!("Missing required parameter: record_id"))?;
        let (app, blueprint) = match self.core.load_app(user_id, &app_slug).await {
            Ok(app) => app,
            Err(result) => return Ok(result),
        };
        let app_pool = match self.core.open_app_pool(&app).await {
            Ok(pool) => pool,
            Err(result) => return Ok(result),
        };
        let Some(row) = app_db::load_record(&app_pool, record_id)
            .await
            .map_err(|e| anyhow!("Failed to load app record: {e}"))?
        else {
            app_pool.close().await;
            return Ok(ToolResult::error(format!("Record not found: {record_id}")));
        };
        if row.entity_name != entity_name {
            app_pool.close().await;
            return Ok(ToolResult::error(format!("Record not found: {record_id}")));
        }
        let mut data = serde_json::from_str::<Value>(&row.data_json)?;
        let event_type =
            match runtime::apply_transition(&blueprint, &entity_name, &mut data, &action) {
                Ok(event_type) => event_type,
                Err(e) => {
                    app_pool.close().await;
                    return Ok(ToolResult::error(format!("Action rejected: {e}")));
                }
            };
        let status = record_status(&blueprint, &entity_name, &data);
        if let Err(e) =
            app_db::update_record_data(&app_pool, record_id, &data, status.as_deref()).await
        {
            app_pool.close().await;
            return Ok(ToolResult::error(format!(
                "Failed to update app record: {e}"
            )));
        }
        let payload = json!({"entity": entity_name, "record_id": record_id, "action": action});
        let _ = app_db::insert_app_event(
            &app_pool,
            Some(record_id),
            &event_type,
            &payload,
            Some(user_id),
        )
        .await;
        app_pool.close().await;
        let _ = app_db::insert_internal_app_event(
            self.core.db.pool(),
            app.id,
            Some(record_id),
            &event_type,
            &payload,
            Some(user_id),
        )
        .await;

        Ok(ToolResult::success(format!(
            "Internal app action completed.\napp={app_slug}\nentity={entity_name}\nrecord_id={record_id}\naction={action}\nevent={event_type}\nstatus={}",
            status.unwrap_or_else(|| "none".to_string())
        )))
    }
}

fn record_status(blueprint: &AppBlueprint, entity_name: &str, data: &Value) -> Option<String> {
    let workflow = blueprint
        .workflows
        .iter()
        .find(|workflow| workflow.entity == entity_name)?;
    data.get(&workflow.state_field)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
}

fn filters_match(data: &Value, filters: Option<&serde_json::Map<String, Value>>) -> bool {
    let Some(filters) = filters else {
        return true;
    };
    filters
        .iter()
        .all(|(field, expected)| data.get(field) == Some(expected))
}

fn merge_array_arg(target: &mut Vec<String>, args: &Value, key: &str) {
    let Some(values) = args.get(key).and_then(Value::as_array) else {
        return;
    };
    target.extend(
        values
            .iter()
            .filter_map(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(ToOwned::to_owned),
    );
}

fn ident_from_label(label: &str) -> String {
    let mut ident = String::new();
    let mut last_was_sep = false;
    for ch in label.chars() {
        if ch.is_ascii_alphanumeric() {
            ident.push(ch.to_ascii_lowercase());
            last_was_sep = false;
        } else if !last_was_sep && !ident.is_empty() {
            ident.push('_');
            last_was_sep = true;
        }
    }
    while ident.ends_with('_') {
        ident.pop();
    }
    if ident.is_empty() {
        "field".to_string()
    } else {
        ident
    }
}

fn parse_field_type(raw: &str) -> std::result::Result<FieldType, String> {
    match raw.trim().to_ascii_lowercase().as_str() {
        "string" | "email" | "phone" | "url" => Ok(FieldType::String),
        "text" | "textarea" | "long_text" | "markdown" => Ok(FieldType::Text),
        "number" | "integer" | "float" | "decimal" => Ok(FieldType::Number),
        "date" | "datetime" => Ok(FieldType::Date),
        "boolean" | "bool" | "checkbox" => Ok(FieldType::Boolean),
        "enum" | "select" | "choice" | "dropdown" => Ok(FieldType::Enum),
        "relation" | "reference" | "lookup" => Ok(FieldType::Relation),
        other => Err(format!(
            "Unsupported field_type '{other}'. Use string, text, number, date, boolean, enum, or relation."
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::Database;
    use crate::tools::registry::{Tool, ToolContext};
    use serde_json::json;
    use tempfile::TempDir;

    async fn test_db() -> (Database, TempDir) {
        let dir = TempDir::new().unwrap();
        let db = Database::open(&dir.path().join("homun.db")).await.unwrap();
        (db, dir)
    }

    fn test_context(user_id: Option<&str>) -> ToolContext {
        ToolContext {
            workspace: "/tmp".to_string(),
            channel: "web".to_string(),
            chat_id: "chat".to_string(),
            message_tx: None,
            approval_manager: None,
            skill_env: None,
            user_id: user_id.map(ToOwned::to_owned),
            profile_id: Some(1),
            profile_brain_dir: None,
            profile_slug: Some("default".to_string()),
            allowed_namespaces: None,
            contact_id: None,
            channel_defaults: None,
        }
    }

    fn valid_blueprint() -> serde_json::Value {
        json!({
            "version": 1,
            "app": {"slug": "ferie-permessi", "name": "Ferie e Permessi"},
            "entities": [
                {"name": "leave_request", "label": "Richiesta", "fields": [
                    {"name": "kind", "type": "enum", "label": "Tipo", "required": true, "options": ["ferie", "permesso"]},
                    {"name": "status", "type": "enum", "label": "Stato", "options": ["pending", "approved"], "default": "pending"}
                ]}
            ],
            "views": [
                {"type": "table", "entity": "leave_request", "name": "Richieste", "columns": ["kind", "status"]}
            ],
            "workflows": [
                {"entity": "leave_request", "state_field": "status", "states": ["pending", "approved"], "transitions": [
                    {"name": "approve", "from": "pending", "to": "approved", "label": "Approva"}
                ]}
            ]
        })
    }

    #[tokio::test]
    async fn tool_descriptions_mention_internal_apps_and_blueprint() {
        let dir = TempDir::new().unwrap();
        let db_path = dir.path().join("homun.db");
        let db = Database::open(&db_path).await.unwrap();
        let data_dir = dir.path().to_path_buf();

        let tools = app_factory_tools(db, data_dir);

        assert_eq!(tools.len(), 8);
        for tool in tools {
            let description = tool.description().to_lowercase();
            assert!(description.contains("internal app"));
            assert!(description.contains("blueprint"));
        }
    }

    #[tokio::test]
    async fn create_internal_app_requires_user_id() {
        let (db, dir) = test_db().await;
        let tool = CreateInternalAppTool::new(db, dir.path().to_path_buf());

        let result = tool
            .execute(json!({"blueprint": valid_blueprint()}), &test_context(None))
            .await
            .unwrap();

        assert!(result.is_error);
        assert!(result.output.contains("user_id"));
    }

    #[tokio::test]
    async fn create_internal_app_returns_validation_errors() {
        let (db, dir) = test_db().await;
        let tool = CreateInternalAppTool::new(db, dir.path().to_path_buf());
        let mut invalid = valid_blueprint();
        invalid["entities"][0]["fields"][1]["options"] = json!([]);

        let result = tool
            .execute(json!({"blueprint": invalid}), &test_context(Some("user-1")))
            .await
            .unwrap();

        assert!(result.is_error);
        assert!(result.output.contains("Invalid blueprint"));
        assert!(result.output.contains("must define 1-32 options"));
    }

    #[tokio::test]
    async fn update_internal_app_saves_new_blueprint_version() {
        let (db, dir) = test_db().await;
        let data_dir = dir.path().to_path_buf();
        let ctx = test_context(Some("user-1"));
        let create_app = CreateInternalAppTool::new(db.clone(), data_dir.clone());
        let update_app = UpdateInternalAppTool::new(db, data_dir);
        let mut updated = valid_blueprint();
        updated["app"]["name"] = json!("Ferie e Permessi HR");

        let created_app = create_app
            .execute(json!({"blueprint": valid_blueprint()}), &ctx)
            .await
            .unwrap();
        assert!(!created_app.is_error, "{}", created_app.output);

        let result = update_app
            .execute(
                json!({
                    "app_slug": "ferie-permessi",
                    "blueprint": updated,
                    "change_note": "Rinomina app"
                }),
                &ctx,
            )
            .await
            .unwrap();

        assert!(!result.is_error, "{}", result.output);
        assert!(result.output.contains("version=2"));
        assert!(result
            .output
            .contains("Ferie e Permessi -> Ferie e Permessi HR"));
    }

    #[tokio::test]
    async fn configure_app_capabilities_merges_bridge_policy() {
        let (db, dir) = test_db().await;
        let data_dir = dir.path().to_path_buf();
        let ctx = test_context(Some("user-1"));
        let create_app = CreateInternalAppTool::new(db.clone(), data_dir.clone());
        let configure = ConfigureAppCapabilitiesTool::new(db.clone(), data_dir);

        let created_app = create_app
            .execute(json!({"blueprint": valid_blueprint()}), &ctx)
            .await
            .unwrap();
        assert!(!created_app.is_error, "{}", created_app.output);

        let result = configure
            .execute(
                json!({
                    "app_slug": "ferie-permessi",
                    "contacts_read": ["hr-team", " hr-team "],
                    "channels_send": ["email"],
                    "tools": ["send_message"],
                    "mode": "merge"
                }),
                &ctx,
            )
            .await
            .unwrap();
        assert!(!result.is_error, "{}", result.output);
        assert!(result.output.contains("contacts_read=hr-team"));
        assert!(result.output.contains("channels_send=email"));

        let app = app_db::load_app_for_user(db.pool(), "user-1", "ferie-permessi")
            .await
            .unwrap()
            .unwrap();
        let row = app_db::load_bridge_policy(db.pool(), app.id)
            .await
            .unwrap()
            .unwrap();
        let policy: BridgePolicy = serde_json::from_str(&row.policy_json).unwrap();
        assert_eq!(policy.contacts.read, vec!["hr-team"]);
        assert_eq!(policy.channels.send, vec!["email"]);
        assert_eq!(policy.tools, vec!["send_message"]);
    }

    #[tokio::test]
    async fn add_app_field_updates_blueprint_without_rewriting_it() {
        let (db, dir) = test_db().await;
        let data_dir = dir.path().to_path_buf();
        let ctx = test_context(Some("user-1"));
        let create_app = CreateInternalAppTool::new(db.clone(), data_dir.clone());
        let add_field = AddAppFieldTool::new(db.clone(), data_dir);

        let created_app = create_app
            .execute(json!({"blueprint": valid_blueprint()}), &ctx)
            .await
            .unwrap();
        assert!(!created_app.is_error, "{}", created_app.output);

        let result = add_field
            .execute(
                json!({
                    "app_slug": "ferie-permessi",
                    "entity": "leave_request",
                    "label": "Motivo dettagliato",
                    "field_type": "textarea"
                }),
                &ctx,
            )
            .await
            .unwrap();
        assert!(!result.is_error, "{}", result.output);
        assert!(result.output.contains("field=motivo_dettagliato"));
        assert!(result.output.contains("version=2"));

        let app = app_db::load_app_for_user(db.pool(), "user-1", "ferie-permessi")
            .await
            .unwrap()
            .unwrap();
        let blueprint: AppBlueprint = serde_json::from_str(&app.blueprint_json).unwrap();
        let entity = blueprint
            .entities
            .iter()
            .find(|entity| entity.name == "leave_request")
            .unwrap();
        let field = entity
            .fields
            .iter()
            .find(|field| field.name == "motivo_dettagliato")
            .unwrap();
        assert_eq!(field.field_type, FieldType::Text);
        assert!(blueprint.views[0]
            .columns
            .contains(&"motivo_dettagliato".to_string()));
    }

    #[tokio::test]
    async fn tools_create_query_and_run_app_action() {
        let (db, dir) = test_db().await;
        let data_dir = dir.path().to_path_buf();
        let ctx = test_context(Some("user-1"));

        let create_app = CreateInternalAppTool::new(db.clone(), data_dir.clone());
        let create_record = CreateAppRecordTool::new(db.clone(), data_dir.clone());
        let query_records = QueryAppRecordsTool::new(db.clone(), data_dir.clone());
        let run_action = RunAppActionTool::new(db, data_dir);

        let created_app = create_app
            .execute(json!({"blueprint": valid_blueprint()}), &ctx)
            .await
            .unwrap();
        assert!(!created_app.is_error, "{}", created_app.output);

        let created_record = create_record
            .execute(
                json!({
                    "app_slug": "ferie-permessi",
                    "entity": "leave_request",
                    "data": {"kind": "ferie"}
                }),
                &ctx,
            )
            .await
            .unwrap();
        assert!(!created_record.is_error, "{}", created_record.output);
        assert!(created_record.output.contains("record_id=1"));
        assert!(created_record.output.contains("status=pending"));

        let queried = query_records
            .execute(
                json!({
                    "app_slug": "ferie-permessi",
                    "entity": "leave_request",
                    "filters": {"status": "pending"}
                }),
                &ctx,
            )
            .await
            .unwrap();
        assert!(!queried.is_error, "{}", queried.output);
        assert!(queried.output.contains("\"status\": \"pending\""));

        let action = run_action
            .execute(
                json!({
                    "app_slug": "ferie-permessi",
                    "entity": "leave_request",
                    "record_id": 1,
                    "action": "approve"
                }),
                &ctx,
            )
            .await
            .unwrap();
        assert!(!action.is_error, "{}", action.output);
        assert!(action.output.contains("event=leave_request.approved"));
        assert!(action.output.contains("status=approved"));
    }
}

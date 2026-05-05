use super::blueprint::AppBlueprint;
use serde::{Deserialize, Serialize};
use serde_json::json;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlanIntent {
    CreateApp,
    SimpleModification,
    StructuralModification,
    DataOperation,
    CapabilityConfiguration,
    Unsupported,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum FieldClassification {
    UserInput,
    System,
    WorkflowState,
    LookupStatic,
    LookupDynamic,
    Relation,
    Computed,
    BridgeBacked,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlannedField {
    pub entity: String,
    pub field: String,
    pub classification: FieldClassification,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlannedEntity {
    pub name: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PlanningQuestion {
    pub question: String,
    pub reason: String,
    pub options: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ToolRecommendation {
    pub tool: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PlanningReport {
    pub intent: PlanIntent,
    pub summary: String,
    pub entities: Vec<PlannedEntity>,
    pub fields: Vec<PlannedField>,
    pub views: Vec<String>,
    pub roles: Vec<String>,
    pub assumptions: Vec<String>,
    pub questions: Vec<PlanningQuestion>,
    pub recommended_tools: Vec<ToolRecommendation>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub recommended_blueprint: Option<AppBlueprint>,
}

impl PlanningReport {
    pub fn should_ask_before_building(&self) -> bool {
        !self.questions.is_empty()
    }
}

pub fn plan_request(request: &str, existing_app_slug: Option<&str>) -> PlanningReport {
    let text = request.to_ascii_lowercase();
    let has_existing_app = existing_app_slug
        .map(|slug| !slug.trim().is_empty())
        .unwrap_or(false);

    if mentions_room_booking(&text) {
        return plan_room_booking(&text, has_existing_app);
    }
    if mentions_ticket(&text) {
        return plan_ticketing(&text, has_existing_app);
    }
    if mentions_leave(&text) {
        return plan_leave(&text, has_existing_app);
    }
    if mentions_capabilities(&text) {
        return PlanningReport {
            intent: PlanIntent::CapabilityConfiguration,
            summary: "Configura capability controllate tra app interna e Homun.".to_string(),
            entities: vec![],
            fields: vec![],
            views: vec![],
            roles: vec!["admin".to_string()],
            assumptions: vec![
                "Le capability devono essere fail-closed e dichiarate esplicitamente.".to_string(),
            ],
            questions: vec![PlanningQuestion {
                question:
                    "A quali dati Homun deve accedere l'app: contatti, canali, knowledge o tool?"
                        .to_string(),
                reason: "L'accesso a dati Homun cambia il permission contract dell'app."
                    .to_string(),
                options: vec![
                    "Solo contatti".to_string(),
                    "Contatti e canali".to_string(),
                    "Knowledge/tool specifici".to_string(),
                ],
            }],
            recommended_tools: vec![ToolRecommendation {
                tool: "configure_app_capabilities".to_string(),
                reason: "Le capability vanno applicate al bridge policy, non al blueprint dati."
                    .to_string(),
            }],
            recommended_blueprint: None,
        };
    }

    PlanningReport {
        intent: if has_existing_app {
            PlanIntent::StructuralModification
        } else {
            PlanIntent::CreateApp
        },
        summary: "Richiesta app generica: serve una breve analisi prima del blueprint.".to_string(),
        entities: vec![],
        fields: vec![],
        views: vec!["table".to_string()],
        roles: vec!["admin".to_string(), "employee".to_string()],
        assumptions: vec![
            "Uso identity, data e navigation come moduli minimi.".to_string(),
            "I dati operativi restano nel database isolato dell'app.".to_string(),
        ],
        questions: vec![PlanningQuestion {
            question: "Quali sono i dati principali che l'app deve gestire?".to_string(),
            reason: "Senza entita' principali il blueprint rischia di diventare un form generico."
                .to_string(),
            options: vec![
                "Richieste o ticket".to_string(),
                "Prenotazioni o eventi".to_string(),
                "Anagrafiche e liste".to_string(),
            ],
        }],
        recommended_tools: vec![ToolRecommendation {
            tool: if has_existing_app {
                "update_internal_app".to_string()
            } else {
                "create_internal_app".to_string()
            },
            reason: "Serve un blueprint completo dopo la fase di pianificazione.".to_string(),
        }],
        recommended_blueprint: None,
    }
}

fn plan_room_booking(text: &str, has_existing_app: bool) -> PlanningReport {
    let asks_to_manage_rooms = contains_any(
        text,
        &[
            "gestire i nomi",
            "gestisci i nomi",
            "gestire le sale",
            "gestibili",
            "vista dedicata",
            "non una lista fissa",
            "collega alla select",
            "colleghi alla select",
            "lista sale",
        ],
    );
    let wants_calendar = contains_any(
        text,
        &["calendario", "calendar", "prenotazione", "riunioni"],
    );

    let intent = if has_existing_app {
        PlanIntent::StructuralModification
    } else {
        PlanIntent::CreateApp
    };
    let mut questions = Vec::new();
    if !asks_to_manage_rooms && !has_existing_app {
        questions.push(PlanningQuestion {
            question: "Vuoi che le sale siano gestibili da una vista dedicata, oppure basta una lista fissa iniziale?".to_string(),
            reason: "La risposta cambia il modello dati: enum statica oppure entita' Sala con relazione.".to_string(),
            options: vec![
                "Vista Sale gestibile".to_string(),
                "Lista fissa iniziale".to_string(),
            ],
        });
    }

    let tool = if has_existing_app {
        "extract_lookup_entity"
    } else {
        "create_internal_app"
    };

    PlanningReport {
        intent,
        summary: "Prenotazione sale: le sale sono dati di dominio e vanno preferibilmente modellate come entita' gestibile.".to_string(),
        entities: vec![
            PlannedEntity {
                name: "booking".to_string(),
                reason: "Rappresenta la prenotazione con date, proprietario e note.".to_string(),
            },
            PlannedEntity {
                name: "room".to_string(),
                reason: "Le sale cambiano nel tempo e devono poter essere aggiunte, rinominate o disattivate.".to_string(),
            },
        ],
        fields: vec![
            PlannedField {
                entity: "booking".to_string(),
                field: "room_id".to_string(),
                classification: FieldClassification::Relation,
                reason: "La prenotazione deve puntare a una sala gestibile, non a testo libero.".to_string(),
            },
            PlannedField {
                entity: "room".to_string(),
                field: "name".to_string(),
                classification: FieldClassification::UserInput,
                reason: "Il nome sala e' gestito dall'admin dell'app.".to_string(),
            },
            PlannedField {
                entity: "room".to_string(),
                field: "active".to_string(),
                classification: FieldClassification::System,
                reason: "Permette di disattivare sale senza perdere storico.".to_string(),
            },
        ],
        views: if wants_calendar {
            vec!["calendar".to_string(), "room_management".to_string()]
        } else {
            vec!["table".to_string(), "room_management".to_string()]
        },
        roles: vec!["admin".to_string(), "employee".to_string()],
        assumptions: vec![
            "Admin gestisce le sale e vede tutte le prenotazioni.".to_string(),
            "Employee crea e vede le proprie prenotazioni.".to_string(),
        ],
        questions,
        recommended_tools: vec![ToolRecommendation {
            tool: tool.to_string(),
            reason: if tool == "extract_lookup_entity" {
                "La richiesta modifica una select esistente trasformandola in entita' gestibile."
                    .to_string()
            } else {
                "Serve creare un'app completa con entita' booking e room.".to_string()
            },
        }],
        recommended_blueprint: if has_existing_app {
            None
        } else {
            Some(room_booking_blueprint())
        },
    }
}

fn plan_ticketing(text: &str, has_existing_app: bool) -> PlanningReport {
    let category_explicit = contains_any(text, &["categoria", "categorie", "category"]);
    let mut questions = Vec::new();
    if !category_explicit && !has_existing_app {
        questions.push(PlanningQuestion {
            question: "Le categorie ticket devono essere gestibili da admin o uso una lista standard iniziale?".to_string(),
            reason: "Le categorie possono essere una enum statica o una tabella gestibile.".to_string(),
            options: vec![
                "Categorie gestibili".to_string(),
                "Lista standard iniziale".to_string(),
            ],
        });
    }

    PlanningReport {
        intent: if has_existing_app {
            PlanIntent::StructuralModification
        } else {
            PlanIntent::CreateApp
        },
        summary: "Ticket interni: serve workflow di stato, board operativa e ownership per richiedente/assegnatario.".to_string(),
        entities: vec![PlannedEntity {
            name: "ticket".to_string(),
            reason: "Rappresenta la richiesta di supporto interna.".to_string(),
        }],
        fields: vec![
            PlannedField {
                entity: "ticket".to_string(),
                field: "status".to_string(),
                classification: FieldClassification::WorkflowState,
                reason: "Lo stato deve cambiare tramite transizioni, non dal form utente.".to_string(),
            },
            PlannedField {
                entity: "ticket".to_string(),
                field: "priority".to_string(),
                classification: FieldClassification::LookupStatic,
                reason: "Le priorita' hanno solitamente pochi valori stabili.".to_string(),
            },
            PlannedField {
                entity: "ticket".to_string(),
                field: "category".to_string(),
                classification: if category_explicit {
                    FieldClassification::LookupDynamic
                } else {
                    FieldClassification::LookupStatic
                },
                reason: "Le categorie diventano dinamiche quando l'azienda vuole gestirle nel tempo.".to_string(),
            },
            PlannedField {
                entity: "ticket".to_string(),
                field: "assignee_id".to_string(),
                classification: FieldClassification::Relation,
                reason: "L'assegnatario deve riferirsi a utenti o gruppo supporto, non a testo libero."
                    .to_string(),
            },
        ],
        views: vec!["table".to_string(), "kanban".to_string(), "dashboard".to_string()],
        roles: vec!["admin".to_string(), "support".to_string(), "employee".to_string()],
        assumptions: vec![
            "Employee crea e legge i propri ticket.".to_string(),
            "Support gestisce ticket aperti e assegnati.".to_string(),
            "Admin ha accesso completo.".to_string(),
        ],
        questions,
        recommended_tools: vec![ToolRecommendation {
            tool: if has_existing_app {
                "update_internal_app".to_string()
            } else {
                "create_internal_app".to_string()
            },
            reason: "Ticket richiede blueprint completo con workflow e viste operative.".to_string(),
        }],
        recommended_blueprint: None,
    }
}

fn plan_leave(text: &str, has_existing_app: bool) -> PlanningReport {
    let approval_explicit = contains_any(text, &["approv", "responsabile", "workflow"]);
    let mut questions = Vec::new();
    if !approval_explicit && !has_existing_app {
        questions.push(PlanningQuestion {
            question: "Le richieste devono essere approvate da un responsabile o basta registrarle come confermate?".to_string(),
            reason: "La risposta decide se creare un workflow con approver.".to_string(),
            options: vec![
                "Workflow con approvazione".to_string(),
                "Registrazione diretta".to_string(),
            ],
        });
    }

    PlanningReport {
        intent: if has_existing_app {
            PlanIntent::StructuralModification
        } else {
            PlanIntent::CreateApp
        },
        summary: "Ferie e permessi: le richieste sono record con ownership, date e stato gestito da workflow.".to_string(),
        entities: vec![PlannedEntity {
            name: "leave_request".to_string(),
            reason: "Rappresenta ferie, permessi o assenze richieste dall'utente.".to_string(),
        }],
        fields: vec![
            PlannedField {
                entity: "leave_request".to_string(),
                field: "status".to_string(),
                classification: FieldClassification::WorkflowState,
                reason: "Lo stato non deve essere scelto nel form: viene impostato da transizioni."
                    .to_string(),
            },
            PlannedField {
                entity: "leave_request".to_string(),
                field: "kind".to_string(),
                classification: FieldClassification::LookupStatic,
                reason: "Tipi come ferie/permesso/malattia sono valori iniziali stabili.".to_string(),
            },
            PlannedField {
                entity: "leave_request".to_string(),
                field: "employee_id".to_string(),
                classification: FieldClassification::Relation,
                reason: "La richiesta deve essere collegata al proprietario app-local.".to_string(),
            },
        ],
        views: vec!["table".to_string(), "calendar".to_string(), "dashboard".to_string()],
        roles: vec!["admin".to_string(), "approver".to_string(), "employee".to_string()],
        assumptions: vec![
            "Employee crea e vede le proprie richieste.".to_string(),
            "Approver gestisce approvazione/rifiuto se il workflow e' abilitato.".to_string(),
            "Admin ha accesso completo.".to_string(),
        ],
        questions,
        recommended_tools: vec![ToolRecommendation {
            tool: if has_existing_app {
                "update_internal_app".to_string()
            } else {
                "create_internal_app".to_string()
            },
            reason: "Serve blueprint completo con date, ownership e workflow opzionale.".to_string(),
        }],
        recommended_blueprint: None,
    }
}

fn room_booking_blueprint() -> AppBlueprint {
    serde_json::from_value(json!({
        "version": 1,
        "app": {
            "slug": "prenotazione-sale-riunioni",
            "name": "Prenotazione Sale Riunioni",
            "description": "App per gestire sale e prenotazioni con calendario operativo"
        },
        "modules": [
            {"name": "identity", "version": 1, "features": ["local_users", "roles", "ownership"], "required": true},
            {"name": "data", "version": 1, "features": ["relations", "ownership"], "required": true},
            {"name": "navigation", "version": 1, "features": [], "required": true},
            {"name": "calendar", "version": 1, "features": ["drag_drop"], "required": true},
            {"name": "dashboard", "version": 1, "features": ["counts"], "required": false}
        ],
        "roles": [
            {"name": "admin", "label": "Admin"},
            {"name": "employee", "label": "Dipendente"}
        ],
        "entities": [
            {
                "name": "room",
                "label": "Sala",
                "fields": [
                    {"name": "name", "type": "string", "label": "Nome", "required": true},
                    {"name": "capacity", "type": "number", "label": "Capienza"},
                    {"name": "active", "type": "boolean", "label": "Attiva", "default": true}
                ]
            },
            {
                "name": "booking",
                "label": "Prenotazione",
                "fields": [
                    {"name": "title", "type": "string", "label": "Titolo", "required": true},
                    {"name": "room_id", "type": "relation", "to": "room", "label": "Sala", "required": true},
                    {"name": "start_date", "type": "date", "label": "Data inizio", "required": true},
                    {"name": "end_date", "type": "date", "label": "Data fine", "required": true},
                    {"name": "notes", "type": "text", "label": "Note"},
                    {"name": "status", "type": "enum", "label": "Stato", "options": ["confirmed", "cancelled"], "default": "confirmed", "system": true, "editable_by": ["admin"]}
                ]
            }
        ],
        "views": [
            {"id": "rooms", "type": "table", "entity": "room", "name": "Sale", "columns": ["name", "capacity", "active"], "roles": ["admin"]},
            {"id": "bookings", "type": "table", "entity": "booking", "name": "Prenotazioni", "columns": ["title", "room_id", "start_date", "end_date", "status"], "roles": ["admin", "employee"]},
            {"id": "booking_calendar", "type": "calendar", "entity": "booking", "name": "Calendario", "columns": ["title", "room_id", "start_date", "end_date", "status"], "roles": ["admin", "employee"]},
            {"id": "new_booking", "type": "form", "entity": "booking", "name": "Nuova prenotazione", "columns": ["title", "room_id", "start_date", "end_date", "notes"], "roles": ["admin", "employee"]}
        ],
        "permissions": [
            {"role": "admin", "allow": ["room:create", "room:read", "room:update", "booking:create", "booking:read", "booking:update"]},
            {"role": "employee", "allow": ["room:read", "booking:create", "booking:read:own", "booking:update:own"]}
        ],
        "navigation": [
            {"label": "Calendario", "view": "booking_calendar", "roles": ["admin", "employee"]},
            {"label": "Prenotazioni", "view": "bookings", "roles": ["admin", "employee"]},
            {"label": "Sale", "view": "rooms", "roles": ["admin"]},
            {"label": "Nuova prenotazione", "view": "new_booking", "roles": ["admin", "employee"]}
        ],
        "dashboards": [
            {"name": "overview", "widgets": [
                {"type": "count", "entity": "booking", "label": "Prenotazioni", "filter": {}, "roles": ["admin"]},
                {"type": "count", "entity": "room", "label": "Sale", "filter": {"active": true}, "roles": ["admin"]}
            ]}
        ]
    }))
    .expect("room booking blueprint must deserialize")
}

fn mentions_room_booking(text: &str) -> bool {
    contains_any(
        text,
        &[
            "sala",
            "sale",
            "riunione",
            "riunioni",
            "meeting room",
            "booking room",
            "room",
        ],
    )
}

fn mentions_ticket(text: &str) -> bool {
    contains_any(text, &["ticket", "supporto", "help desk", "helpdesk"])
}

fn mentions_leave(text: &str) -> bool {
    contains_any(
        text,
        &[
            "ferie", "permessi", "assenze", "malattia", "leave", "vacation",
        ],
    )
}

fn mentions_capabilities(text: &str) -> bool {
    contains_any(
        text,
        &[
            "capability",
            "capabilities",
            "contatti",
            "canali",
            "knowledge",
            "mcp",
            "skill",
        ],
    )
}

fn contains_any(text: &str, needles: &[&str]) -> bool {
    needles.iter().any(|needle| text.contains(needle))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app_factory::validation;

    #[test]
    fn room_booking_plan_prefers_dynamic_rooms_and_calendar() {
        let plan = plan_request("Crea un'app per prenotazione sale riunioni", None);

        assert_eq!(plan.intent, PlanIntent::CreateApp);
        assert!(plan.should_ask_before_building());
        assert!(plan.entities.iter().any(|entity| entity.name == "room"));
        assert!(plan.views.contains(&"calendar".to_string()));
        assert!(plan.fields.iter().any(|field| {
            field.entity == "booking"
                && field.field == "room_id"
                && field.classification == FieldClassification::Relation
        }));
        assert!(plan.recommended_blueprint.is_some());
        validation::validate_blueprint(plan.recommended_blueprint.as_ref().unwrap()).unwrap();
    }

    #[test]
    fn explicit_room_management_create_plan_does_not_ask_and_includes_blueprint() {
        let plan = plan_request(
            "Crea un'app per prenotare sale riunioni. Le sale devono essere gestibili da una vista dedicata, non una lista fissa. Voglio un calendario operativo.",
            None,
        );

        assert_eq!(plan.intent, PlanIntent::CreateApp);
        assert!(!plan.should_ask_before_building());
        assert_eq!(plan.recommended_tools[0].tool, "create_internal_app");
        let blueprint = plan.recommended_blueprint.as_ref().unwrap();
        validation::validate_blueprint(blueprint).unwrap();
        assert!(blueprint
            .entities
            .iter()
            .any(|entity| entity.name == "room"));
        assert!(blueprint.views.iter().any(|view| {
            view.id.as_deref() == Some("booking_calendar")
                && view.view_type == super::super::blueprint::ViewType::Calendar
        }));
    }

    #[test]
    fn manage_room_select_recommends_lookup_extraction() {
        let plan = plan_request(
            "mi crei una vista per gestire i nomi delle sale e la colleghi alla select della sala",
            Some("prenotazione-sale-riunioni"),
        );

        assert_eq!(plan.intent, PlanIntent::StructuralModification);
        assert!(!plan.should_ask_before_building());
        assert_eq!(plan.recommended_tools[0].tool, "extract_lookup_entity");
        assert!(plan.fields.iter().any(|field| {
            field.entity == "booking"
                && field.field == "room_id"
                && field.classification == FieldClassification::Relation
        }));
    }

    #[test]
    fn ticket_plan_classifies_status_as_workflow_state() {
        let plan = plan_request("Crea un'app per ticket interni", None);

        assert_eq!(plan.intent, PlanIntent::CreateApp);
        assert!(plan.views.contains(&"kanban".to_string()));
        assert!(plan.fields.iter().any(|field| {
            field.entity == "ticket"
                && field.field == "status"
                && field.classification == FieldClassification::WorkflowState
        }));
    }

    #[test]
    fn leave_plan_keeps_status_out_of_user_input() {
        let plan = plan_request("Crea un'app per ferie e permessi", None);

        assert!(plan.should_ask_before_building());
        assert!(plan.fields.iter().any(|field| {
            field.entity == "leave_request"
                && field.field == "status"
                && field.classification == FieldClassification::WorkflowState
        }));
        assert!(plan.fields.iter().all(|field| {
            !(field.field == "status" && field.classification == FieldClassification::UserInput)
        }));
    }
}

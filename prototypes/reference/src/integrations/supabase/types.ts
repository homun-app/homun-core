export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      bots: {
        Row: {
          created_at: string
          created_by: string
          id: string
          instructions: string | null
          name: string
          project_id: string
          status: Database["public"]["Enums"]["bot_status"]
          subtitle: string | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          instructions?: string | null
          name: string
          project_id: string
          status?: Database["public"]["Enums"]["bot_status"]
          subtitle?: string | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          instructions?: string | null
          name?: string
          project_id?: string
          status?: Database["public"]["Enums"]["bot_status"]
          subtitle?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "bots_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      competitors: {
        Row: {
          created_at: string
          created_by: string
          id: string
          last_checked_at: string | null
          name: string
          notes: string | null
          project_id: string
          url: string
        }
        Insert: {
          created_at?: string
          created_by: string
          id?: string
          last_checked_at?: string | null
          name: string
          notes?: string | null
          project_id: string
          url: string
        }
        Update: {
          created_at?: string
          created_by?: string
          id?: string
          last_checked_at?: string | null
          name?: string
          notes?: string | null
          project_id?: string
          url?: string
        }
        Relationships: [
          {
            foreignKeyName: "competitors_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      conversations: {
        Row: {
          bot_id: string | null
          created_at: string
          created_by: string
          id: string
          project_id: string
          title: string
          updated_at: string
        }
        Insert: {
          bot_id?: string | null
          created_at?: string
          created_by: string
          id?: string
          project_id: string
          title?: string
          updated_at?: string
        }
        Update: {
          bot_id?: string | null
          created_at?: string
          created_by?: string
          id?: string
          project_id?: string
          title?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "conversations_bot_id_fkey"
            columns: ["bot_id"]
            isOneToOne: false
            referencedRelation: "bots"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "conversations_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      dashboard_widgets: {
        Row: {
          created_at: string
          id: string
          position: number
          project_id: string
          user_id: string
          widget_key: string
        }
        Insert: {
          created_at?: string
          id?: string
          position?: number
          project_id: string
          user_id: string
          widget_key: string
        }
        Update: {
          created_at?: string
          id?: string
          position?: number
          project_id?: string
          user_id?: string
          widget_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "dashboard_widgets_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      job_locks: {
        Row: {
          key: string
          locked_until: string
          pause_reason: string | null
          paused: boolean
          updated_at: string
        }
        Insert: {
          key: string
          locked_until: string
          pause_reason?: string | null
          paused?: boolean
          updated_at?: string
        }
        Update: {
          key?: string
          locked_until?: string
          pause_reason?: string | null
          paused?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      messages: {
        Row: {
          conversation_id: string
          created_at: string
          external_id: string | null
          id: string
          parts: Json
          role: string
        }
        Insert: {
          conversation_id: string
          created_at?: string
          external_id?: string | null
          id?: string
          parts?: Json
          role: string
        }
        Update: {
          conversation_id?: string
          created_at?: string
          external_id?: string | null
          id?: string
          parts?: Json
          role?: string
        }
        Relationships: [
          {
            foreignKeyName: "messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      monitor_findings: {
        Row: {
          competitor_id: string | null
          detected_at: string
          id: string
          project_id: string
          severity: string
          source_url: string | null
          summary: string | null
          title: string
        }
        Insert: {
          competitor_id?: string | null
          detected_at?: string
          id?: string
          project_id: string
          severity?: string
          source_url?: string | null
          summary?: string | null
          title: string
        }
        Update: {
          competitor_id?: string | null
          detected_at?: string
          id?: string
          project_id?: string
          severity?: string
          source_url?: string | null
          summary?: string | null
          title?: string
        }
        Relationships: [
          {
            foreignKeyName: "monitor_findings_competitor_id_fkey"
            columns: ["competitor_id"]
            isOneToOne: false
            referencedRelation: "competitors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "monitor_findings_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      org_members: {
        Row: {
          created_at: string
          id: string
          invited_email: string | null
          org_id: string
          role: Database["public"]["Enums"]["member_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          invited_email?: string | null
          org_id: string
          role?: Database["public"]["Enums"]["member_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          invited_email?: string | null
          org_id?: string
          role?: Database["public"]["Enums"]["member_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "org_members_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      organizations: {
        Row: {
          created_at: string
          id: string
          name: string
          owner_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          owner_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          owner_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      pipeline_runs: {
        Row: {
          error: string | null
          finished_at: string | null
          id: string
          pipeline_id: string
          started_at: string
          status: Database["public"]["Enums"]["run_status"]
          trigger_summary: string | null
        }
        Insert: {
          error?: string | null
          finished_at?: string | null
          id?: string
          pipeline_id: string
          started_at?: string
          status?: Database["public"]["Enums"]["run_status"]
          trigger_summary?: string | null
        }
        Update: {
          error?: string | null
          finished_at?: string | null
          id?: string
          pipeline_id?: string
          started_at?: string
          status?: Database["public"]["Enums"]["run_status"]
          trigger_summary?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pipeline_runs_pipeline_id_fkey"
            columns: ["pipeline_id"]
            isOneToOne: false
            referencedRelation: "pipelines"
            referencedColumns: ["id"]
          },
        ]
      }
      pipeline_steps: {
        Row: {
          action_key: string
          config: Json
          created_at: string
          id: string
          label: string | null
          pipeline_id: string
          plugin_id: string
          position: number
        }
        Insert: {
          action_key: string
          config?: Json
          created_at?: string
          id?: string
          label?: string | null
          pipeline_id: string
          plugin_id: string
          position?: number
        }
        Update: {
          action_key?: string
          config?: Json
          created_at?: string
          id?: string
          label?: string | null
          pipeline_id?: string
          plugin_id?: string
          position?: number
        }
        Relationships: [
          {
            foreignKeyName: "pipeline_steps_pipeline_id_fkey"
            columns: ["pipeline_id"]
            isOneToOne: false
            referencedRelation: "pipelines"
            referencedColumns: ["id"]
          },
        ]
      }
      pipelines: {
        Row: {
          active: boolean
          created_at: string
          created_by: string
          description: string | null
          id: string
          last_run_at: string | null
          name: string
          paused_reason: string | null
          project_id: string
          trigger_config: Json
          trigger_key: string | null
          trigger_plugin: string | null
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          created_by: string
          description?: string | null
          id?: string
          last_run_at?: string | null
          name: string
          paused_reason?: string | null
          project_id: string
          trigger_config?: Json
          trigger_key?: string | null
          trigger_plugin?: string | null
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          created_by?: string
          description?: string | null
          id?: string
          last_run_at?: string | null
          name?: string
          paused_reason?: string | null
          project_id?: string
          trigger_config?: Json
          trigger_key?: string | null
          trigger_plugin?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pipelines_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      plugin_installations: {
        Row: {
          connected: boolean
          created_at: string
          id: string
          installed_by: string
          plugin_id: string
          project_id: string
          settings: Json
          updated_at: string
        }
        Insert: {
          connected?: boolean
          created_at?: string
          id?: string
          installed_by: string
          plugin_id: string
          project_id: string
          settings?: Json
          updated_at?: string
        }
        Update: {
          connected?: boolean
          created_at?: string
          id?: string
          installed_by?: string
          plugin_id?: string
          project_id?: string
          settings?: Json
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "plugin_installations_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          avatar_url: string | null
          created_at: string
          full_name: string | null
          id: string
          updated_at: string
        }
        Insert: {
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id: string
          updated_at?: string
        }
        Update: {
          avatar_url?: string | null
          created_at?: string
          full_name?: string | null
          id?: string
          updated_at?: string
        }
        Relationships: []
      }
      project_members: {
        Row: {
          created_at: string
          id: string
          project_id: string
          role: Database["public"]["Enums"]["member_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          project_id: string
          role?: Database["public"]["Enums"]["member_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          project_id?: string
          role?: Database["public"]["Enums"]["member_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "project_members_project_id_fkey"
            columns: ["project_id"]
            isOneToOne: false
            referencedRelation: "projects"
            referencedColumns: ["id"]
          },
        ]
      }
      projects: {
        Row: {
          created_at: string
          created_by: string
          description: string | null
          id: string
          name: string
          org_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          description?: string | null
          id?: string
          name: string
          org_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          description?: string | null
          id?: string
          name?: string
          org_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "projects_org_id_fkey"
            columns: ["org_id"]
            isOneToOne: false
            referencedRelation: "organizations"
            referencedColumns: ["id"]
          },
        ]
      }
      run_step_logs: {
        Row: {
          created_at: string
          detail: string | null
          id: string
          label: string
          run_id: string
          status: Database["public"]["Enums"]["run_status"]
          step_id: string | null
        }
        Insert: {
          created_at?: string
          detail?: string | null
          id?: string
          label: string
          run_id: string
          status?: Database["public"]["Enums"]["run_status"]
          step_id?: string | null
        }
        Update: {
          created_at?: string
          detail?: string | null
          id?: string
          label?: string
          run_id?: string
          status?: Database["public"]["Enums"]["run_status"]
          step_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "run_step_logs_run_id_fkey"
            columns: ["run_id"]
            isOneToOne: false
            referencedRelation: "pipeline_runs"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      can_manage_project: { Args: { _project: string }; Returns: boolean }
      can_see_project: { Args: { _project: string }; Returns: boolean }
      can_write_project: { Args: { _project: string }; Returns: boolean }
      is_org_member: { Args: { _org: string }; Returns: boolean }
      org_role_of: {
        Args: { _org: string }
        Returns: Database["public"]["Enums"]["member_role"]
      }
      project_role_of: {
        Args: { _project: string }
        Returns: Database["public"]["Enums"]["member_role"]
      }
    }
    Enums: {
      bot_status: "attivo" | "in_pausa" | "in_attesa"
      member_role: "titolare" | "gestore" | "collaboratore" | "ospite"
      run_status:
        | "in_attesa"
        | "in_corso"
        | "completato"
        | "errore"
        | "in_pausa"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends (DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never) = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends (DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never) = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends (PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never) = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      bot_status: ["attivo", "in_pausa", "in_attesa"],
      member_role: ["titolare", "gestore", "collaboratore", "ospite"],
      run_status: ["in_attesa", "in_corso", "completato", "errore", "in_pausa"],
    },
  },
} as const

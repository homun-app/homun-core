-- ENUMS
CREATE TYPE public.member_role AS ENUM ('titolare','gestore','collaboratore','ospite');
CREATE TYPE public.run_status AS ENUM ('in_attesa','in_corso','completato','errore','in_pausa');
CREATE TYPE public.bot_status AS ENUM ('attivo','in_pausa','in_attesa');

CREATE OR REPLACE FUNCTION public.set_updated_at() RETURNS TRIGGER AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END; $$ LANGUAGE plpgsql SET search_path = public;

-- PROFILES
CREATE TABLE public.profiles (
  id uuid PRIMARY KEY,
  full_name text,
  avatar_url text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE ON public.profiles TO authenticated;
GRANT ALL ON public.profiles TO service_role;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- ORGANIZATIONS
CREATE TABLE public.organizations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  owner_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.organizations TO authenticated;
GRANT ALL ON public.organizations TO service_role;
ALTER TABLE public.organizations ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.org_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role public.member_role NOT NULL DEFAULT 'collaboratore',
  invited_email text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, user_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.org_members TO authenticated;
GRANT ALL ON public.org_members TO service_role;
ALTER TABLE public.org_members ENABLE ROW LEVEL SECURITY;

-- PROJECTS
CREATE TABLE public.projects (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.projects TO authenticated;
GRANT ALL ON public.projects TO service_role;
ALTER TABLE public.projects ENABLE ROW LEVEL SECURITY;

CREATE TABLE public.project_members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  role public.member_role NOT NULL DEFAULT 'collaboratore',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, user_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.project_members TO authenticated;
GRANT ALL ON public.project_members TO service_role;
ALTER TABLE public.project_members ENABLE ROW LEVEL SECURITY;

-- HELPER FUNCTIONS (security definer, avoid RLS recursion)
CREATE OR REPLACE FUNCTION public.is_org_member(_org uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.org_members WHERE org_id = _org AND user_id = auth.uid());
$$;

CREATE OR REPLACE FUNCTION public.org_role_of(_org uuid)
RETURNS public.member_role LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT role FROM public.org_members WHERE org_id = _org AND user_id = auth.uid();
$$;

CREATE OR REPLACE FUNCTION public.can_see_project(_project uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (SELECT 1 FROM public.project_members WHERE project_id = _project AND user_id = auth.uid())
      OR EXISTS (SELECT 1 FROM public.projects p JOIN public.org_members m ON m.org_id = p.org_id
                 WHERE p.id = _project AND m.user_id = auth.uid() AND m.role = 'titolare');
$$;

CREATE OR REPLACE FUNCTION public.project_role_of(_project uuid)
RETURNS public.member_role LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT COALESCE(
    (SELECT role FROM public.project_members WHERE project_id = _project AND user_id = auth.uid()),
    (SELECT m.role FROM public.projects p JOIN public.org_members m ON m.org_id = p.org_id
      WHERE p.id = _project AND m.user_id = auth.uid() AND m.role = 'titolare')
  );
$$;

CREATE OR REPLACE FUNCTION public.can_manage_project(_project uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.project_role_of(_project) IN ('titolare','gestore');
$$;

CREATE OR REPLACE FUNCTION public.can_write_project(_project uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT public.project_role_of(_project) IN ('titolare','gestore','collaboratore');
$$;

-- POLICIES: profiles
CREATE POLICY "profili leggibili" ON public.profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "profilo proprio insert" ON public.profiles FOR INSERT TO authenticated WITH CHECK (id = auth.uid());
CREATE POLICY "profilo proprio update" ON public.profiles FOR UPDATE TO authenticated USING (id = auth.uid());

-- POLICIES: organizations
CREATE POLICY "org visibili ai membri" ON public.organizations FOR SELECT TO authenticated USING (public.is_org_member(id) OR owner_id = auth.uid());
CREATE POLICY "org create" ON public.organizations FOR INSERT TO authenticated WITH CHECK (owner_id = auth.uid());
CREATE POLICY "org update titolare" ON public.organizations FOR UPDATE TO authenticated USING (public.org_role_of(id) = 'titolare' OR owner_id = auth.uid());
CREATE POLICY "org delete titolare" ON public.organizations FOR DELETE TO authenticated USING (owner_id = auth.uid());

-- POLICIES: org_members
CREATE POLICY "membri org visibili" ON public.org_members FOR SELECT TO authenticated USING (public.is_org_member(org_id));
CREATE POLICY "membri org insert" ON public.org_members FOR INSERT TO authenticated
  WITH CHECK (user_id = auth.uid() OR public.org_role_of(org_id) = 'titolare');
CREATE POLICY "membri org update" ON public.org_members FOR UPDATE TO authenticated USING (public.org_role_of(org_id) = 'titolare');
CREATE POLICY "membri org delete" ON public.org_members FOR DELETE TO authenticated USING (public.org_role_of(org_id) = 'titolare');

-- POLICIES: projects
CREATE POLICY "progetti visibili" ON public.projects FOR SELECT TO authenticated USING (public.can_see_project(id));
CREATE POLICY "progetti insert" ON public.projects FOR INSERT TO authenticated
  WITH CHECK (created_by = auth.uid() AND public.org_role_of(org_id) IN ('titolare','gestore'));
CREATE POLICY "progetti update" ON public.projects FOR UPDATE TO authenticated USING (public.can_manage_project(id));
CREATE POLICY "progetti delete" ON public.projects FOR DELETE TO authenticated USING (public.project_role_of(id) = 'titolare');

-- POLICIES: project_members
CREATE POLICY "membri progetto visibili" ON public.project_members FOR SELECT TO authenticated USING (public.can_see_project(project_id));
CREATE POLICY "membri progetto insert" ON public.project_members FOR INSERT TO authenticated
  WITH CHECK (public.can_manage_project(project_id) OR user_id = auth.uid());
CREATE POLICY "membri progetto update" ON public.project_members FOR UPDATE TO authenticated USING (public.can_manage_project(project_id));
CREATE POLICY "membri progetto delete" ON public.project_members FOR DELETE TO authenticated USING (public.can_manage_project(project_id));

-- BOTS
CREATE TABLE public.bots (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  subtitle text,
  instructions text,
  status public.bot_status NOT NULL DEFAULT 'attivo',
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bots TO authenticated;
GRANT ALL ON public.bots TO service_role;
ALTER TABLE public.bots ENABLE ROW LEVEL SECURITY;
CREATE POLICY "bot visibili" ON public.bots FOR SELECT TO authenticated USING (public.can_see_project(project_id));
CREATE POLICY "bot insert" ON public.bots FOR INSERT TO authenticated WITH CHECK (public.can_manage_project(project_id) AND created_by = auth.uid());
CREATE POLICY "bot update" ON public.bots FOR UPDATE TO authenticated USING (public.can_manage_project(project_id));
CREATE POLICY "bot delete" ON public.bots FOR DELETE TO authenticated USING (public.can_manage_project(project_id));

-- PLUGIN INSTALLATIONS
CREATE TABLE public.plugin_installations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  plugin_id text NOT NULL,
  connected boolean NOT NULL DEFAULT false,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  installed_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, plugin_id)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.plugin_installations TO authenticated;
GRANT ALL ON public.plugin_installations TO service_role;
ALTER TABLE public.plugin_installations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "plugin visibili" ON public.plugin_installations FOR SELECT TO authenticated USING (public.can_see_project(project_id));
CREATE POLICY "plugin insert" ON public.plugin_installations FOR INSERT TO authenticated WITH CHECK (public.can_manage_project(project_id) AND installed_by = auth.uid());
CREATE POLICY "plugin update" ON public.plugin_installations FOR UPDATE TO authenticated USING (public.can_manage_project(project_id));
CREATE POLICY "plugin delete" ON public.plugin_installations FOR DELETE TO authenticated USING (public.can_manage_project(project_id));

-- CONVERSATIONS
CREATE TABLE public.conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  bot_id uuid REFERENCES public.bots(id) ON DELETE SET NULL,
  title text NOT NULL DEFAULT 'Nuova conversazione',
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversations TO authenticated;
GRANT ALL ON public.conversations TO service_role;
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "chat visibili" ON public.conversations FOR SELECT TO authenticated USING (public.can_see_project(project_id));
CREATE POLICY "chat insert" ON public.conversations FOR INSERT TO authenticated WITH CHECK (public.can_write_project(project_id) AND created_by = auth.uid());
CREATE POLICY "chat update" ON public.conversations FOR UPDATE TO authenticated USING (public.can_write_project(project_id));
CREATE POLICY "chat delete" ON public.conversations FOR DELETE TO authenticated USING (public.can_write_project(project_id));

CREATE TABLE public.messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  external_id text,
  role text NOT NULL,
  parts jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX messages_conversation_idx ON public.messages(conversation_id, created_at);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.messages TO authenticated;
GRANT ALL ON public.messages TO service_role;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "messaggi visibili" ON public.messages FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = conversation_id AND public.can_see_project(c.project_id)));
CREATE POLICY "messaggi insert" ON public.messages FOR INSERT TO authenticated
  WITH CHECK (EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = conversation_id AND public.can_write_project(c.project_id)));
CREATE POLICY "messaggi delete" ON public.messages FOR DELETE TO authenticated
  USING (EXISTS (SELECT 1 FROM public.conversations c WHERE c.id = conversation_id AND public.can_write_project(c.project_id)));

-- PIPELINES
CREATE TABLE public.pipelines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  trigger_plugin text,
  trigger_key text,
  trigger_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT false,
  paused_reason text,
  last_run_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pipelines TO authenticated;
GRANT ALL ON public.pipelines TO service_role;
ALTER TABLE public.pipelines ENABLE ROW LEVEL SECURITY;
CREATE POLICY "pipeline visibili" ON public.pipelines FOR SELECT TO authenticated USING (public.can_see_project(project_id));
CREATE POLICY "pipeline insert" ON public.pipelines FOR INSERT TO authenticated WITH CHECK (public.can_manage_project(project_id) AND created_by = auth.uid());
CREATE POLICY "pipeline update" ON public.pipelines FOR UPDATE TO authenticated USING (public.can_manage_project(project_id));
CREATE POLICY "pipeline delete" ON public.pipelines FOR DELETE TO authenticated USING (public.can_manage_project(project_id));

CREATE TABLE public.pipeline_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid NOT NULL REFERENCES public.pipelines(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0,
  plugin_id text NOT NULL,
  action_key text NOT NULL,
  label text,
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.pipeline_steps TO authenticated;
GRANT ALL ON public.pipeline_steps TO service_role;
ALTER TABLE public.pipeline_steps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "passaggi visibili" ON public.pipeline_steps FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.pipelines p WHERE p.id = pipeline_id AND public.can_see_project(p.project_id)));
CREATE POLICY "passaggi write" ON public.pipeline_steps FOR ALL TO authenticated
  USING (EXISTS (SELECT 1 FROM public.pipelines p WHERE p.id = pipeline_id AND public.can_manage_project(p.project_id)))
  WITH CHECK (EXISTS (SELECT 1 FROM public.pipelines p WHERE p.id = pipeline_id AND public.can_manage_project(p.project_id)));

CREATE TABLE public.pipeline_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  pipeline_id uuid NOT NULL REFERENCES public.pipelines(id) ON DELETE CASCADE,
  status public.run_status NOT NULL DEFAULT 'in_attesa',
  trigger_summary text,
  error text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
GRANT SELECT, INSERT, UPDATE ON public.pipeline_runs TO authenticated;
GRANT ALL ON public.pipeline_runs TO service_role;
ALTER TABLE public.pipeline_runs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "esecuzioni visibili" ON public.pipeline_runs FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.pipelines p WHERE p.id = pipeline_id AND public.can_see_project(p.project_id)));

CREATE TABLE public.run_step_logs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES public.pipeline_runs(id) ON DELETE CASCADE,
  step_id uuid,
  label text NOT NULL,
  status public.run_status NOT NULL DEFAULT 'completato',
  detail text,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.run_step_logs TO authenticated;
GRANT ALL ON public.run_step_logs TO service_role;
ALTER TABLE public.run_step_logs ENABLE ROW LEVEL SECURITY;
CREATE POLICY "log visibili" ON public.run_step_logs FOR SELECT TO authenticated
  USING (EXISTS (SELECT 1 FROM public.pipeline_runs r JOIN public.pipelines p ON p.id = r.pipeline_id
                 WHERE r.id = run_id AND public.can_see_project(p.project_id)));

-- DASHBOARD WIDGETS
CREATE TABLE public.dashboard_widgets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  widget_key text NOT NULL,
  position integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, user_id, widget_key)
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.dashboard_widgets TO authenticated;
GRANT ALL ON public.dashboard_widgets TO service_role;
ALTER TABLE public.dashboard_widgets ENABLE ROW LEVEL SECURITY;
CREATE POLICY "riquadri propri" ON public.dashboard_widgets FOR ALL TO authenticated
  USING (user_id = auth.uid() AND public.can_see_project(project_id))
  WITH CHECK (user_id = auth.uid() AND public.can_see_project(project_id));

-- PLUGIN DATA: competitors
CREATE TABLE public.competitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  url text NOT NULL,
  notes text,
  last_checked_at timestamptz,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.competitors TO authenticated;
GRANT ALL ON public.competitors TO service_role;
ALTER TABLE public.competitors ENABLE ROW LEVEL SECURITY;
CREATE POLICY "concorrenti visibili" ON public.competitors FOR SELECT TO authenticated USING (public.can_see_project(project_id));
CREATE POLICY "concorrenti write" ON public.competitors FOR ALL TO authenticated
  USING (public.can_write_project(project_id)) WITH CHECK (public.can_write_project(project_id));

CREATE TABLE public.monitor_findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES public.projects(id) ON DELETE CASCADE,
  competitor_id uuid REFERENCES public.competitors(id) ON DELETE CASCADE,
  title text NOT NULL,
  summary text,
  source_url text,
  severity text NOT NULL DEFAULT 'info',
  detected_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT ON public.monitor_findings TO authenticated;
GRANT ALL ON public.monitor_findings TO service_role;
ALTER TABLE public.monitor_findings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "rilevazioni visibili" ON public.monitor_findings FOR SELECT TO authenticated USING (public.can_see_project(project_id));

-- JOB LOCKS (single flight for scheduled work)
CREATE TABLE public.job_locks (
  key text PRIMARY KEY,
  locked_until timestamptz NOT NULL,
  paused boolean NOT NULL DEFAULT false,
  pause_reason text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT ALL ON public.job_locks TO service_role;
ALTER TABLE public.job_locks ENABLE ROW LEVEL SECURITY;

-- TRIGGERS updated_at
CREATE TRIGGER t_profiles_updated BEFORE UPDATE ON public.profiles FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER t_org_updated BEFORE UPDATE ON public.organizations FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER t_projects_updated BEFORE UPDATE ON public.projects FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER t_bots_updated BEFORE UPDATE ON public.bots FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER t_plugins_updated BEFORE UPDATE ON public.plugin_installations FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER t_conv_updated BEFORE UPDATE ON public.conversations FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();
CREATE TRIGGER t_pipe_updated BEFORE UPDATE ON public.pipelines FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- NEW USER: profile + personal organization + first project
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE _org uuid; _proj uuid;
BEGIN
  INSERT INTO public.profiles (id, full_name)
  VALUES (NEW.id, COALESCE(NEW.raw_user_meta_data->>'full_name', NEW.raw_user_meta_data->>'name', split_part(NEW.email,'@',1)))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.organizations (name, owner_id)
  VALUES (COALESCE(NEW.raw_user_meta_data->>'company_name', 'La mia azienda'), NEW.id)
  RETURNING id INTO _org;

  INSERT INTO public.org_members (org_id, user_id, role) VALUES (_org, NEW.id, 'titolare');

  INSERT INTO public.projects (org_id, name, description, created_by)
  VALUES (_org, 'Progetto principale', 'Il tuo primo spazio di lavoro', NEW.id)
  RETURNING id INTO _proj;

  INSERT INTO public.project_members (project_id, user_id, role) VALUES (_proj, NEW.id, 'titolare');

  INSERT INTO public.bots (project_id, name, subtitle, instructions, created_by)
  VALUES (_proj, 'Assistente', 'Il tuo assistente generico', 'Sei un assistente operativo per una piccola azienda italiana. Rispondi in italiano, in modo semplice e concreto.', NEW.id);

  INSERT INTO public.dashboard_widgets (project_id, user_id, widget_key, position)
  VALUES (_proj, NEW.id, 'bots_attivi', 0), (_proj, NEW.id, 'pipeline_in_corso', 1);

  RETURN NEW;
END; $$;

CREATE TRIGGER on_auth_user_created AFTER INSERT ON auth.users
FOR EACH ROW EXECUTE FUNCTION public.handle_new_user();
-- Wrap auth.* calls in scalar subqueries across 50 RLS policies (#1482).
-- supabase advisor: auth_rls_initplan. A bare auth.uid()/auth.role() in a
-- policy is re-evaluated per row; wrapping it as (select auth.uid()) lets the
-- planner evaluate it once per query (initplan), a large win at scale. The
-- value is unchanged — auth.uid()/auth.role() are stable within a statement —
-- so policy semantics are identical; only the call form changes.
--
-- Each policy is DROP + CREATE'd with its current definition, with every bare
-- auth.uid()/auth.role() rewritten to (select auth.<fn>()). Generated from live
-- pg_policy definitions; verified the advisor clears and the only snapshot delta
-- is the subquery wrapping (no semantic change).

DROP POLICY IF EXISTS ai_batch_jobs_service_role_all ON public.ai_batch_jobs;
CREATE POLICY ai_batch_jobs_service_role_all ON public.ai_batch_jobs FOR ALL TO PUBLIC
  USING (((select auth.role()) = 'service_role'::text))
  WITH CHECK (((select auth.role()) = 'service_role'::text));

DROP POLICY IF EXISTS ai_batch_requests_service_role_all ON public.ai_batch_requests;
CREATE POLICY ai_batch_requests_service_role_all ON public.ai_batch_requests FOR ALL TO PUBLIC
  USING (((select auth.role()) = 'service_role'::text))
  WITH CHECK (((select auth.role()) = 'service_role'::text));

DROP POLICY IF EXISTS ai_kill_switch_state_select_policy ON public.ai_kill_switch_state;
CREATE POLICY ai_kill_switch_state_select_policy ON public.ai_kill_switch_state FOR SELECT TO PUBLIC
  USING (((select auth.uid()) IS NOT NULL));

DROP POLICY IF EXISTS audit_log_select_in_tenant ON public.audit_log;
CREATE POLICY audit_log_select_in_tenant ON public.audit_log FOR SELECT TO PUBLIC
  USING ((((select auth.uid()) IS NOT NULL) AND (tenant_id IS NOT NULL) AND auth_user_in_tenant(tenant_id)));

DROP POLICY IF EXISTS bug_submissions_select ON public.bug_submissions;
CREATE POLICY bug_submissions_select ON public.bug_submissions FOR SELECT TO PUBLIC
  USING (((submitter_user_id IN ( SELECT users.id
   FROM users
  WHERE (users.auth_user_id = (select auth.uid())))) OR auth_user_in_tenant(tenant_id)));

DROP POLICY IF EXISTS canonical_match_reviews_platform_admin_read ON public.canonical_match_reviews;
CREATE POLICY canonical_match_reviews_platform_admin_read ON public.canonical_match_reviews FOR SELECT TO PUBLIC
  USING ((EXISTS ( SELECT 1
   FROM platform_admins
  WHERE (platform_admins.auth_user_id = (select auth.uid())))));

DROP POLICY IF EXISTS canonical_match_reviews_platform_admin_update ON public.canonical_match_reviews;
CREATE POLICY canonical_match_reviews_platform_admin_update ON public.canonical_match_reviews FOR UPDATE TO PUBLIC
  USING ((EXISTS ( SELECT 1
   FROM platform_admins
  WHERE (platform_admins.auth_user_id = (select auth.uid())))));

DROP POLICY IF EXISTS conversations_insert_policy ON public.conversations;
CREATE POLICY conversations_insert_policy ON public.conversations FOR INSERT TO PUBLIC
  WITH CHECK ((auth_user_in_tenant(tenant_id) AND tenant_is_active(tenant_id) AND (user_id = ( SELECT u.id
   FROM users u
  WHERE ((u.auth_user_id = (select auth.uid())) AND (u.tenant_id = conversations.tenant_id) AND (u.status = 'active'::text))))));

DROP POLICY IF EXISTS cruise_line_aliases_read ON public.cruise_line_aliases;
CREATE POLICY cruise_line_aliases_read ON public.cruise_line_aliases FOR SELECT TO PUBLIC
  USING (((select auth.uid()) IS NOT NULL));

DROP POLICY IF EXISTS cruise_lines_read ON public.cruise_lines;
CREATE POLICY cruise_lines_read ON public.cruise_lines FOR SELECT TO PUBLIC
  USING (((select auth.uid()) IS NOT NULL));

DROP POLICY IF EXISTS cruise_sailings_read ON public.cruise_sailings;
CREATE POLICY cruise_sailings_read ON public.cruise_sailings FOR SELECT TO PUBLIC
  USING (((select auth.uid()) IS NOT NULL));

DROP POLICY IF EXISTS cruise_ship_aliases_read ON public.cruise_ship_aliases;
CREATE POLICY cruise_ship_aliases_read ON public.cruise_ship_aliases FOR SELECT TO PUBLIC
  USING (((select auth.uid()) IS NOT NULL));

DROP POLICY IF EXISTS cruise_ships_read ON public.cruise_ships;
CREATE POLICY cruise_ships_read ON public.cruise_ships FOR SELECT TO PUBLIC
  USING (((select auth.uid()) IS NOT NULL));

DROP POLICY IF EXISTS customer_chat_counters_select_own ON public.customer_chat_counters;
CREATE POLICY customer_chat_counters_select_own ON public.customer_chat_counters FOR SELECT TO PUBLIC
  USING ((user_id = (select auth.uid())));

DROP POLICY IF EXISTS email_log_select ON public.email_log;
CREATE POLICY email_log_select ON public.email_log FOR SELECT TO PUBLIC
  USING ((((select auth.uid()) IS NOT NULL) AND (tenant_id IN ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = (select auth.uid()))))));

DROP POLICY IF EXISTS email_suppressions_select ON public.email_suppressions;
CREATE POLICY email_suppressions_select ON public.email_suppressions FOR SELECT TO PUBLIC
  USING ((((select auth.uid()) IS NOT NULL) AND (tenant_id IN ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = (select auth.uid()))))));

DROP POLICY IF EXISTS feature_requests_select ON public.feature_requests;
CREATE POLICY feature_requests_select ON public.feature_requests FOR SELECT TO PUBLIC
  USING (((submitter_user_id IN ( SELECT users.id
   FROM users
  WHERE (users.auth_user_id = (select auth.uid())))) OR auth_user_in_tenant(tenant_id)));

DROP POLICY IF EXISTS forum_messages_select ON public.forum_messages;
CREATE POLICY forum_messages_select ON public.forum_messages FOR SELECT TO PUBLIC
  USING ((auth_user_in_tenant(tenant_id) AND ((status = 'visible'::text) OR (user_id IN ( SELECT users.id
   FROM users
  WHERE (users.auth_user_id = (select auth.uid())))))));

DROP POLICY IF EXISTS forum_reactions_delete ON public.forum_reactions;
CREATE POLICY forum_reactions_delete ON public.forum_reactions FOR DELETE TO PUBLIC
  USING ((auth_user_in_tenant(tenant_id) AND (user_id IN ( SELECT users.id
   FROM users
  WHERE (users.auth_user_id = (select auth.uid()))))));

DROP POLICY IF EXISTS general_pricing_ranges_select ON public.general_pricing_ranges;
CREATE POLICY general_pricing_ranges_select ON public.general_pricing_ranges FOR SELECT TO PUBLIC
  USING (((select auth.uid()) IS NOT NULL));

DROP POLICY IF EXISTS groups_insert ON public.groups;
CREATE POLICY groups_insert ON public.groups FOR INSERT TO PUBLIC
  WITH CHECK ((tenant_id IN ( SELECT users.tenant_id
   FROM users
  WHERE (users.auth_user_id = (select auth.uid())))));

DROP POLICY IF EXISTS groups_select ON public.groups;
CREATE POLICY groups_select ON public.groups FOR SELECT TO PUBLIC
  USING ((tenant_id IN ( SELECT users.tenant_id
   FROM users
  WHERE (users.auth_user_id = (select auth.uid())))));

DROP POLICY IF EXISTS groups_update ON public.groups;
CREATE POLICY groups_update ON public.groups FOR UPDATE TO PUBLIC
  USING ((tenant_id IN ( SELECT users.tenant_id
   FROM users
  WHERE (users.auth_user_id = (select auth.uid())))));

DROP POLICY IF EXISTS host_adapters_select_policy ON public.host_adapters;
CREATE POLICY host_adapters_select_policy ON public.host_adapters FOR SELECT TO PUBLIC
  USING ((((select auth.role()) = 'authenticated'::text) OR ((select auth.role()) = 'service_role'::text)));

DROP POLICY IF EXISTS host_booking_fee_configs_select_policy ON public.host_booking_fee_configs;
CREATE POLICY host_booking_fee_configs_select_policy ON public.host_booking_fee_configs FOR SELECT TO PUBLIC
  USING ((((select auth.role()) = 'authenticated'::text) OR ((select auth.role()) = 'service_role'::text)));

DROP POLICY IF EXISTS invitations_insert ON public.invitations;
CREATE POLICY invitations_insert ON public.invitations FOR INSERT TO PUBLIC
  WITH CHECK ((group_id IN ( SELECT groups.id
   FROM groups
  WHERE (groups.tenant_id IN ( SELECT users.tenant_id
           FROM users
          WHERE (users.auth_user_id = (select auth.uid())))))));

DROP POLICY IF EXISTS invitations_select ON public.invitations;
CREATE POLICY invitations_select ON public.invitations FOR SELECT TO PUBLIC
  USING ((group_id IN ( SELECT groups.id
   FROM groups
  WHERE (groups.tenant_id IN ( SELECT users.tenant_id
           FROM users
          WHERE (users.auth_user_id = (select auth.uid())))))));

DROP POLICY IF EXISTS invitations_update ON public.invitations;
CREATE POLICY invitations_update ON public.invitations FOR UPDATE TO PUBLIC
  USING ((group_id IN ( SELECT groups.id
   FROM groups
  WHERE (groups.tenant_id IN ( SELECT users.tenant_id
           FROM users
          WHERE (users.auth_user_id = (select auth.uid())))))));

DROP POLICY IF EXISTS legal_consents_select ON public.legal_consents;
CREATE POLICY legal_consents_select ON public.legal_consents FOR SELECT TO PUBLIC
  USING ((auth_user_id = (select auth.uid())));

DROP POLICY IF EXISTS legal_documents_select ON public.legal_documents;
CREATE POLICY legal_documents_select ON public.legal_documents FOR SELECT TO PUBLIC
  USING (((select auth.uid()) IS NOT NULL));

DROP POLICY IF EXISTS notifications_own_select ON public.notifications;
CREATE POLICY notifications_own_select ON public.notifications FOR SELECT TO PUBLIC
  USING ((user_id = (select auth.uid())));

DROP POLICY IF EXISTS notifications_own_update ON public.notifications;
CREATE POLICY notifications_own_update ON public.notifications FOR UPDATE TO PUBLIC
  USING ((user_id = (select auth.uid())));

DROP POLICY IF EXISTS persona_addendums_delete ON public.persona_addendums;
CREATE POLICY persona_addendums_delete ON public.persona_addendums FOR DELETE TO PUBLIC
  USING ((tenant_id IN ( SELECT users.tenant_id
   FROM users
  WHERE (users.auth_user_id = (select auth.uid())))));

DROP POLICY IF EXISTS persona_addendums_insert ON public.persona_addendums;
CREATE POLICY persona_addendums_insert ON public.persona_addendums FOR INSERT TO PUBLIC
  WITH CHECK ((tenant_id IN ( SELECT users.tenant_id
   FROM users
  WHERE (users.auth_user_id = (select auth.uid())))));

DROP POLICY IF EXISTS persona_addendums_select ON public.persona_addendums;
CREATE POLICY persona_addendums_select ON public.persona_addendums FOR SELECT TO PUBLIC
  USING ((tenant_id IN ( SELECT users.tenant_id
   FROM users
  WHERE (users.auth_user_id = (select auth.uid())))));

DROP POLICY IF EXISTS persona_addendums_update ON public.persona_addendums;
CREATE POLICY persona_addendums_update ON public.persona_addendums FOR UPDATE TO PUBLIC
  USING ((tenant_id IN ( SELECT users.tenant_id
   FROM users
  WHERE (users.auth_user_id = (select auth.uid())))));

DROP POLICY IF EXISTS persona_safety_config_select_policy ON public.persona_safety_config;
CREATE POLICY persona_safety_config_select_policy ON public.persona_safety_config FOR SELECT TO PUBLIC
  USING (((select auth.uid()) IS NOT NULL));

DROP POLICY IF EXISTS personas_select_policy ON public.personas;
CREATE POLICY personas_select_policy ON public.personas FOR SELECT TO PUBLIC
  USING (((select auth.uid()) IS NOT NULL));

DROP POLICY IF EXISTS platform_settings_select_policy ON public.platform_settings;
CREATE POLICY platform_settings_select_policy ON public.platform_settings FOR SELECT TO PUBLIC
  USING (((select auth.uid()) IS NOT NULL));

DROP POLICY IF EXISTS port_aliases_read ON public.port_aliases;
CREATE POLICY port_aliases_read ON public.port_aliases FOR SELECT TO PUBLIC
  USING (((select auth.uid()) IS NOT NULL));

DROP POLICY IF EXISTS port_info_read ON public.port_info_chunks;
CREATE POLICY port_info_read ON public.port_info_chunks FOR SELECT TO PUBLIC
  USING (((select auth.uid()) IS NOT NULL));

DROP POLICY IF EXISTS ports_read ON public.ports;
CREATE POLICY ports_read ON public.ports FOR SELECT TO PUBLIC
  USING (((select auth.uid()) IS NOT NULL));

DROP POLICY IF EXISTS pce_content_select ON public.pre_cruise_email_content;
CREATE POLICY pce_content_select ON public.pre_cruise_email_content FOR SELECT TO PUBLIC
  USING ((((select auth.uid()) IS NOT NULL) AND (tenant_id IN ( SELECT users.tenant_id
   FROM users
  WHERE (users.id = (select auth.uid()))))));

DROP POLICY IF EXISTS sailing_port_calls_read ON public.sailing_port_calls;
CREATE POLICY sailing_port_calls_read ON public.sailing_port_calls FOR SELECT TO PUBLIC
  USING (((select auth.uid()) IS NOT NULL));

DROP POLICY IF EXISTS tenant_branding_insert ON public.tenant_branding;
CREATE POLICY tenant_branding_insert ON public.tenant_branding FOR INSERT TO PUBLIC
  WITH CHECK ((tenant_id IN ( SELECT users.tenant_id
   FROM users
  WHERE (users.auth_user_id = (select auth.uid())))));

DROP POLICY IF EXISTS tenant_branding_select ON public.tenant_branding;
CREATE POLICY tenant_branding_select ON public.tenant_branding FOR SELECT TO PUBLIC
  USING ((tenant_id IN ( SELECT users.tenant_id
   FROM users
  WHERE (users.auth_user_id = (select auth.uid())))));

DROP POLICY IF EXISTS tenant_branding_update ON public.tenant_branding;
CREATE POLICY tenant_branding_update ON public.tenant_branding FOR UPDATE TO PUBLIC
  USING ((tenant_id IN ( SELECT users.tenant_id
   FROM users
  WHERE (users.auth_user_id = (select auth.uid())))));

DROP POLICY IF EXISTS user_consent_pending_select ON public.user_consent_pending;
CREATE POLICY user_consent_pending_select ON public.user_consent_pending FOR SELECT TO PUBLIC
  USING ((auth_user_id = (select auth.uid())));

DROP POLICY IF EXISTS user_data_export_insert ON public.user_data_export_requests;
CREATE POLICY user_data_export_insert ON public.user_data_export_requests FOR INSERT TO PUBLIC
  WITH CHECK ((auth_user_id = (select auth.uid())));

DROP POLICY IF EXISTS user_data_export_select ON public.user_data_export_requests;
CREATE POLICY user_data_export_select ON public.user_data_export_requests FOR SELECT TO PUBLIC
  USING ((auth_user_id = (select auth.uid())));


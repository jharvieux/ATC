-- Merge duplicate permissive SELECT policies on bug_submissions and feature_requests.
-- Postgres OR-combines multiple permissive policies per row; one merged policy
-- with an OR condition is semantically identical but evaluated in a single pass.

-- bug_submissions: merge customer_self + tenant_select into one policy
DROP POLICY IF EXISTS "bug_submissions_customer_self" ON public.bug_submissions;
DROP POLICY IF EXISTS "bug_submissions_tenant_select" ON public.bug_submissions;

CREATE POLICY "bug_submissions_select" ON public.bug_submissions
  FOR SELECT TO PUBLIC
  USING (
    (submitter_user_id IN (SELECT users.id FROM public.users WHERE users.auth_user_id = auth.uid()))
    OR auth_user_in_tenant(tenant_id)
  );

-- feature_requests: merge customer_self + tenant_select into one policy
DROP POLICY IF EXISTS "feature_requests_customer_self" ON public.feature_requests;
DROP POLICY IF EXISTS "feature_requests_tenant_select" ON public.feature_requests;

CREATE POLICY "feature_requests_select" ON public.feature_requests
  FOR SELECT TO PUBLIC
  USING (
    (submitter_user_id IN (SELECT users.id FROM public.users WHERE users.auth_user_id = auth.uid()))
    OR auth_user_in_tenant(tenant_id)
  );

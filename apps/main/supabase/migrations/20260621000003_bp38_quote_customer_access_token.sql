-- BP38 §38.4.3 / Q9 follow-up — Customer-facing tokenized URL for
-- multi-option quote selection.
--
-- Adds a customer_access_token to quotes (UNIQUE), populated when the
-- quote transitions draft→sent. The public selection endpoint validates
-- the token without requiring agent auth.

ALTER TABLE public.quotes
  ADD COLUMN IF NOT EXISTS customer_access_token TEXT UNIQUE;

CREATE INDEX IF NOT EXISTS quotes_customer_access_token_idx
  ON public.quotes(customer_access_token)
  WHERE customer_access_token IS NOT NULL;

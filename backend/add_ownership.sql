-- Phase 3: add ownership + portfolio scoping columns to the procurement tables.
-- Cross-schema FKs point at the Prisma-managed rbac.users / rbac.portfolios.
-- Run:  psql -U postgres -d procurement -f backend/add_ownership.sql

BEGIN;

ALTER TABLE public.purchase_requests
  ADD COLUMN IF NOT EXISTS created_by_user_id INT REFERENCES rbac.users(id),
  ADD COLUMN IF NOT EXISTS portfolio_id        INT REFERENCES rbac.portfolios(id);

ALTER TABLE public.purchase_orders
  ADD COLUMN IF NOT EXISTS created_by_user_id INT REFERENCES rbac.users(id),
  ADD COLUMN IF NOT EXISTS portfolio_id        INT REFERENCES rbac.portfolios(id);

ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS created_by_user_id INT REFERENCES rbac.users(id),
  ADD COLUMN IF NOT EXISTS portfolio_id        INT REFERENCES rbac.portfolios(id);

-- Backfill existing rows: attribute them to the Governance user (who sees all
-- data anyway) and the Infrastructure portfolio so scoped roles have valid data.
UPDATE public.purchase_requests
  SET created_by_user_id = (SELECT id FROM rbac.users WHERE email = 'gov@alliance.test'),
      portfolio_id       = (SELECT id FROM rbac.portfolios WHERE key = 'infrastructure')
  WHERE created_by_user_id IS NULL;

UPDATE public.purchase_orders
  SET created_by_user_id = (SELECT id FROM rbac.users WHERE email = 'gov@alliance.test'),
      portfolio_id       = (SELECT id FROM rbac.portfolios WHERE key = 'infrastructure')
  WHERE created_by_user_id IS NULL;

UPDATE public.invoices
  SET created_by_user_id = (SELECT id FROM rbac.users WHERE email = 'gov@alliance.test'),
      portfolio_id       = (SELECT id FROM rbac.portfolios WHERE key = 'infrastructure')
  WHERE created_by_user_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_pr_owner     ON public.purchase_requests(created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_pr_portfolio ON public.purchase_requests(portfolio_id);
CREATE INDEX IF NOT EXISTS idx_po_owner     ON public.purchase_orders(created_by_user_id);
CREATE INDEX IF NOT EXISTS idx_inv_owner    ON public.invoices(created_by_user_id);

COMMIT;

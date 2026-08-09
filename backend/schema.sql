-- PostgreSQL schema for the Procurement portal (PR / PO / Invoice / Budget).
-- Ported from the original SQLite schema in ../server.js.
-- Run with:  psql -U postgres -d procurement -f backend/schema.sql

BEGIN;

-- Drop in reverse dependency order so this file is safe to re-run.
DROP TABLE IF EXISTS audit_logs CASCADE;
DROP TABLE IF EXISTS approval_logs CASCADE;
DROP TABLE IF EXISTS invoices CASCADE;
DROP TABLE IF EXISTS budget_ledger CASCADE;
DROP TABLE IF EXISTS budget_lines CASCADE;
DROP TABLE IF EXISTS vendors CASCADE;
DROP TABLE IF EXISTS purchase_order_milestones CASCADE;
DROP TABLE IF EXISTS purchase_orders CASCADE;
DROP TABLE IF EXISTS purchase_request_fy_allocations CASCADE;
DROP TABLE IF EXISTS purchase_requests CASCADE;

-- Purchase Requests (PR) and Infra Purchase Requests (IPR).
CREATE TABLE purchase_requests (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  number              TEXT NOT NULL UNIQUE,
  request_type        TEXT NOT NULL CHECK (request_type IN ('PR', 'IPR')),
  requester           TEXT NOT NULL,
  company             TEXT NOT NULL,
  financial_year      TEXT NOT NULL,
  function_name       TEXT NOT NULL,
  category            TEXT NOT NULL,
  line_item           TEXT NOT NULL,
  budget_code         TEXT NOT NULL,
  short_text          TEXT NOT NULL,
  amount              NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  remaining_po_amount NUMERIC(15,2) NOT NULL,
  status              TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per financial-year money split for Infra PRs.
CREATE TABLE purchase_request_fy_allocations (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  purchase_request_id BIGINT NOT NULL REFERENCES purchase_requests(id) ON DELETE CASCADE,
  financial_year      TEXT NOT NULL,
  amount              NUMERIC(15,2) NOT NULL CHECK (amount > 0)
);

-- Purchase Orders raised against an approved PR.
CREATE TABLE purchase_orders (
  id                      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  number                  TEXT NOT NULL UNIQUE,
  purchase_request_id     BIGINT NOT NULL REFERENCES purchase_requests(id),
  purchase_request_number TEXT NOT NULL,
  vendor                  TEXT NOT NULL,
  amount                  NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  payment_terms           TEXT,
  negotiation_details     TEXT,
  status                  TEXT NOT NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE purchase_order_milestones (
  id                BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  purchase_order_id BIGINT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  name              TEXT NOT NULL,
  percentage        NUMERIC(15,2),
  amount            NUMERIC(15,2)
);

CREATE TABLE vendors (
  id      BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name    TEXT NOT NULL UNIQUE,
  code    TEXT,
  address TEXT,
  tax_id  TEXT
);

-- Budget available per budget_code + financial_year.
CREATE TABLE budget_lines (
  id               BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  budget_code      TEXT NOT NULL,
  financial_year   TEXT NOT NULL,
  allocated_amount NUMERIC(15,2) NOT NULL,
  used_amount      NUMERIC(15,2) NOT NULL DEFAULT 0,
  UNIQUE (budget_code, financial_year)
);

-- Append-only record of every budget movement.
CREATE TABLE budget_ledger (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  budget_line_id      BIGINT NOT NULL REFERENCES budget_lines(id),
  purchase_request_id BIGINT REFERENCES purchase_requests(id),
  amount              NUMERIC(15,2) NOT NULL,
  entry_type          TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE invoices (
  id                  BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  number              TEXT NOT NULL UNIQUE,
  vendor              TEXT NOT NULL,
  financial_year      TEXT NOT NULL,
  cost_type           TEXT NOT NULL,
  function_name       TEXT NOT NULL,
  category            TEXT NOT NULL,
  line_item           TEXT NOT NULL,
  budget_code         TEXT NOT NULL,
  description         TEXT NOT NULL,
  service_entry_number TEXT NOT NULL,
  invoice_number      TEXT NOT NULL,
  amount              NUMERIC(15,2) NOT NULL CHECK (amount > 0),
  service_period_from TEXT NOT NULL,
  service_period_to   TEXT NOT NULL,
  invoice_date        TEXT NOT NULL,
  status              TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (vendor, invoice_number, invoice_date)
);

CREATE TABLE approval_logs (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id   BIGINT NOT NULL,
  action      TEXT NOT NULL,
  actor       TEXT NOT NULL,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE audit_logs (
  id          BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id   BIGINT NOT NULL,
  action      TEXT NOT NULL,
  details     TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Helpful indexes for the governance/list queries.
CREATE INDEX idx_pr_status ON purchase_requests(status);
CREATE INDEX idx_po_pr ON purchase_orders(purchase_request_id);
CREATE INDEX idx_alloc_pr ON purchase_request_fy_allocations(purchase_request_id);
CREATE INDEX idx_milestone_po ON purchase_order_milestones(purchase_order_id);

COMMIT;

# RBAC Design — PR-PO Digital Portal

Source of truth: **PR-PO Process.pptx** (Persona Access Model slide 71, Access Control Matrix slide 76).

## Roles (4 personas)

| Role | Data scope | Approval authority |
|------|-----------|--------------------|
| **Application Owner** (AO) | `own` — only items they raised | none |
| **Portfolio Lead** (PL) | `portfolio` — everything in their portfolio | PR ₹2.5L–₹25L · Invoice ≤ ₹10L |
| **Governance Team** (GT) | `enterprise` — all data, edit rights (super-admin) | PR ≤ ₹2.5L · masters/users/budget |
| **CDIO** | `enterprise_view` — all data, read-only | PR > ₹25L · Invoice > ₹10L |

Approval thresholds (rupees): `GT ≤ 250000` · `PL 250000–2500000` · `CDIO > 2500000`.
Invoice thresholds: `PL ≤ 1000000` · `CDIO > 1000000`.

## Two enforcement dimensions

1. **Action permission** — can this role perform this action? (`authorize()`)
2. **Data scope** — which rows can they see/act on? (`own` / `portfolio` / `enterprise`)

Both must pass.

## Permissions → API map

| Permission | Endpoints | AO | PL | GT | CDIO |
|-----------|-----------|----|----|----|----|
| `pr:create` | POST /api/pr, /api/infra-pr, /pr/:id/submit | Y | Y | Y | – |
| `pr:read` | GET /governance/prs, /pr/:id | own | portfolio | all | all |
| `pr:approve` (tiered) | POST /pr/:id/approve, /reject | – | 2.5–25L | ≤2.5L | >25L |
| `po:create` | POST /api/po, /po/:id/cancel | Y | – | Y | – |
| `po:approve` | POST /po/:id/approve | – | Y | Y | Y |
| `invoice:create` | POST /api/invoice, /validate-budget, /check-duplicate | – | – | Y | – |
| `invoice:approve` (tiered) | (future) | – | ≤10L | Y | >10L |
| `budget:manage` | (future budget admin) | – | portfolio | Y | Y |
| `governance:view` | GET /governance/dashboard, /pos, /invoices | own | portfolio | all | all |
| `export:generate` | GET /api/export/* | – | portfolio | Y | view |
| `user:manage`, `masters:manage` | (admin routes) | – | – | Y | – |

## Data model (RBAC tables — Prisma)

- `User` (id, name, email, passwordHash, roleId, portfolioId)
- `Role` (id, key, name, scope, prApproveMin, prApproveMax, invApproveMax)
- `Permission` (id, key, description)
- `RolePermission` (roleId, permissionId) — many-to-many join
- `Portfolio` (id, key, name) — e.g. Infrastructure, Marketing, ASG, Infosec, Manufacturing

Existing tables gain `created_by_user_id` and `portfolio_id` for scoping.

## Relationships

- User **N–1** Role, User **N–1** Portfolio.
- Role **M–N** Permission via RolePermission.
- purchase_requests / purchase_orders / invoices **N–1** User (creator) and **N–1** Portfolio.

## Auth flow (JWT)

1. `POST /api/auth/login` → verify email + bcrypt password → sign JWT `{ userId, role, permissions[], scope, portfolioId }`.
2. Client sends `Authorization: Bearer <token>` on every request.
3. `authenticate` verifies token, loads user + role + permissions onto `req.user`.
4. `authorize('pr:approve')` checks permission; `checkApprovalTier` checks amount band; `scopeFilter` restricts rows.

# GatePass — Item Movement Control System

A full-stack system for tracking item movements across branches. Every item leaving a location is tracked, every returnable item is enforced to return, no movement happens without authorization.

> "Nothing moves without record, and nothing is lost without accountability."

---

## Project Structure

```
gatepass/
├── backend/          # Express.js REST API (Node.js)
│   ├── data/db.js    # MongoDB (Atlas) data layer + seed data
│   ├── middleware/   # Auth middleware
│   ├── routes/       # API routes
│   └── server.js     # Entry point (port 4000)
│
└── frontend/         # React + Vite SPA
    └── src/
        ├── pages/    # Dashboard, List, Create, Detail
        ├── components/ # Layout, Badges
        ├── context/  # AuthContext
        └── utils/    # API client
```

---

## Setup & Run

### Backend

```bash
cd backend
npm install
npm start
# → http://localhost:4000
```

### Frontend (new terminal)

```bash
cd frontend
npm install
npm run dev
# → http://localhost:3000
```

---

## First Login

A fresh database is seeded with a single administrator account (see
`backend/data/db.js`). Sign in with it, change the password, then create your
branches, departments, and users from the Admin page.

---

## Core Concepts

### Only Two Operations
- **OUTWARD** → Item leaves a location
- **INWARD** → Item enters a location
- (Transfer = Outward + Inward, linked)

### Pass Types
| Type | Direction | Returnable? | Example |
|------|-----------|-------------|---------|
| Outward | Internal | Yes/No | Laptop sent to another branch |
| Outward | External | Yes | Laptop given to employee |
| Outward | External | No | Consumables used |
| Inward | External | N/A | New purchase received |

### Lifecycle
```
PENDING → APPROVED → (if returnable) PARTIAL_RETURN → COMPLETED
         ↓
       REJECTED
```

### Role-Based Access
- **Staff**: Create passes, view own branch
- **Manager**: Approve/Reject, record returns
- **Admin**: Full access

---

## API Endpoints

```
POST   /api/auth/login
GET    /api/auth/me

GET    /api/gate-passes          ?type= &status= &direction=
POST   /api/gate-passes
GET    /api/gate-passes/:id
PATCH  /api/gate-passes/:id/status   { action: 'approve'|'reject' }
PATCH  /api/gate-passes/:id/return   { returns: [{itemId, quantity}] }
GET    /api/gate-passes/meta/stats

GET    /api/items
GET    /api/branches
GET    /api/users
```

---

## Features

- ✅ Dashboard with live stats and overdue alerts
- ✅ Create outward/inward passes with line items
- ✅ Returnable vs Non-returnable logic
- ✅ Internal (branch-to-branch) and External movement
- ✅ Approval workflow (pending → approved/rejected)
- ✅ Partial and full return recording
- ✅ Overdue detection with visual alerts
- ✅ Lifecycle timeline on each pass
- ✅ Filter by status, type, direction
- ✅ Role-based access control
- ✅ Audit log (server-side)

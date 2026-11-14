package main

import (
	"net/http"
	"time"
)

// Demonstration-only balanced quota units. They have no currency, redemption,
// top-up, or payment semantics; DO NOT use this for real customer balances.
// A transaction has two or three balanced legs; historical transactions never
// change and reservation transitions are single-snapshot atomic.
type LedgerLeg struct {
	Account string `json:"account"` // issuer, available, reserved, spent
	Units   int64  `json:"units"`
}
type LedgerTxn struct {
	ID        string      `json:"id"`
	TenantID  string      `json:"tenant_id"`
	ProjectID string      `json:"project_id"`
	Kind      string      `json:"kind"`
	Reference string      `json:"reference"`
	Legs      []LedgerLeg `json:"legs"`
	CreatedAt time.Time   `json:"created_at"`
}
type Reservation struct {
	ID             string    `json:"id"`
	TenantID       string    `json:"tenant_id"`
	ProjectID      string    `json:"project_id"`
	IdempotencyKey string    `json:"idempotency_key"`
	RequestedUnits int64     `json:"requested_units"`
	ActualUnits    int64     `json:"actual_units"`
	Status         string    `json:"status"` // reserved, settled
	CreatedAt      time.Time `json:"created_at"`
}

func appendLedger(st *State, projectID, tenantID, kind, ref string, legs []LedgerLeg) error {
	var sum int64
	for _, leg := range legs {
		if leg.Account != "issuer" && leg.Account != "available" && leg.Account != "reserved" && leg.Account != "spent" {
			return errInvalid
		}
		if leg.Units > 1_000_000_000 || leg.Units < -1_000_000_000 {
			return errInvalid
		}
		sum += leg.Units
	}
	if sum != 0 || len(st.Ledgers[projectID]) >= 5000 {
		return errInvalid
	}
	id, err := randomID("led_")
	if err != nil {
		return err
	}
	st.Ledgers[projectID] = append(st.Ledgers[projectID], LedgerTxn{ID: id, TenantID: tenantID, ProjectID: projectID, Kind: kind, Reference: ref, Legs: legs, CreatedAt: time.Now().UTC()})
	return nil
}
func ledgerBalances(st State, projectID string) map[string]int64 {
	result := map[string]int64{"issuer": 0, "available": 0, "reserved": 0, "spent": 0}
	for _, tx := range st.Ledgers[projectID] {
		for _, leg := range tx.Legs {
			result[leg.Account] += leg.Units
		}
	}
	return result
}

func (a *API) grantDemoUnits(w http.ResponseWriter, r *http.Request) {
	p, ok := a.auth(w, r, "human")
	if !ok {
		return
	}
	projectID := r.PathValue("project")
	var in struct {
		IdempotencyKey string `json:"idempotency_key"`
		Units          int64  `json:"units"`
	}
	if !decode(w, r, &in, 2048) {
		return
	}
	if !validID(in.IdempotencyKey) || in.Units < 1 || in.Units > 100000 {
		failure(w, 400, "invalid demo units")
		return
	}
	duplicate := false
	err := a.store.transact(func(st *State) error {
		m, _, has := memberProject(*st, p, projectID)
		if !has {
			return errNotFound
		}
		if m.Role != "owner" {
			return errForbidden
		}
		for _, tx := range st.Ledgers[projectID] {
			if tx.Kind == "demo-grant" && tx.Reference == in.IdempotencyKey {
				if len(tx.Legs) != 2 || tx.Legs[1].Units != in.Units {
					return errConflict
				}
				duplicate = true
				return nil
			}
		}
		b := ledgerBalances(*st, projectID)
		if b["available"]+b["reserved"]+b["spent"]+in.Units > 1_000_000 {
			return errInvalid
		}
		if err := appendLedger(st, projectID, p.TenantID, "demo-grant", in.IdempotencyKey, []LedgerLeg{{"issuer", -in.Units}, {"available", in.Units}}); err != nil {
			return err
		}
		appendProjectEvent(st, projectID, "quota.demo-grant", projectID, 1)
		return nil
	})
	if err != nil {
		writeTxError(w, err)
		return
	}
	code := 201
	if duplicate {
		code = 200
	}
	a.store.read(func(st State) {
		respond(w, code, map[string]any{"unit": "demo_not_money", "balances": ledgerBalances(st, projectID)})
	})
}

func (a *API) reserveDemoUnits(w http.ResponseWriter, r *http.Request) {
	p, ok := a.auth(w, r, "human")
	if !ok {
		return
	}
	projectID := r.PathValue("project")
	var in struct {
		IdempotencyKey string `json:"idempotency_key"`
		Units          int64  `json:"units"`
	}
	if !decode(w, r, &in, 2048) {
		return
	}
	if !validID(in.IdempotencyKey) || in.Units < 1 || in.Units > 10000 {
		failure(w, 400, "invalid unit reservation")
		return
	}
	id, err := randomID("res_")
	if err != nil {
		failure(w, 500, "internal error")
		return
	}
	res := Reservation{ID: id, TenantID: p.TenantID, ProjectID: projectID, RequestedUnits: in.Units, IdempotencyKey: in.IdempotencyKey, Status: "reserved", CreatedAt: time.Now().UTC()}
	replay := false
	err = a.store.transact(func(st *State) error {
		m, _, has := memberProject(*st, p, projectID)
		if !has {
			return errNotFound
		}
		if m.Role != "owner" && m.Role != "reviewer" {
			return errForbidden
		}
		for _, old := range st.Reservations {
			if old.TenantID == p.TenantID && old.ProjectID == projectID && old.IdempotencyKey == in.IdempotencyKey {
				if old.RequestedUnits != in.Units {
					return errConflict
				}
				replay = true
				res = old
				return nil
			}
		}
		if ledgerBalances(*st, projectID)["available"] < in.Units {
			return errConflict
		}
		if err := appendLedger(st, projectID, p.TenantID, "reserve", res.ID, []LedgerLeg{{"available", -in.Units}, {"reserved", in.Units}}); err != nil {
			return err
		}
		st.Reservations[res.ID] = res
		appendProjectEvent(st, projectID, "quota.reserved", res.ID, 1)
		return nil
	})
	if err != nil {
		writeTxError(w, err)
		return
	}
	status := 201
	if replay {
		status = 200
	}
	respond(w, status, res)
}

func (a *API) settleDemoUnits(w http.ResponseWriter, r *http.Request) {
	p, ok := a.auth(w, r, "human")
	if !ok {
		return
	}
	projectID, id := r.PathValue("project"), r.PathValue("reservation")
	var in struct {
		ActualUnits int64 `json:"actual_units"`
	}
	if !decode(w, r, &in, 2048) {
		return
	}
	if in.ActualUnits < 0 {
		failure(w, 400, "invalid actual units")
		return
	}
	var res Reservation
	err := a.store.transact(func(st *State) error {
		m, _, has := memberProject(*st, p, projectID)
		if !has {
			return errNotFound
		}
		if m.Role != "owner" && m.Role != "reviewer" {
			return errForbidden
		}
		current, has := st.Reservations[id]
		if !has || current.ProjectID != projectID || current.TenantID != p.TenantID {
			return errNotFound
		}
		if current.Status != "reserved" || in.ActualUnits > current.RequestedUnits {
			return errConflict
		}
		remaining := current.RequestedUnits - in.ActualUnits
		if err := appendLedger(st, projectID, p.TenantID, "settle", id, []LedgerLeg{{"reserved", -current.RequestedUnits}, {"spent", in.ActualUnits}, {"available", remaining}}); err != nil {
			return err
		}
		current.Status = "settled"
		current.ActualUnits = in.ActualUnits
		st.Reservations[id] = current
		appendProjectEvent(st, projectID, "quota.settled", id, 1)
		res = current
		return nil
	})
	if err != nil {
		writeTxError(w, err)
		return
	}
	respond(w, 200, res)
}

func (a *API) readDemoLedger(w http.ResponseWriter, r *http.Request) {
	p, ok := a.auth(w, r, "human")
	if !ok {
		return
	}
	projectID := r.PathValue("project")
	a.store.read(func(st State) {
		m, _, has := memberProject(st, p, projectID)
		if !has {
			failure(w, 404, "not found")
			return
		}
		if m.Role != "owner" {
			failure(w, 403, "capability denied")
			return
		}
		entries := st.Ledgers[projectID]
		if entries == nil {
			entries = []LedgerTxn{}
		}
		respond(w, 200, map[string]any{"unit": "demo_not_money", "balances": ledgerBalances(st, projectID), "entries": entries})
	})
}

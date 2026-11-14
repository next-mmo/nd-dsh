package main

import (
	"net/http"
	"sort"
	"strings"
	"time"
)

// TaskProposal never grants execution authority. The ND host may report an ND
// task ID but the authoritative task/checkpoint/approval stays inside ND-DSH.
type TaskProposal struct {
	ID             string    `json:"id"`
	TenantID       string    `json:"tenant_id"`
	ProjectID      string    `json:"project_id"`
	CaseID         string    `json:"case_id"`
	Text           string    `json:"text"`
	IdempotencyKey string    `json:"idempotency_key"`
	Author         string    `json:"author"`
	ApprovedBy     string    `json:"approved_by,omitempty"`
	Status         string    `json:"status"` // pending, approved-for-host-review, host-reported-accepted/rejected
	NDTaskID       string    `json:"nd_task_id,omitempty"`
	Revision       int64     `json:"revision"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

func (a *API) createTaskProposal(w http.ResponseWriter, r *http.Request) {
	p, ok := a.auth(w, r, "human")
	if !ok {
		return
	}
	projectID, caseID := r.PathValue("project"), r.PathValue("case")
	var in struct {
		ExpectedCaseRevision int64  `json:"expected_case_revision"`
		IdempotencyKey       string `json:"idempotency_key"`
		Text                 string `json:"text"`
	}
	if !decode(w, r, &in, 8192) {
		return
	}
	if in.ExpectedCaseRevision < 1 || !validID(in.IdempotencyKey) || !validName(in.Text, 4000) {
		failure(w, 400, "invalid proposal")
		return
	}
	id, err := randomID("prop_")
	if err != nil {
		failure(w, 500, "internal error")
		return
	}
	now := time.Now().UTC()
	proposal := TaskProposal{ID: id, TenantID: p.TenantID, ProjectID: projectID, CaseID: caseID, Text: strings.TrimSpace(in.Text),
		IdempotencyKey: in.IdempotencyKey, Author: p.Subject, Status: "pending", Revision: 1, CreatedAt: now, UpdatedAt: now}
	replay := false
	err = a.store.transact(func(st *State) error {
		m, _, has := memberProject(*st, p, projectID)
		if !has {
			return errNotFound
		}
		if m.Role != "owner" && m.Role != "reviewer" {
			return errForbidden
		}
		c, has := st.Cases[caseID]
		if !has || c.ProjectID != projectID || c.TenantID != p.TenantID {
			return errNotFound
		}
		for _, prev := range st.Proposals {
			if prev.ProjectID == projectID && prev.TenantID == p.TenantID && prev.CaseID == caseID && prev.IdempotencyKey == in.IdempotencyKey {
				if prev.Text != proposal.Text {
					return errConflict
				}
				proposal = prev
				replay = true
				return nil
			}
		}
		if c.Revision != in.ExpectedCaseRevision {
			return errConflict
		}
		st.Proposals[id] = proposal
		appendProjectEvent(st, projectID, "proposal.pending", proposal.ID, proposal.Revision)
		return nil
	})
	if err != nil {
		writeTxError(w, err)
		return
	}
	if replay {
		respond(w, 200, proposal)
	} else {
		respond(w, 201, proposal)
	}
}

func (a *API) listTaskProposals(w http.ResponseWriter, r *http.Request) {
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
		if m.Role != "owner" && m.Role != "reviewer" {
			failure(w, 403, "capability denied")
			return
		}
		out := make([]TaskProposal, 0)
		for _, v := range st.Proposals {
			if v.ProjectID == projectID && v.TenantID == p.TenantID {
				out = append(out, v)
			}
		}
		sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
		respond(w, 200, map[string]any{"proposals": out})
	})
}

func (a *API) approveTaskProposal(w http.ResponseWriter, r *http.Request) {
	p, ok := a.auth(w, r, "human")
	if !ok {
		return
	}
	projectID, proposalID := r.PathValue("project"), r.PathValue("proposal")
	var in struct {
		ExpectedRevision int64 `json:"expected_revision"`
	}
	if !decode(w, r, &in, 2048) {
		return
	}
	if in.ExpectedRevision < 1 {
		failure(w, 400, "invalid revision")
		return
	}
	var result TaskProposal
	err := a.store.transact(func(st *State) error {
		m, _, has := memberProject(*st, p, projectID)
		if !has {
			return errNotFound
		}
		if m.Role != "owner" {
			return errForbidden
		}
		proposal, has := st.Proposals[proposalID]
		if !has || proposal.ProjectID != projectID || proposal.TenantID != p.TenantID {
			return errNotFound
		}
		if proposal.Author == p.Subject {
			return errForbidden
		}
		if proposal.Revision != in.ExpectedRevision || proposal.Status != "pending" {
			return errConflict
		}
		proposal.Status = "approved-for-host-review"
		proposal.ApprovedBy = p.Subject
		proposal.Revision++
		proposal.UpdatedAt = time.Now().UTC()
		st.Proposals[proposal.ID] = proposal
		appendProjectEvent(st, projectID, "proposal.approved", proposal.ID, proposal.Revision)
		result = proposal
		return nil
	})
	if err != nil {
		writeTxError(w, err)
		return
	}
	respond(w, 200, result)
}

func (a *API) hostTaskReceipt(w http.ResponseWriter, r *http.Request) {
	p, ok := a.auth(w, r, "host")
	if !ok {
		return
	}
	projectID, proposalID := r.PathValue("project"), r.PathValue("proposal")
	if p.ProjectID != projectID {
		failure(w, 404, "not found")
		return
	}
	var in struct {
		ExpectedRevision int64  `json:"expected_revision"`
		NDTaskID         string `json:"nd_task_id"`
		Decision         string `json:"decision"`
	}
	if !decode(w, r, &in, 4096) {
		return
	}
	if in.ExpectedRevision < 1 || (in.Decision != "accepted" && in.Decision != "rejected") ||
		(in.Decision == "accepted" && !validID(in.NDTaskID)) || (in.Decision == "rejected" && in.NDTaskID != "") {
		failure(w, 400, "invalid receipt")
		return
	}
	var result TaskProposal
	err := a.store.transact(func(st *State) error {
		if !activePrincipal(*st, p) {
			return errForbidden
		}
		if st.Projects[projectID].TenantID != p.TenantID {
			return errNotFound
		}
		prop, has := st.Proposals[proposalID]
		if !has || prop.ProjectID != projectID || prop.TenantID != p.TenantID {
			return errNotFound
		}
		if prop.Revision != in.ExpectedRevision || prop.Status != "approved-for-host-review" {
			return errConflict
		}
		prop.Status = "host-reported-" + in.Decision
		prop.NDTaskID = in.NDTaskID
		prop.Revision++
		prop.UpdatedAt = time.Now().UTC()
		st.Proposals[proposalID] = prop
		appendProjectEvent(st, projectID, "proposal.host-receipt", prop.ID, prop.Revision)
		result = prop
		return nil
	})
	if err != nil {
		writeTxError(w, err)
		return
	}
	respond(w, 200, result)
}

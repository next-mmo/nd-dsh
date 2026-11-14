package main

import (
	"net/http"
	"net/url"
	"sort"
	"strings"
	"time"
)

func validCitation(c SourceCitation) bool {
	u, err := url.Parse(c.URL)
	if err != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || len(c.URL) > 2000 {
		return false
	}
	return validName(c.Revision, 128) && validName(c.Label, 160)
}

func (a *API) createKnowledgeCard(w http.ResponseWriter, r *http.Request) {
	p, ok := a.auth(w, r, "human")
	if !ok {
		return
	}
	projectID := r.PathValue("project")
	var input struct {
		AppRelease string           `json:"app_release"`
		Question   string           `json:"question"`
		Answer     string           `json:"answer"`
		Citations  []SourceCitation `json:"citations"`
	}
	if !decode(w, r, &input, 32*1024) {
		return
	}
	if !validID(input.AppRelease) || !validName(input.Question, 500) || !validName(input.Answer, 8000) || len(input.Citations) < 1 || len(input.Citations) > 10 {
		failure(w, 400, "invalid knowledge card")
		return
	}
	for _, c := range input.Citations {
		if !validCitation(c) {
			failure(w, 400, "invalid source citation")
			return
		}
	}
	id, err := randomID("card_")
	if err != nil {
		failure(w, 500, "internal error")
		return
	}
	now := time.Now().UTC()
	card := KnowledgeCard{ID: id, TenantID: p.TenantID, ProjectID: projectID, AppRelease: input.AppRelease, Question: strings.TrimSpace(input.Question), Answer: strings.TrimSpace(input.Answer), Citations: input.Citations, Status: "draft", Author: p.Subject, Revision: 1, CreatedAt: now, UpdatedAt: now}
	err = a.store.transact(func(st *State) error {
		if !activePrincipal(*st, p) {
			return errForbidden
		}
		m, _, ok := memberProject(*st, p, projectID)
		if !ok {
			return errNotFound
		}
		if m.Role != "owner" && m.Role != "reviewer" {
			return errForbidden
		}
		st.Cards[id] = card
		return nil
	})
	if err != nil {
		writeTxError(w, err)
		return
	}
	respond(w, 201, card)
}

func (a *API) listKnowledgeCards(w http.ResponseWriter, r *http.Request) {
	p, ok := a.auth(w, r, "human")
	if !ok {
		return
	}
	projectID := r.PathValue("project")
	a.store.read(func(st State) {
		m, _, ok := memberProject(st, p, projectID)
		if !ok {
			failure(w, 404, "not found")
			return
		}
		out := make([]KnowledgeCard, 0)
		for _, c := range st.Cards {
			if c.ProjectID != projectID || c.TenantID != p.TenantID {
				continue
			}
			if c.Status != "published" && m.Role != "owner" && m.Role != "reviewer" {
				continue
			}
			out = append(out, c)
		}
		sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
		respond(w, 200, map[string]any{"cards": out})
	})
}

func (a *API) publishKnowledgeCard(w http.ResponseWriter, r *http.Request) {
	p, ok := a.auth(w, r, "human")
	if !ok {
		return
	}
	projectID, cardID := r.PathValue("project"), r.PathValue("card")
	var input struct {
		ExpectedRevision int64 `json:"expected_revision"`
	}
	if !decode(w, r, &input, 4096) {
		return
	}
	if input.ExpectedRevision <= 0 {
		failure(w, 400, "invalid expected revision")
		return
	}
	var card KnowledgeCard
	err := a.store.transact(func(st *State) error {
		if !activePrincipal(*st, p) {
			return errForbidden
		}
		m, _, ok := memberProject(*st, p, projectID)
		if !ok {
			return errNotFound
		}
		if m.Role != "owner" && m.Role != "reviewer" {
			return errForbidden
		}
		current, exists := st.Cards[cardID]
		if !exists || current.ProjectID != projectID || current.TenantID != p.TenantID {
			return errNotFound
		}
		if current.Author == p.Subject {
			return errForbidden
		} // independent review, no self-publication
		if current.Revision != input.ExpectedRevision || current.Status != "draft" {
			return errConflict
		}
		for id, existing := range st.Cards {
			if existing.ID == cardID || existing.ProjectID != projectID || existing.AppRelease != current.AppRelease || existing.Status != "published" {
				continue
			}
			if strings.EqualFold(strings.TrimSpace(existing.Question), strings.TrimSpace(current.Question)) {
				existing.Status = "stale"
				existing.Revision++
				existing.UpdatedAt = time.Now().UTC()
				st.Cards[id] = existing
			}
		}
		current.Status = "published"
		current.Reviewer = p.Subject
		current.Revision++
		current.UpdatedAt = time.Now().UTC()
		st.Cards[cardID] = current
		card = current
		return nil
	})
	if err != nil {
		writeTxError(w, err)
		return
	}
	respond(w, 200, card)
}

func (a *API) assistLookup(w http.ResponseWriter, r *http.Request) {
	p, ok := a.auth(w, r, "human")
	if !ok {
		return
	}
	projectID := r.PathValue("project")
	var input struct {
		AppRelease string `json:"app_release"`
		Question   string `json:"question"`
	}
	if !decode(w, r, &input, 8192) {
		return
	}
	if !validID(input.AppRelease) || !validName(input.Question, 500) {
		failure(w, 400, "invalid question or release")
		return
	}
	requestID, err := randomID("req_")
	if err != nil {
		failure(w, 500, "internal error")
		return
	}
	a.store.read(func(st State) {
		if _, _, ok := memberProject(st, p, projectID); !ok {
			failure(w, 404, "not found")
			return
		}
		for _, card := range st.Cards {
			if card.ProjectID == projectID && card.TenantID == p.TenantID && card.AppRelease == input.AppRelease && card.Status == "published" && strings.EqualFold(strings.TrimSpace(card.Question), strings.TrimSpace(input.Question)) {
				// Deterministic reviewed answer, NOT model inference and NOT verified UI proof.
				respond(w, 200, map[string]any{"status": "unverified", "answer": card.Answer, "citations": card.Citations, "request_id": requestID, "knowledge_card_id": card.ID, "reviewed": true, "auto_demo_allowed": false})
				return
			}
		}
		respond(w, 200, map[string]any{"status": "unknown", "answer": "", "citations": []SourceCitation{}, "request_id": requestID, "reviewed": false, "auto_demo_allowed": false})
	})
}

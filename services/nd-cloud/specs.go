package main

import (
	"net/http"
	"sort"
	"strings"
	"time"
)

const (
	maxProjectSpecs = 100
	maxSpecHistory  = 20
)

// A HumanSpec is authored by a human and tied to an exact content hash from a
// source manifest. Metadata provenance is not proof of behavioral correctness.
// Revision history is immutable; conflict marks an old approval unusable.
type HumanSpec struct {
	ID               string        `json:"id"`
	TenantID         string        `json:"tenant_id"`
	ProjectID        string        `json:"project_id"`
	SourceSnapshotID string        `json:"source_snapshot_id"`
	SourcePath       string        `json:"source_path"`
	SourceSHA256     string        `json:"source_sha256"`
	Title            string        `json:"title"`
	Body             string        `json:"body"`
	Status           string        `json:"status"` // draft, approved, conflict
	Author           string        `json:"author"`
	Reviewer         string        `json:"reviewer,omitempty"`
	Revision         int64         `json:"revision"`
	History          []SpecVersion `json:"history,omitempty"`
	CreatedAt        time.Time     `json:"created_at"`
	UpdatedAt        time.Time     `json:"updated_at"`
}

type SpecVersion struct {
	Revision         int64     `json:"revision"`
	Action           string    `json:"action"` // create, revise, approve, source_conflict
	Actor            string    `json:"actor"`
	Status           string    `json:"status"`
	SourceSnapshotID string    `json:"source_snapshot_id"`
	SourcePath       string    `json:"source_path"`
	SourceSHA256     string    `json:"source_sha256"`
	Title            string    `json:"title"`
	Body             string    `json:"body"`
	At               time.Time `json:"at"`
}

func (s *HumanSpec) appendVersion(action, actor string) {
	s.History = append(s.History, SpecVersion{
		Revision: s.Revision, Action: action, Actor: actor, Status: s.Status,
		SourceSnapshotID: s.SourceSnapshotID, SourcePath: s.SourcePath,
		SourceSHA256: s.SourceSHA256, Title: s.Title, Body: s.Body, At: s.UpdatedAt,
	})
}

func specFile(st State, tenant, project, snapshotID, sourcePath string, requireLatest bool) (string, bool) {
	snapshot, has := st.Sources[snapshotID]
	if !has || snapshot.TenantID != tenant || snapshot.ProjectID != project {
		return "", false
	}
	if requireLatest {
		latest, ok := latestProjectSource(st, tenant, project)
		if !ok || latest.ID != snapshotID {
			return "", false
		}
	}
	for _, file := range snapshot.Files {
		if file.Path == sourcePath {
			return file.SHA256, true
		}
	}
	return "", false
}

func latestProjectSource(st State, tenant, project string) (SourceSnapshot, bool) {
	var current SourceSnapshot
	found := false
	for _, s := range st.Sources {
		if s.TenantID != tenant || s.ProjectID != project {
			continue
		}
		if !found || s.CreatedAt.After(current.CreatedAt) || (s.CreatedAt.Equal(current.CreatedAt) && s.ID > current.ID) {
			current = s
			found = true
		}
	}
	return current, found
}

func currentSpecSource(st State, spec HumanSpec) bool {
	latest, found := latestProjectSource(st, spec.TenantID, spec.ProjectID)
	if !found {
		return false
	}
	digest, exists := specFile(st, spec.TenantID, spec.ProjectID, latest.ID, spec.SourcePath, false)
	return exists && digest == spec.SourceSHA256
}

func validSpecText(title, body string) bool {
	return validName(title, 160) && validName(body, 8000)
}

func (a *API) createSpec(w http.ResponseWriter, r *http.Request) {
	p, ok := a.auth(w, r, "human")
	if !ok {
		return
	}
	projectID := r.PathValue("project")
	var in struct {
		SourceSnapshotID string `json:"source_snapshot_id"`
		SourcePath       string `json:"source_path"`
		Title            string `json:"title"`
		Body             string `json:"body"`
	}
	if !decode(w, r, &in, 16000) {
		return
	}
	if !validID(in.SourceSnapshotID) || !safeSourcePath(in.SourcePath) || !validSpecText(in.Title, in.Body) {
		failure(w, 400, "invalid specification draft")
		return
	}
	id, err := randomID("spec_")
	if err != nil {
		failure(w, 500, "internal error")
		return
	}
	now := time.Now().UTC()
	spec := HumanSpec{ID: id, TenantID: p.TenantID, ProjectID: projectID,
		SourceSnapshotID: in.SourceSnapshotID, SourcePath: in.SourcePath,
		Title: strings.TrimSpace(in.Title), Body: strings.TrimSpace(in.Body),
		Status: "draft", Author: p.Subject, Revision: 1, CreatedAt: now, UpdatedAt: now}
	err = a.store.transact(func(st *State) error {
		m, _, has := memberProject(*st, p, projectID)
		if !has {
			return errNotFound
		}
		if m.Role != "owner" && m.Role != "reviewer" {
			return errForbidden
		}
		count := 0
		for _, item := range st.Specs {
			if item.ProjectID == projectID && item.TenantID == p.TenantID {
				count++
			}
		}
		if count >= maxProjectSpecs {
			return errInvalid
		}
		sha, exists := specFile(*st, p.TenantID, projectID, in.SourceSnapshotID, in.SourcePath, true)
		if !exists {
			return errInvalid
		}
		spec.SourceSHA256 = sha
		spec.appendVersion("create", p.Subject)
		st.Specs[id] = spec
		appendProjectEvent(st, projectID, "spec.draft", id, spec.Revision)
		return nil
	})
	if err != nil {
		writeTxError(w, err)
		return
	}
	respond(w, 201, spec)
}

func (a *API) listSpecs(w http.ResponseWriter, r *http.Request) {
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
		out := make([]HumanSpec, 0)
		for _, spec := range st.Specs {
			if spec.ProjectID != projectID || spec.TenantID != p.TenantID {
				continue
			}
			if m.Role != "owner" && m.Role != "reviewer" && spec.Status != "approved" {
				continue
			}
			if m.Role != "owner" && m.Role != "reviewer" {
				spec.History = nil
			}
			out = append(out, spec)
		}
		sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
		respond(w, 200, map[string]any{"specs": out})
	})
}

func (a *API) reviseSpec(w http.ResponseWriter, r *http.Request) {
	p, ok := a.auth(w, r, "human")
	if !ok {
		return
	}
	projectID, specID := r.PathValue("project"), r.PathValue("spec")
	var in struct {
		ExpectedRevision int64  `json:"expected_revision"`
		SourceSnapshotID string `json:"source_snapshot_id"`
		SourcePath       string `json:"source_path"`
		Title            string `json:"title"`
		Body             string `json:"body"`
	}
	if !decode(w, r, &in, 16000) {
		return
	}
	if in.ExpectedRevision < 1 || !validID(in.SourceSnapshotID) || !safeSourcePath(in.SourcePath) || !validSpecText(in.Title, in.Body) {
		failure(w, 400, "invalid specification revision")
		return
	}
	var result HumanSpec
	err := a.store.transact(func(st *State) error {
		m, _, has := memberProject(*st, p, projectID)
		if !has {
			return errNotFound
		}
		if m.Role != "owner" && m.Role != "reviewer" {
			return errForbidden
		}
		spec, has := st.Specs[specID]
		if !has || spec.ProjectID != projectID || spec.TenantID != p.TenantID {
			return errNotFound
		}
		if spec.Revision != in.ExpectedRevision {
			return errConflict
		}
		if len(spec.History) >= maxSpecHistory {
			return errInvalid
		}
		sha, exists := specFile(*st, p.TenantID, projectID, in.SourceSnapshotID, in.SourcePath, true)
		if !exists {
			return errInvalid
		}
		spec.SourceSnapshotID = in.SourceSnapshotID
		spec.SourcePath = in.SourcePath
		spec.SourceSHA256 = sha
		spec.Title = strings.TrimSpace(in.Title)
		spec.Body = strings.TrimSpace(in.Body)
		spec.Revision++
		spec.Status = "draft"
		spec.Author = p.Subject
		spec.Reviewer = ""
		spec.UpdatedAt = time.Now().UTC()
		spec.appendVersion("revise", p.Subject)
		st.Specs[spec.ID] = spec
		appendProjectEvent(st, projectID, "spec.revised", spec.ID, spec.Revision)
		result = spec
		return nil
	})
	if err != nil {
		writeTxError(w, err)
		return
	}
	respond(w, 200, result)
}

func (a *API) approveSpec(w http.ResponseWriter, r *http.Request) {
	p, ok := a.auth(w, r, "human")
	if !ok {
		return
	}
	projectID, specID := r.PathValue("project"), r.PathValue("spec")
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
	var result HumanSpec
	err := a.store.transact(func(st *State) error {
		m, _, has := memberProject(*st, p, projectID)
		if !has {
			return errNotFound
		}
		if m.Role != "owner" && m.Role != "reviewer" {
			return errForbidden
		}
		spec, has := st.Specs[specID]
		if !has || spec.ProjectID != projectID || spec.TenantID != p.TenantID {
			return errNotFound
		}
		if spec.Author == p.Subject {
			return errForbidden
		}
		if spec.Revision != in.ExpectedRevision || spec.Status != "draft" {
			return errConflict
		}
		if !currentSpecSource(*st, spec) {
			return errConflict
		}
		if len(spec.History) >= maxSpecHistory {
			return errInvalid
		}
		spec.Revision++
		spec.Status = "approved"
		spec.Reviewer = p.Subject
		spec.UpdatedAt = time.Now().UTC()
		spec.appendVersion("approve", p.Subject)
		st.Specs[spec.ID] = spec
		appendProjectEvent(st, projectID, "spec.approved", spec.ID, spec.Revision)
		result = spec
		return nil
	})
	if err != nil {
		writeTxError(w, err)
		return
	}
	respond(w, 200, result)
}

// invalidateSourceSpecs is invoked only inside the source ingest transaction.
// Changed/missing source hashes require explicit rebase and independent review.
func invalidateSourceSpecs(st *State, source SourceSnapshot) {
	files := make(map[string]string, len(source.Files))
	for _, f := range source.Files {
		files[f.Path] = f.SHA256
	}
	for id, spec := range st.Specs {
		if spec.ProjectID != source.ProjectID || spec.TenantID != source.TenantID || spec.Status == "conflict" {
			continue
		}
		if files[spec.SourcePath] == spec.SourceSHA256 {
			continue
		}
		spec.Revision++
		spec.Status = "conflict"
		spec.Reviewer = ""
		spec.UpdatedAt = time.Now().UTC()
		// All revisions are retained; the history cap fails closed for edits
		// but a source conflict must not expose a stale approved page.
		spec.appendVersion("source_conflict", "system")
		st.Specs[id] = spec
		appendProjectEvent(st, source.ProjectID, "spec.conflict", id, spec.Revision)
	}
}

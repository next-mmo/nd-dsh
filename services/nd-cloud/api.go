package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"mime"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"time"
)

var idPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$`)

func validID(v string) bool { return idPattern.MatchString(v) }
func validName(v string, limit int) bool {
	return strings.TrimSpace(v) != "" && len(v) <= limit && !strings.ContainsRune(v, '\x00')
}

type API struct{ store *Store }

func newAPI(store *Store) http.Handler {
	a := &API{store: store}
	m := http.NewServeMux()
	m.HandleFunc("GET /", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/" {
			http.NotFound(w, r)
			return
		}
		staticWebFile("web/index.html", "text/html; charset=utf-8")(w, r)
	})
	m.HandleFunc("GET /assets/app.js", staticWebFile("web/app.js", "text/javascript; charset=utf-8"))
	m.HandleFunc("GET /assets/styles.css", staticWebFile("web/styles.css", "text/css; charset=utf-8"))
	m.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) {
		respond(w, 200, map[string]string{"status": "ok", "mode": "loopback-pilot"})
	})
	m.HandleFunc("GET /readyz", a.ready)
	m.HandleFunc("GET /v1/me", a.me)
	m.HandleFunc("GET /v1/tenants", a.tenants)
	m.HandleFunc("GET /v1/tenants/{tenant}/projects", a.listProjects)
	m.HandleFunc("POST /v1/tenants/{tenant}/projects", a.createProject)
	m.HandleFunc("GET /v1/projects/{project}/board", a.getBoard)
	m.HandleFunc("POST /v1/projects/{project}/sources/zip", a.createSourceSnapshot)
	m.HandleFunc("GET /v1/projects/{project}/sources", a.listSourceSnapshots)
	m.HandleFunc("GET /v1/projects/{project}/sources/{source}", a.getSourceSnapshot)
	m.HandleFunc("PUT /v1/projects/{project}/board", a.putBoard)
	m.HandleFunc("POST /v1/projects/{project}/knowledge/cards", a.createKnowledgeCard)
	m.HandleFunc("GET /v1/projects/{project}/knowledge/cards", a.listKnowledgeCards)
	m.HandleFunc("POST /v1/projects/{project}/knowledge/cards/{card}/publish", a.publishKnowledgeCard)
	m.HandleFunc("POST /v1/projects/{project}/assist/lookup", a.assistLookup)
	m.HandleFunc("POST /v1/projects/{project}/support/cases", a.createCase)
	m.HandleFunc("GET /v1/projects/{project}/support/cases", a.listCases)
	m.HandleFunc("POST /v1/projects/{project}/support/cases/{case}/propose-task", a.proposeTask)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		w.Header().Set("Referrer-Policy", "no-referrer")
		m.ServeHTTP(w, r)
	})
}

func respond(w http.ResponseWriter, code int, obj any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(obj)
}
func failure(w http.ResponseWriter, code int, msg string) {
	respond(w, code, map[string]string{"error": msg})
}

func decode(w http.ResponseWriter, r *http.Request, value any, max int64) bool {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		failure(w, 415, "application/json required")
		return false
	}
	dec := json.NewDecoder(http.MaxBytesReader(w, r.Body, max))
	dec.DisallowUnknownFields()
	if err := dec.Decode(value); err != nil {
		failure(w, 400, "invalid JSON or payload limit exceeded")
		return false
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		failure(w, 400, "trailing JSON is not allowed")
		return false
	}
	return true
}

func (a *API) ready(w http.ResponseWriter, _ *http.Request) {
	// Snapshot is loaded and validated at startup; no external dependencies.
	respond(w, 200, map[string]string{"status": "ready", "persistence": "local-atomic-snapshot"})
}

func (a *API) principal(r *http.Request) (AccessToken, bool) {
	raw, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !ok || len(raw) != 47 || !strings.HasPrefix(raw, "ndp_") || strings.ContainsAny(raw, " \r\n\t") {
		return AccessToken{}, false
	}
	hash := tokenHash(raw)
	var token AccessToken
	var found bool
	a.store.read(func(st State) { token, found = st.Tokens[hash] })
	if !found || token.Revoked || !time.Now().UTC().Before(token.ExpiresAt) {
		return AccessToken{}, false
	}
	return token, true
}

func activePrincipal(st State, p AccessToken) bool {
	current, ok := st.Tokens[p.Hash]
	return ok && !current.Revoked && time.Now().UTC().Before(current.ExpiresAt) && current.ID == p.ID
}

func (a *API) auth(w http.ResponseWriter, r *http.Request, kind string) (AccessToken, bool) {
	p, ok := a.principal(r)
	if !ok {
		failure(w, 401, "authentication required")
		return AccessToken{}, false
	}
	if p.Kind != kind {
		failure(w, 403, "capability denied")
		return AccessToken{}, false
	}
	return p, true
}

func memberProject(st State, p AccessToken, projectID string) (Membership, Project, bool) {
	project, ok := st.Projects[projectID]
	if !ok || project.TenantID != p.TenantID || p.Kind != "human" || !activePrincipal(st, p) {
		return Membership{}, Project{}, false
	}
	member, ok := st.Memberships[memberKey(project.TenantID, p.Subject)]
	if !ok {
		return Membership{}, Project{}, false
	}
	if member.Role == "owner" {
		return member, project, true
	}
	for _, id := range member.ProjectIDs {
		if id == projectID {
			return member, project, true
		}
	}
	return Membership{}, Project{}, false
}

func (a *API) me(w http.ResponseWriter, r *http.Request) {
	p, ok := a.auth(w, r, "human")
	if !ok {
		return
	}
	a.store.read(func(st State) {
		m, exists := st.Memberships[memberKey(p.TenantID, p.Subject)]
		if !activePrincipal(st, p) || !exists {
			failure(w, 403, "membership revoked")
			return
		}
		respond(w, 200, map[string]any{"subject": p.Subject, "tenant_id": p.TenantID, "role": m.Role, "project_ids": m.ProjectIDs, "expires_at": p.ExpiresAt})
	})
}

func (a *API) tenants(w http.ResponseWriter, r *http.Request) {
	p, ok := a.auth(w, r, "human")
	if !ok {
		return
	}
	a.store.read(func(st State) {
		if _, exists := st.Memberships[memberKey(p.TenantID, p.Subject)]; !activePrincipal(st, p) || !exists {
			failure(w, 403, "membership revoked")
			return
		}
		respond(w, 200, map[string]any{"tenants": []Tenant{st.Tenants[p.TenantID]}})
	})
}

func (a *API) listProjects(w http.ResponseWriter, r *http.Request) {
	p, ok := a.auth(w, r, "human")
	if !ok {
		return
	}
	tenant := r.PathValue("tenant")
	if tenant != p.TenantID {
		failure(w, 404, "not found")
		return
	}
	a.store.read(func(st State) {
		member, ok := st.Memberships[memberKey(tenant, p.Subject)]
		if !activePrincipal(st, p) || !ok {
			failure(w, 403, "membership revoked")
			return
		}
		out := make([]Project, 0)
		for _, project := range st.Projects {
			if project.TenantID != tenant {
				continue
			}
			if member.Role != "owner" && !contains(member.ProjectIDs, project.ID) {
				continue
			}
			out = append(out, project)
		}
		sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
		respond(w, 200, map[string]any{"projects": out})
	})
}
func contains(a []string, value string) bool {
	for _, item := range a {
		if item == value {
			return true
		}
	}
	return false
}

func (a *API) createProject(w http.ResponseWriter, r *http.Request) {
	p, ok := a.auth(w, r, "human")
	if !ok {
		return
	}
	if r.PathValue("tenant") != p.TenantID {
		failure(w, 404, "not found")
		return
	}
	var input struct {
		Name string `json:"name"`
	}
	if !decode(w, r, &input, 4096) {
		return
	}
	if !validName(input.Name, 120) {
		failure(w, 400, "invalid project name")
		return
	}
	id, err := randomID("prj_")
	if err != nil {
		failure(w, 500, "internal error")
		return
	}
	project := Project{ID: id, TenantID: p.TenantID, Name: strings.TrimSpace(input.Name), CreatedAt: time.Now().UTC()}
	err = a.store.transact(func(st *State) error {
		member, ok := st.Memberships[memberKey(p.TenantID, p.Subject)]
		if !activePrincipal(*st, p) || !ok || member.Role != "owner" {
			return errForbidden
		}
		st.Projects[id] = project
		return nil
	})
	if err != nil {
		writeTxError(w, err)
		return
	}
	respond(w, 201, project)
}

func writeTxError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, errForbidden):
		failure(w, 403, "capability denied")
	case errors.Is(err, errNotFound):
		failure(w, 404, "not found")
	case errors.Is(err, errConflict):
		failure(w, 409, "revision conflict")
	case errors.Is(err, errInvalid):
		failure(w, 400, "invalid request")
	default:
		failure(w, 500, "storage error")
	}
}

func (a *API) getBoard(w http.ResponseWriter, r *http.Request) {
	p, ok := a.auth(w, r, "human")
	if !ok {
		return
	}
	id := r.PathValue("project")
	a.store.read(func(st State) {
		if _, _, ok := memberProject(st, p, id); !ok {
			failure(w, 404, "not found")
			return
		}
		board, exists := st.Boards[id]
		if !exists {
			failure(w, 404, "board not synchronized")
			return
		}
		respond(w, 200, board)
	})
}

func validateBoard(b BoardSubmission) bool {
	if b.SchemaVersion != 1 || b.SourceSystem != "nd-dsh" || !validID(b.TenantID) || !validID(b.CloudProjectID) || !validID(b.LocalCompanyID) || !validID(b.LocalProjectID) || b.Revision < 1 || b.Revision > 1<<60 || len(b.Tasks) > 500 {
		return false
	}
	seen := map[string]bool{}
	statuses := map[string]bool{"backlog": true, "ready": true, "in_progress": true, "review": true, "blocked": true, "completed": true}
	priorities := map[string]bool{"low": true, "medium": true, "high": true, "critical": true}
	for _, t := range b.Tasks {
		if !validID(t.ID) || !validName(t.Title, 250) || !statuses[t.Status] || !priorities[t.Priority] || t.UpdatedAt < 0 || seen[t.ID] {
			return false
		}
		seen[t.ID] = true
	}
	return true
}

func (a *API) putBoard(w http.ResponseWriter, r *http.Request) {
	p, ok := a.auth(w, r, "host")
	if !ok {
		return
	}
	id := r.PathValue("project")
	if p.ProjectID != id {
		failure(w, 404, "not found")
		return
	}
	var input BoardSubmission
	if !decode(w, r, &input, 128*1024) {
		return
	}
	if !validateBoard(input) || input.TenantID != p.TenantID || input.CloudProjectID != p.ProjectID || input.LocalCompanyID != p.LocalCompanyID || input.LocalProjectID != p.LocalProjectID {
		failure(w, 400, "projection contract rejected")
		return
	}
	sort.Slice(input.Tasks, func(i, j int) bool { return input.Tasks[i].ID < input.Tasks[j].ID })
	b, _ := json.Marshal(input)
	sum := sha256.Sum256(b)
	digest := hex.EncodeToString(sum[:])
	var result Board
	changed := false
	err := a.store.transact(func(st *State) error {
		if !activePrincipal(*st, p) {
			return errForbidden
		}
		if st.Projects[id].TenantID != p.TenantID {
			return errNotFound
		}
		prev, exists := st.Boards[id]
		if exists {
			if input.Revision < prev.Revision || (input.Revision == prev.Revision && digest != prev.Digest) {
				return errConflict
			}
			if input.Revision == prev.Revision {
				result = prev
				return nil
			}
		}
		result = Board{BoardSubmission: input, Digest: digest, ReceivedAt: time.Now().UTC()}
		st.Boards[id] = result
		changed = true
		return nil
	})
	if err != nil {
		writeTxError(w, err)
		return
	}
	if !changed {
		respond(w, 200, result)
		return
	}
	respond(w, 201, result)
}

func (a *API) createCase(w http.ResponseWriter, r *http.Request) {
	p, ok := a.auth(w, r, "human")
	if !ok {
		return
	}
	projectID := r.PathValue("project")
	var input struct {
		Subject     string `json:"subject"`
		Description string `json:"description"`
	}
	if !decode(w, r, &input, 16*1024) {
		return
	}
	if !validName(input.Subject, 200) || !validName(input.Description, 8000) {
		failure(w, 400, "invalid case fields")
		return
	}
	id, err := randomID("case_")
	if err != nil {
		failure(w, 500, "internal error")
		return
	}
	now := time.Now().UTC()
	c := SupportCase{ID: id, ProjectID: projectID, TenantID: p.TenantID, Reporter: p.Subject, Subject: strings.TrimSpace(input.Subject), Description: strings.TrimSpace(input.Description), Status: "open", Revision: 1, CreatedAt: now, UpdatedAt: now}
	err = a.store.transact(func(st *State) error {
		if !activePrincipal(*st, p) {
			return errForbidden
		}
		if _, _, ok := memberProject(*st, p, projectID); !ok {
			return errNotFound
		}
		st.Cases[id] = c
		return nil
	})
	if err != nil {
		writeTxError(w, err)
		return
	}
	respond(w, 201, c)
}

func (a *API) listCases(w http.ResponseWriter, r *http.Request) {
	p, ok := a.auth(w, r, "human")
	if !ok {
		return
	}
	projectID := r.PathValue("project")
	a.store.read(func(st State) {
		member, _, ok := memberProject(st, p, projectID)
		if !ok {
			failure(w, 404, "not found")
			return
		}
		out := make([]SupportCase, 0)
		for _, c := range st.Cases {
			if c.ProjectID != projectID || c.TenantID != p.TenantID {
				continue
			}
			if member.Role != "owner" && member.Role != "reviewer" && c.Reporter != p.Subject {
				continue
			}
			out = append(out, c)
		}
		sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
		respond(w, 200, map[string]any{"cases": out})
	})
}

func (a *API) proposeTask(w http.ResponseWriter, r *http.Request) {
	p, ok := a.auth(w, r, "human")
	if !ok {
		return
	}
	projectID, caseID := r.PathValue("project"), r.PathValue("case")
	var input struct {
		ExpectedRevision int64  `json:"expected_revision"`
		Proposal         string `json:"proposal"`
	}
	if !decode(w, r, &input, 8*1024) {
		return
	}
	if input.ExpectedRevision <= 0 || !validName(input.Proposal, 4000) {
		failure(w, 400, "invalid task proposal")
		return
	}
	var c SupportCase
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
		current, exists := st.Cases[caseID]
		if !exists || current.ProjectID != projectID || current.TenantID != p.TenantID {
			return errNotFound
		}
		if current.Revision != input.ExpectedRevision {
			return errConflict
		}
		current.Revision++
		current.ProposedNDTask = strings.TrimSpace(input.Proposal)
		current.UpdatedAt = time.Now().UTC()
		st.Cases[caseID] = current
		c = current
		return nil
	})
	if err != nil {
		writeTxError(w, err)
		return
	}
	// proposal only: does NOT call local ND APIs or create/change tasks.
	respond(w, 200, c)
}

package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

type pilot struct {
	t                                      *testing.T
	store                                  *Store
	handler                                http.Handler
	path                                   string
	ownerA, ownerB, viewer, reviewer, host string
	projectA, projectB, projectOther       string
}

func createPilot(t *testing.T) *pilot {
	t.Helper()
	path := filepath.Join(t.TempDir(), "private", "state.json")
	s, err := openStore(path)
	if err != nil {
		t.Fatal(err)
	}
	p := &pilot{t: t, store: s, path: path, handler: newAPI(s)}
	p.ownerA, err = s.bootstrap("tenant-a", "Tenant A", "owner-a")
	if err != nil {
		t.Fatal(err)
	}
	p.ownerB, err = s.bootstrap("tenant-b", "Tenant B", "owner-b")
	if err != nil {
		t.Fatal(err)
	}
	p.projectA = p.createProject(p.ownerA, "tenant-a", "POS")
	p.projectB = p.createProject(p.ownerA, "tenant-a", "Private B")
	p.projectOther = p.createProject(p.ownerB, "tenant-b", "Secret")
	p.viewer, err = s.issueHuman("tenant-a", "viewer-a", "viewer", []string{p.projectA})
	if err != nil {
		t.Fatal(err)
	}
	p.reviewer, err = s.issueHuman("tenant-a", "reviewer-a", "reviewer", []string{p.projectA})
	if err != nil {
		t.Fatal(err)
	}
	p.host, err = s.issueHost("tenant-a", p.projectA, "local-company", "local-project")
	if err != nil {
		t.Fatal(err)
	}
	return p
}
func (p *pilot) call(method, path, token string, value any) *httptest.ResponseRecorder {
	p.t.Helper()
	var body io.Reader
	if value != nil {
		b, err := json.Marshal(value)
		if err != nil {
			p.t.Fatal(err)
		}
		body = bytes.NewReader(b)
	}
	r := httptest.NewRequest(method, path, body)
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	if value != nil {
		r.Header.Set("Content-Type", "application/json")
	}
	w := httptest.NewRecorder()
	p.handler.ServeHTTP(w, r)
	return w
}
func (p *pilot) createProject(token, tenant, name string) string {
	p.t.Helper()
	w := p.call("POST", "/v1/tenants/"+tenant+"/projects", token, map[string]string{"name": name})
	if w.Code != 201 {
		p.t.Fatalf("create project: %d %s", w.Code, w.Body.String())
	}
	var project Project
	if err := json.Unmarshal(w.Body.Bytes(), &project); err != nil {
		p.t.Fatal(err)
	}
	return project.ID
}
func (p *pilot) board(revision int64) BoardSubmission {
	return BoardSubmission{SchemaVersion: 1, SourceSystem: "nd-dsh", TenantID: "tenant-a", CloudProjectID: p.projectA, LocalCompanyID: "local-company", LocalProjectID: "local-project", Revision: revision, Tasks: []TaskSummary{{ID: "task-1", Title: "Pay", Status: "ready", Priority: "high", UpdatedAt: 123}}}
}
func expectStatus(t *testing.T, w *httptest.ResponseRecorder, status int) {
	t.Helper()
	if w.Code != status {
		t.Fatalf("expected HTTP %d, got %d: %s", status, w.Code, w.Body.String())
	}
}

func TestTenantAndProjectIsolation(t *testing.T) {
	p := createPilot(t)
	expectStatus(t, p.call("GET", "/v1/me", "", nil), 401)
	expectStatus(t, p.call("GET", "/v1/me", p.host, nil), 403)
	expectStatus(t, p.call("GET", "/v1/tenants/tenant-a/projects", p.ownerB, nil), 404)
	expectStatus(t, p.call("POST", "/v1/tenants/tenant-a/projects", p.ownerB, map[string]string{"name": "Attack"}), 404)
	expectStatus(t, p.call("GET", "/v1/projects/"+p.projectOther+"/board", p.ownerA, nil), 404)
	expectStatus(t, p.call("GET", "/v1/projects/"+p.projectB+"/board", p.viewer, nil), 404)
	expectStatus(t, p.call("POST", "/v1/tenants/tenant-a/projects", p.viewer, map[string]string{"name": "Cannot create"}), 403)
	w := p.call("GET", "/v1/tenants/tenant-a/projects", p.viewer, nil)
	expectStatus(t, w, 200)
	if strings.Contains(w.Body.String(), p.projectB) || strings.Contains(w.Body.String(), p.projectOther) {
		t.Fatalf("project leakage: %s", w.Body.String())
	}
	if !strings.Contains(w.Body.String(), p.projectA) {
		t.Fatalf("allowed project missing: %s", w.Body.String())
	}
}

func TestHostBoardRevisionAndScope(t *testing.T) {
	p := createPilot(t)
	route := "/v1/projects/" + p.projectA + "/board"
	b := p.board(1)
	expectStatus(t, p.call("PUT", route, p.ownerA, b), 403) // human cannot claim host authority
	expectStatus(t, p.call("PUT", "/v1/projects/"+p.projectB+"/board", p.host, b), 404)
	expectStatus(t, p.call("PUT", route, p.host, func() BoardSubmission { v := b; v.LocalCompanyID = "other"; return v }()), 400)
	expectStatus(t, p.call("PUT", route, p.host, func() BoardSubmission { v := b; v.TenantID = "tenant-b"; return v }()), 400)
	expectStatus(t, p.call("PUT", route, p.host, func() BoardSubmission {
		v := p.board(1)
		v.Tasks[0].Title = "secret"
		v.Tasks[0].Status = "evil"
		return v
	}()), 400)
	expectStatus(t, p.call("PUT", route, p.host, b), 201)
	expectStatus(t, p.call("PUT", route, p.host, b), 200)
	altered := p.board(1)
	altered.Tasks[0].Title = "different"
	expectStatus(t, p.call("PUT", route, p.host, altered), 409)
	newer := p.board(2)
	newer.Tasks[0].Status = "completed"
	expectStatus(t, p.call("PUT", route, p.host, newer), 201)
	expectStatus(t, p.call("PUT", route, p.host, b), 409)
	expectStatus(t, p.call("GET", route, p.host, nil), 403)
	expectStatus(t, p.call("GET", route, p.viewer, nil), 200)
	expectStatus(t, p.call("GET", route, p.ownerB, nil), 404)
	w := p.call("GET", route, p.viewer, nil)
	if !strings.Contains(w.Body.String(), "completed") {
		t.Fatal("new revision missing")
	}
}

func TestSupportIsolationProposalAndRevision(t *testing.T) {
	p := createPilot(t)
	route := "/v1/projects/" + p.projectA + "/support/cases"
	w := p.call("POST", route, p.viewer, map[string]string{"subject": "Login issue", "description": "Login button fails"})
	expectStatus(t, w, 201)
	var c SupportCase
	if err := json.Unmarshal(w.Body.Bytes(), &c); err != nil {
		t.Fatal(err)
	}
	if c.Revision != 1 || c.ProjectID != p.projectA {
		t.Fatal(c)
	}
	expectStatus(t, p.call("GET", route, p.reviewer, nil), 200)
	expectStatus(t, p.call("GET", route, p.ownerB, nil), 404)
	expectStatus(t, p.call("POST", route, p.host, map[string]string{"subject": "try", "description": "bad"}), 403)
	proposalRoute := route + "/" + c.ID + "/propose-task"
	payload := map[string]any{"expected_revision": 1, "proposal": "Implement login fix after PM review"}
	expectStatus(t, p.call("POST", proposalRoute, p.viewer, payload), 403)
	expectStatus(t, p.call("POST", proposalRoute, p.reviewer, payload), 200)
	expectStatus(t, p.call("POST", proposalRoute, p.reviewer, payload), 409)
	expectStatus(t, p.call("POST", proposalRoute, p.ownerB, map[string]any{"expected_revision": 2, "proposal": "foreign"}), 404)
	p.store.read(func(st State) {
		if len(st.Cases) != 1 || len(st.Boards) != 0 {
			t.Fatal("unauthorized mutation side effects")
		}
	})
}

func TestDurabilityRevocationAndPermission(t *testing.T) {
	p := createPilot(t)
	expectStatus(t, p.call("PUT", "/v1/projects/"+p.projectA+"/board", p.host, p.board(1)), 201)
	fi, err := os.Stat(p.path)
	if err != nil {
		t.Fatal(err)
	}
	if fi.Mode().Perm() != 0600 {
		t.Fatalf("mode %v", fi.Mode().Perm())
	}
	reload, err := openStore(p.path)
	if err != nil {
		t.Fatal(err)
	}
	other := newAPI(reload)
	w := httptest.NewRecorder()
	r := httptest.NewRequest("GET", "/v1/projects/"+p.projectA+"/board", nil)
	r.Header.Set("Authorization", "Bearer "+p.viewer)
	other.ServeHTTP(w, r)
	expectStatus(t, w, 200)
	var id string
	reload.read(func(st State) { id = st.Tokens[tokenHash(p.host)].ID })
	if err := reload.revokeToken(id); err != nil {
		t.Fatal(err)
	}
	p.handler = newAPI(reload)
	expectStatus(t, p.call("PUT", "/v1/projects/"+p.projectA+"/board", p.host, p.board(2)), 401)
	expectStatus(t, p.call("GET", "/v1/projects/"+p.projectA+"/board", p.viewer, nil), 200)
	if _, err := openStore(p.path); err != nil {
		t.Fatal(err)
	}
}

func TestMalformedAndOversizedRequests(t *testing.T) {
	p := createPilot(t)
	route := "/v1/tenants/tenant-a/projects"
	expectStatus(t, p.call("POST", route, p.ownerA, map[string]any{"name": "A", "untrusted": "injection"}), 400)
	expectStatus(t, p.call("POST", route, p.ownerA, map[string]any{"name": ""}), 400)
	w := p.call("POST", route, p.ownerA, map[string]any{"name": strings.Repeat("A", 4096)})
	expectStatus(t, w, 400)
	expectStatus(t, p.call("PUT", "/v1/projects/"+p.projectA+"/board", p.host, func() BoardSubmission { b := p.board(1); b.Tasks = append(b.Tasks, b.Tasks[0]); return b }()), 400)
	bad := p.board(1)
	bad.Tasks = make([]TaskSummary, 501)
	expectStatus(t, p.call("PUT", "/v1/projects/"+p.projectA+"/board", p.host, bad), 400)
}

func TestConcurrentRevisionsCannotRollback(t *testing.T) {
	p := createPilot(t)
	route := "/v1/projects/" + p.projectA + "/board"
	expectStatus(t, p.call("PUT", route, p.host, p.board(1)), 201)
	var wg sync.WaitGroup
	for i := int64(2); i <= 20; i++ {
		wg.Add(1)
		go func(rev int64) {
			defer wg.Done()
			w := p.call("PUT", route, p.host, p.board(rev))
			if w.Code != 201 && w.Code != 409 {
				t.Errorf("unexpected result: %d", w.Code)
			}
		}(i)
	}
	wg.Wait()
	p.store.read(func(st State) {
		board := st.Boards[p.projectA]
		if board.Revision < 2 || board.Revision > 20 {
			t.Fatal(board.Revision)
		}
	})
	// The stored revision can never be lowered even when a slower request arrives last.
	for i := int64(1); i < 2; i++ {
		expectStatus(t, p.call("PUT", route, p.host, p.board(i)), 409)
	}
}

func TestNoNonLoopbackBind(t *testing.T) {
	s, err := openStore(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, addr := range []string{"0.0.0.0:8787", ":8787", "192.168.1.10:8787"} {
		if err := serve(s, addr); err == nil {
			t.Fatalf("%q unexpectedly accepted", addr)
		}
	}
}

func TestBootstrapNoOverwrite(t *testing.T) {
	s, err := openStore(filepath.Join(t.TempDir(), "state.json"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.bootstrap("tenant-a", "A", "owner"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.bootstrap("tenant-a", "A", "owner2"); err == nil {
		t.Fatal("duplicate tenant provisioned")
	}
	if _, err := s.issueHost("tenant-a", "missing", "local-company", "local-project"); err == nil {
		t.Fatal("unbound project credential issued")
	}
	if _, err := s.issueHuman("tenant-a", "other", "viewer", []string{"missing"}); err == nil {
		t.Fatal("foreign scope issued")
	}
	if err := s.revokeToken("missing"); err == nil {
		t.Fatal("missing token revocation accepted")
	}
}

func ExampleAPI() {
	fmt.Println("ND Cloud pilot uses explicit local bootstrap and loopback-only HTTP")
	// Output: ND Cloud pilot uses explicit local bootstrap and loopback-only HTTP
}

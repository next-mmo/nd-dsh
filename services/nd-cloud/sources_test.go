package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

func archiveFixture(t *testing.T, files map[string]string) []byte {
	t.Helper()
	var buf bytes.Buffer
	w := zip.NewWriter(&buf)
	for name, content := range files {
		f, err := w.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := f.Write([]byte(content)); err != nil {
			t.Fatal(err)
		}
	}
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	return buf.Bytes()
}

func sourceCall(p *pilot, method, path, token string, body []byte) *httptest.ResponseRecorder {
	p.t.Helper()
	r := httptest.NewRequest(method, path, bytes.NewReader(body))
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	if body != nil {
		r.Header.Set("Content-Type", "application/zip")
		r.Header.Set("X-ND-Source-Filename", "pos.zip")
	}
	w := httptest.NewRecorder()
	p.handler.ServeHTTP(w, r)
	return w
}

func TestSourceArchiveIsTenantScopedMetadataOnlyAndDeduplicated(t *testing.T) {
	p := createPilot(t)
	archive := archiveFixture(t, map[string]string{"src/main.go": "package main\n", "docs/guide.md": "# Checkout flow\n"})
	url := "/v1/projects/" + p.projectA + "/sources/zip"
	expectStatus(t, sourceCall(p, "POST", url, "", archive), 401)
	expectStatus(t, sourceCall(p, "POST", url, p.host, archive), 403)
	expectStatus(t, sourceCall(p, "POST", url, p.viewer, archive), 404)
	expectStatus(t, sourceCall(p, "POST", url, p.ownerB, archive), 404)
	expectStatus(t, sourceCall(p, "POST", url, p.ownerA, archive), 201)
	expectStatus(t, sourceCall(p, "POST", url, p.ownerA, archive), 409)
	a := p.call("GET", "/v1/projects/"+p.projectA+"/sources", p.ownerA, nil)
	expectStatus(t, a, 200)
	var response struct {
		Sources []SourceSnapshot `json:"sources"`
	}
	if err := json.Unmarshal(a.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if len(response.Sources) != 1 {
		t.Fatal(response.Sources)
	}
	actual := response.Sources[0]
	if actual.Status != "metadata-only" || len(actual.Files) != 2 || actual.Files[0].Path != "docs/guide.md" {
		t.Fatal(actual)
	}
	h := sha256.Sum256([]byte("# Checkout flow\n"))
	if actual.Files[0].SHA256 != hex.EncodeToString(h[:]) {
		t.Fatal("wrong file SHA")
	}
	if strings.Contains(a.Body.String(), "Checkout flow") || strings.Contains(a.Body.String(), "package main") {
		t.Fatal("raw source content leaked")
	}
	expectStatus(t, p.call("GET", "/v1/projects/"+p.projectA+"/sources", p.reviewer, nil), 200)
	expectStatus(t, p.call("GET", "/v1/projects/"+p.projectA+"/sources", p.viewer, nil), 404)
	expectStatus(t, p.call("GET", "/v1/projects/"+p.projectA+"/sources", p.ownerB, nil), 404)
	expectStatus(t, p.call("GET", "/v1/projects/"+p.projectB+"/sources/"+actual.ID, p.ownerA, nil), 404)
	expectStatus(t, p.call("GET", "/v1/projects/"+p.projectA+"/sources/"+actual.ID, p.ownerA, nil), 200)
	reloaded, err := openStore(p.path)
	if err != nil {
		t.Fatal(err)
	}
	reloaded.read(func(st State) {
		if len(st.Sources) != 1 {
			t.Fatal("source snapshot did not persist")
		}
	})
}

func TestUnsafeZipsRejectedWithoutSideEffects(t *testing.T) {
	p := createPilot(t)
	bad := []map[string]string{
		{"../escape.md": "bad"}, {"/root.md": "bad"}, {"C:/secret.md": "bad"},
		{"a\\b.md": "bad"}, {"node_modules/evil.js": "bad"}, {".env": "secret"},
		{"docs/.env.local": "secret"}, {"bin/run.exe": "script"},
		{"One.md": "a", "one.md": "b"}, {"doc.md": strings.Repeat("X", maxSourceFileBytes+1)},
	}
	for _, files := range bad {
		archive := archiveFixture(t, files)
		w := sourceCall(p, "POST", "/v1/projects/"+p.projectA+"/sources/zip", p.ownerA, archive)
		expectStatus(t, w, 400)
	}
	many := map[string]string{}
	for i := 0; i <= maxSourceFiles; i++ {
		many["docs/"+strings.Repeat("x", i%12)+string(rune(i+0x100))+".md"] = "hello"
	}
	_, _, err := inspectSourceZIP(archiveFixture(t, many))
	if err == nil {
		t.Fatal("file-count limit bypass")
	}
	var empty bytes.Buffer
	w := zip.NewWriter(&empty)
	if err := w.Close(); err != nil {
		t.Fatal(err)
	}
	_, _, err = inspectSourceZIP(empty.Bytes())
	if err == nil {
		t.Fatal("empty ZIP accepted")
	}
	p.store.read(func(st State) {
		if len(st.Sources) != 0 {
			t.Fatal("unsafe imports persisted")
		}
	})
}

func TestZipSymlinkAndUnsupportedHeaders(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	h := &zip.FileHeader{Name: "docs/link.md", Method: zip.Deflate}
	h.SetMode(os.ModeSymlink | 0777)
	f, err := zw.CreateHeader(h)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = f.Write([]byte("../secret")); err != nil {
		t.Fatal(err)
	}
	if err = zw.Close(); err != nil {
		t.Fatal(err)
	}
	_, _, err = inspectSourceZIP(buf.Bytes())
	if err == nil {
		t.Fatal("symlink should be rejected")
	}
}

func TestSourceImportQuotaAndRevokedMembership(t *testing.T) {
	p := createPilot(t)
	archive := archiveFixture(t, map[string]string{"README.md": "small"})
	url := "/v1/projects/" + p.projectA + "/sources/zip"
	err := p.store.transact(func(st *State) error {
		for i := 0; i < maxProjectSnapshots; i++ {
			id := fmt.Sprintf("src_demo_%d", i)
			st.Sources[id] = SourceSnapshot{ID: id, TenantID: "tenant-a", ProjectID: p.projectA, ArtifactSHA256: fmt.Sprintf("hash_%d", i)}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	expectStatus(t, sourceCall(p, "POST", url, p.ownerA, archive), 400)
	// Remove the cap fixtures and revoke the owner credential: reads and writes
	// must both fail even if the caller retained a previously valid token.
	err = p.store.transact(func(st *State) error { st.Sources = map[string]SourceSnapshot{}; return nil })
	if err != nil {
		t.Fatal(err)
	}
	var tokenID string
	p.store.read(func(st State) { tokenID = st.Tokens[tokenHash(p.ownerA)].ID })
	if err := p.store.revokeToken(tokenID); err != nil {
		t.Fatal(err)
	}
	expectStatus(t, sourceCall(p, "POST", url, p.ownerA, archive), 401)
	expectStatus(t, p.call("GET", "/v1/projects/"+p.projectA+"/sources", p.ownerA, nil), 401)
}

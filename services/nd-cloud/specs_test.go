package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func createSpecFixture(t *testing.T, p *pilot, path, body string) (HumanSpec, SourceSnapshot) {
	t.Helper()
	base := "/v1/projects/" + p.projectA
	upload := sourceCall(p, "POST", base+"/sources/zip", p.ownerA, archiveFixture(t, map[string]string{path: body}))
	expectStatus(t, upload, 201)
	var source SourceSnapshot
	if err := json.Unmarshal(upload.Body.Bytes(), &source); err != nil {
		t.Fatal(err)
	}
	req := map[string]string{"source_snapshot_id": source.ID, "source_path": path, "title": "Human POS specification", "body": "Require approval for refunds"}
	created := p.call("POST", base+"/specs", p.ownerA, req)
	expectStatus(t, created, 201)
	var spec HumanSpec
	if err := json.Unmarshal(created.Body.Bytes(), &spec); err != nil {
		t.Fatal(err)
	}
	return spec, source
}

func TestHumanSpecReviewRevisionIsolationAndConflict(t *testing.T) {
	p := createPilot(t)
	base := "/v1/projects/" + p.projectA
	spec, source := createSpecFixture(t, p, "docs/refund.md", "# Refund v1\n")
	if spec.Status != "draft" || spec.SourceSHA256 != source.Files[0].SHA256 || len(spec.History) != 1 {
		t.Fatal("draft provenance missing")
	}
	expectStatus(t, p.call("GET", base+"/specs", p.viewer, nil), 200)
	if strings.Contains(p.call("GET", base+"/specs", p.viewer, nil).Body.String(), spec.ID) {
		t.Fatal("private draft leaked")
	}
	if strings.Contains(p.call("GET", base+"/specs", p.ownerB, nil).Body.String(), spec.ID) {
		t.Fatal("cross-tenant spec leaked")
	}
	approve := base + "/specs/" + spec.ID + "/approve"
	expectStatus(t, p.call("POST", approve, p.ownerA, map[string]int64{"expected_revision": 1}), 403)
	expectStatus(t, p.call("POST", approve, p.ownerB, map[string]int64{"expected_revision": 1}), 404)
	expectStatus(t, p.call("POST", approve, p.viewer, map[string]int64{"expected_revision": 1}), 403)
	r := p.call("POST", approve, p.reviewer, map[string]int64{"expected_revision": 1})
	expectStatus(t, r, 200)
	var approved HumanSpec
	if err := json.Unmarshal(r.Body.Bytes(), &approved); err != nil {
		t.Fatal(err)
	}
	if approved.Status != "approved" || approved.Reviewer != "reviewer-a" || len(approved.History) != 2 {
		t.Fatal("approval not recorded")
	}
	expectStatus(t, p.call("POST", approve, p.reviewer, map[string]int64{"expected_revision": 1}), 409)
	visible := p.call("GET", base+"/specs", p.viewer, nil)
	expectStatus(t, visible, 200)
	if !strings.Contains(visible.Body.String(), spec.ID) || strings.Contains(visible.Body.String(), `"history"`) {
		t.Fatal("approved scope or private history leaked")
	}
	// New ZIP with unchanged pinned file must preserve review, even if other files change.
	expectStatus(t, sourceCall(p, "POST", base+"/sources/zip", p.ownerA, archiveFixture(t, map[string]string{"docs/refund.md": "# Refund v1\n", "other.md": "new file"})), 201)
	current := p.call("GET", base+"/specs", p.viewer, nil)
	if !strings.Contains(current.Body.String(), spec.ID) {
		t.Fatal("unchanged source wrongly invalidated")
	}
	// Content drift revokes the old approval; viewers must not see the spec.
	newUpload := sourceCall(p, "POST", base+"/sources/zip", p.ownerA, archiveFixture(t, map[string]string{"docs/refund.md": "# Refund v2\n"}))
	expectStatus(t, newUpload, 201)
	var next SourceSnapshot
	if err := json.Unmarshal(newUpload.Body.Bytes(), &next); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(p.call("GET", base+"/specs", p.viewer, nil).Body.String(), spec.ID) {
		t.Fatal("stale approved spec still visible")
	}
	expectStatus(t, p.call("POST", approve, p.reviewer, map[string]int64{"expected_revision": 3}), 409)
	// Rebase to the latest snapshot; stale and cross-project references fail.
	revisionURL := base + "/specs/" + spec.ID + "/revise"
	update := map[string]any{"expected_revision": 3, "source_snapshot_id": next.ID, "source_path": "docs/refund.md", "title": "Refund policy v2", "body": "Verify refund role v2"}
	expectStatus(t, p.call("POST", revisionURL, p.viewer, update), 403)
	expectStatus(t, p.call("POST", revisionURL, p.ownerB, update), 404)
	expectStatus(t, p.call("POST", revisionURL, p.ownerA, update), 200)
	expectStatus(t, p.call("POST", revisionURL, p.ownerA, update), 409)
	expectStatus(t, p.call("POST", approve, p.ownerA, map[string]int64{"expected_revision": 4}), 403)
	expectStatus(t, p.call("POST", approve, p.reviewer, map[string]int64{"expected_revision": 4}), 200)
	reloaded, err := openStore(p.path)
	if err != nil {
		t.Fatal(err)
	}
	reloaded.read(func(st State) {
		s := st.Specs[spec.ID]
		if s.Status != "approved" || s.Revision != 5 || len(s.History) != 5 || s.History[2].Action != "source_conflict" {
			t.Fatalf("lost history: %+v", s)
		}
	})
}

func TestSpecRejectsMissingSourceAndRevokedAccess(t *testing.T) {
	p := createPilot(t)
	spec, src := createSpecFixture(t, p, "docs/policy.md", "# Policy\n")
	route := "/v1/projects/" + p.projectA
	invalid := map[string]string{"source_snapshot_id": src.ID, "source_path": "missing.md", "title": "bad", "body": "a"}
	expectStatus(t, p.call("POST", route+"/specs", p.ownerA, invalid), 400)
	// A second project must not be able to reference source manifests in project A.
	expectStatus(t, p.call("POST", "/v1/projects/"+p.projectB+"/specs", p.ownerA, map[string]string{"source_snapshot_id": src.ID, "source_path": "docs/policy.md", "title": "No", "body": "bad"}), 400)
	var reviewerTokenID string
	p.store.read(func(st State) { reviewerTokenID = st.Tokens[tokenHash(p.reviewer)].ID })
	if err := p.store.revokeToken(reviewerTokenID); err != nil {
		t.Fatal(err)
	}
	expectStatus(t, p.call("POST", route+"/specs/"+spec.ID+"/approve", p.reviewer, map[string]int64{"expected_revision": 1}), 401)
	expectStatus(t, p.call("GET", route+"/specs", p.reviewer, nil), 401)
}

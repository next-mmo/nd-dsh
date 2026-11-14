package main

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func TestWikiIndependentReviewSourceDriftAndTenantScope(t *testing.T) {
	p := createPilot(t)
	prefix := "/v1/projects/" + p.projectA
	archive := archiveFixture(t, map[string]string{"docs/guide.md": "# Refund Guide\n", "src/pos.go": "package pos\n"})
	expectStatus(t, sourceCall(p, "POST", prefix+"/sources/zip", p.ownerA, archive), 201)
	pages := p.call("GET", prefix+"/wiki/pages", p.ownerA, nil)
	expectStatus(t, pages, 200)
	var result struct {
		Pages []WikiPage `json:"pages"`
	}
	if err := json.Unmarshal(pages.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Pages) != 1 || !result.Pages[0].Generated || result.Pages[0].Status != "draft" {
		t.Fatalf("missing inventory wiki draft: %v", result)
	}
	page := result.Pages[0]
	expectStatus(t, p.call("GET", prefix+"/wiki/pages", p.viewer, nil), 200)
	if strings.Contains(p.call("GET", prefix+"/wiki/pages", p.viewer, nil).Body.String(), page.ID) {
		t.Fatal("viewer can read private draft")
	}
	expectStatus(t, p.call("POST", prefix+"/wiki/pages/"+page.ID+"/publish", p.ownerA, map[string]int64{"expected_revision": 1}), 403)
	expectStatus(t, p.call("POST", prefix+"/wiki/pages/"+page.ID+"/publish", p.ownerB, map[string]int64{"expected_revision": 1}), 404)
	expectStatus(t, p.call("POST", prefix+"/wiki/pages/"+page.ID+"/publish", p.reviewer, map[string]int64{"expected_revision": 1}), 200)
	expectStatus(t, p.call("POST", prefix+"/wiki/pages/"+page.ID+"/publish", p.reviewer, map[string]int64{"expected_revision": 1}), 409)
	expectStatus(t, p.call("GET", prefix+"/wiki/search?q=source+inventory", p.viewer, nil), 200)
	expectStatus(t, p.call("GET", "/v1/projects/"+p.projectB+"/wiki/search?q=source+inventory", p.viewer, nil), 404)
	expectStatus(t, p.call("GET", prefix+"/wiki/search?q=source+inventory", p.ownerB, nil), 404)
	expectStatus(t, sourceCall(p, "POST", prefix+"/sources/zip", p.ownerA, archiveFixture(t, map[string]string{"docs/guide.md": "# Changed Guide\n"})), 201)
	expectStatus(t, p.call("GET", prefix+"/wiki/search?q=source+inventory", p.viewer, nil), 200)
	if strings.Contains(p.call("GET", prefix+"/wiki/search?q=source+inventory", p.viewer, nil).Body.String(), page.ID) {
		t.Fatal("stale page visible as published")
	}
	expectStatus(t, p.call("POST", prefix+"/wiki/pages/"+page.ID+"/publish", p.reviewer, map[string]int64{"expected_revision": 2}), 409)
	reloaded, err := openStore(p.path)
	if err != nil {
		t.Fatal(err)
	}
	reloaded.read(func(st State) {
		if st.SchemaVersion != schemaVersion || st.WikiPages[page.ID].Status != "stale" {
			t.Fatal("wiki drift lost on restart")
		}
	})
}

func TestHumanWikiDraftScopedToExactSourceFile(t *testing.T) {
	p := createPilot(t)
	prefix := "/v1/projects/" + p.projectA
	w := sourceCall(p, "POST", prefix+"/sources/zip", p.ownerA, archiveFixture(t, map[string]string{"docs/help.md": "# Help\n"}))
	expectStatus(t, w, 201)
	var source SourceSnapshot
	if err := json.Unmarshal(w.Body.Bytes(), &source); err != nil {
		t.Fatal(err)
	}
	input := map[string]string{"source_snapshot_id": source.ID, "source_path": "docs/help.md", "title": "POS Help", "body": "Follow the approved SOP after review."}
	expectStatus(t, p.call("POST", prefix+"/wiki/pages", p.viewer, input), 403)
	expectStatus(t, p.call("POST", prefix+"/wiki/pages", p.ownerB, input), 404)
	wrong := map[string]string{"source_snapshot_id": source.ID, "source_path": "not-found.md", "title": "POS Help", "body": "test"}
	expectStatus(t, p.call("POST", prefix+"/wiki/pages", p.ownerA, wrong), 400)
	created := p.call("POST", prefix+"/wiki/pages", p.ownerA, input)
	expectStatus(t, created, 201)
	var page WikiPage
	if err := json.Unmarshal(created.Body.Bytes(), &page); err != nil {
		t.Fatal(err)
	}
	if page.SourceSHA256 != source.Files[0].SHA256 || page.Status != "draft" {
		t.Fatalf("missing provenance: %+v", page)
	}
	expectStatus(t, p.call("POST", prefix+"/wiki/pages/"+page.ID+"/publish", p.reviewer, map[string]int64{"expected_revision": 1}), 200)
}

func TestReplayDedupCursorGapAndRevocation(t *testing.T) {
	p := createPilot(t)
	prefix := "/v1/projects/" + p.projectA
	b := p.board(1)
	expectStatus(t, p.call("PUT", prefix+"/board", p.host, b), 201)
	expectStatus(t, p.call("PUT", prefix+"/board", p.host, b), 200)
	got := p.call("GET", prefix+"/events?after=0&limit=1", p.viewer, nil)
	expectStatus(t, got, 200)
	var data struct {
		Events       []ProjectEvent `json:"events"`
		NextCursor   uint64         `json:"next_cursor"`
		LatestCursor uint64         `json:"latest_cursor"`
	}
	if err := json.Unmarshal(got.Body.Bytes(), &data); err != nil {
		t.Fatal(err)
	}
	if len(data.Events) != 1 || data.Events[0].Kind != "board.revision" || data.LatestCursor != 1 {
		t.Fatalf("events duplicated: %+v", data)
	}
	expectStatus(t, p.call("GET", prefix+"/events?after=1", p.viewer, nil), 200)
	expectStatus(t, p.call("GET", prefix+"/events?after=2", p.viewer, nil), 409)
	expectStatus(t, p.call("GET", prefix+"/events?after=-1", p.viewer, nil), 400)
	expectStatus(t, p.call("GET", "/v1/projects/"+p.projectB+"/events", p.viewer, nil), 404)
	expectStatus(t, p.call("GET", prefix+"/sync/status", p.ownerA, nil), 200)
	// The last 1024 events are retained, and old cursors must resnapshot.
	if err := p.store.transact(func(st *State) error {
		for i := 0; i < maxProjectEvents+3; i++ {
			appendProjectEvent(st, p.projectA, "test.event", fmt.Sprintf("id-%d", i), int64(i))
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	expectStatus(t, p.call("GET", prefix+"/events?after=0", p.viewer, nil), 409)
	var tokenID string
	p.store.read(func(st State) { tokenID = st.Tokens[tokenHash(p.viewer)].ID })
	if err := p.store.revokeToken(tokenID); err != nil {
		t.Fatal(err)
	}
	expectStatus(t, p.call("GET", prefix+"/events", p.viewer, nil), 401)
}

func TestTaskProposalsIdempotencyIndependentPMAndHostReceipt(t *testing.T) {
	p := createPilot(t)
	prefix := "/v1/projects/" + p.projectA
	caseResp := p.call("POST", prefix+"/support/cases", p.viewer, map[string]string{"subject": "POS bug", "description": "Cannot refund"})
	expectStatus(t, caseResp, 201)
	var c SupportCase
	if err := json.Unmarshal(caseResp.Body.Bytes(), &c); err != nil {
		t.Fatal(err)
	}
	url := prefix + "/support/cases/" + c.ID + "/task-proposals"
	input := map[string]any{"expected_case_revision": 1, "idempotency_key": "case-001", "text": "Investigate refund path"}
	expectStatus(t, p.call("POST", url, p.viewer, input), 403)
	first := p.call("POST", url, p.reviewer, input)
	expectStatus(t, first, 201)
	var proposal TaskProposal
	if err := json.Unmarshal(first.Body.Bytes(), &proposal); err != nil {
		t.Fatal(err)
	}
	expectStatus(t, p.call("POST", url, p.reviewer, input), 200)
	wrong := map[string]any{"expected_case_revision": 1, "idempotency_key": "case-001", "text": "Conflicting body"}
	expectStatus(t, p.call("POST", url, p.reviewer, wrong), 409)
	expectStatus(t, p.call("GET", prefix+"/task-proposals", p.viewer, nil), 403)
	expectStatus(t, p.call("GET", prefix+"/task-proposals", p.ownerB, nil), 404)
	approval := prefix + "/task-proposals/" + proposal.ID + "/approve"
	expectStatus(t, p.call("POST", approval, p.reviewer, map[string]int64{"expected_revision": 1}), 403)
	expectStatus(t, p.call("POST", approval, p.ownerA, map[string]int64{"expected_revision": 1}), 200)
	expectStatus(t, p.call("POST", approval, p.ownerA, map[string]int64{"expected_revision": 1}), 409)
	receipt := prefix + "/task-proposals/" + proposal.ID + "/host-receipt"
	expectStatus(t, p.call("POST", receipt, p.ownerA, map[string]any{"expected_revision": 2, "decision": "accepted", "nd_task_id": "task-local"}), 403)
	expectStatus(t, p.call("POST", receipt, p.host, map[string]any{"expected_revision": 2, "decision": "accepted", "nd_task_id": "task-local"}), 200)
	expectStatus(t, p.call("POST", receipt, p.host, map[string]any{"expected_revision": 2, "decision": "accepted", "nd_task_id": "task-local"}), 409)
	p.store.read(func(st State) {
		if len(st.Proposals) != 1 || st.Proposals[proposal.ID].Status != "host-reported-accepted" || len(st.Boards) != 0 {
			t.Fatal("proposal duplicated or execution implied")
		}
	})
	reloaded, err := openStore(p.path)
	if err != nil {
		t.Fatal(err)
	}
	reloaded.read(func(st State) {
		if st.Proposals[proposal.ID].NDTaskID != "task-local" {
			t.Fatal("missing recovery receipt")
		}
	})
}

func TestSyncStatusNeverClaimsConnectivityFromRecentUpload(t *testing.T) {
	p := createPilot(t)
	prefix := "/v1/projects/" + p.projectA
	body := p.call("GET", prefix+"/sync/status", p.viewer, nil).Body.String()
	if !strings.Contains(body, "never-synced") || !strings.Contains(body, "\"host_online\":false") {
		t.Fatal(body)
	}
	expectStatus(t, p.call("PUT", prefix+"/board", p.host, p.board(1)), 201)
	body = p.call("GET", prefix+"/sync/status", p.viewer, nil).Body.String()
	if !strings.Contains(body, "recent-projection") || !strings.Contains(body, "\"host_online\":false") {
		t.Fatal(body)
	}
	err := p.store.transact(func(st *State) error {
		board := st.Boards[p.projectA]
		board.ReceivedAt = time.Now().Add(-10 * time.Minute)
		st.Boards[p.projectA] = board
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	body = p.call("GET", prefix+"/sync/status", p.viewer, nil).Body.String()
	if !strings.Contains(body, "stale-projection") {
		t.Fatal(body)
	}
}

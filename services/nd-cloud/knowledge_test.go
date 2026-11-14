package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestKnowledgeIndependentReviewProjectAndReleaseIsolation(t *testing.T) {
	p := createPilot(t)
	base := "/v1/projects/" + p.projectA
	cardInput := map[string]any{
		"app_release": "v1.2.0",
		"question":    "How do I refund an order?",
		"answer":      "Open Orders and select the refund option after authorization.",
		"citations":   []map[string]string{{"url": "https://example.com/pos/blob/a1b2c3/README.md", "revision": "a1b2c3", "label": "POS manual"}},
	}
	ask := func(project, token, release, question string) *stringResult {
		t.Helper()
		w := p.call("POST", "/v1/projects/"+project+"/assist/lookup", token, map[string]string{"app_release": release, "question": question})
		var body map[string]any
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatal(err)
		}
		return &stringResult{code: w.Code, body: body}
	}
	draft := p.call("POST", base+"/knowledge/cards", p.ownerA, cardInput)
	expectStatus(t, draft, 201)
	var c KnowledgeCard
	if err := json.Unmarshal(draft.Body.Bytes(), &c); err != nil {
		t.Fatal(err)
	}
	if c.Status != "draft" || c.Author != "owner-a" {
		t.Fatal(c)
	}
	lookup := ask(p.projectA, p.viewer, "v1.2.0", "How do I refund an order?")
	if lookup.code != 200 || lookup.body["status"] != "unknown" {
		t.Fatal(lookup)
	}
	if w := p.call("GET", base+"/knowledge/cards", p.viewer, nil); strings.Contains(w.Body.String(), c.ID) {
		t.Fatal("draft exposed to customer")
	}
	pub := base + "/knowledge/cards/" + c.ID + "/publish"
	expectStatus(t, p.call("POST", pub, p.ownerA, map[string]int64{"expected_revision": 1}), 403)
	expectStatus(t, p.call("POST", pub, p.viewer, map[string]int64{"expected_revision": 1}), 403)
	expectStatus(t, p.call("POST", pub, p.ownerB, map[string]int64{"expected_revision": 1}), 404)
	expectStatus(t, p.call("POST", pub, p.reviewer, map[string]int64{"expected_revision": 1}), 200)
	expectStatus(t, p.call("POST", pub, p.reviewer, map[string]int64{"expected_revision": 1}), 409)
	lookup = ask(p.projectA, p.viewer, "v1.2.0", " how do i refund an order? ")
	if lookup.code != 200 || lookup.body["status"] != "unverified" || lookup.body["reviewed"] != true || lookup.body["auto_demo_allowed"] != false {
		t.Fatal(lookup)
	}
	if len(lookup.body["citations"].([]any)) != 1 {
		t.Fatal("missing source citation")
	}
	for _, test := range []struct {
		project, token, release string
		status                  int
		result                  string
	}{
		{p.projectB, p.ownerA, "v1.2.0", 200, "unknown"},
		{p.projectOther, p.ownerB, "v1.2.0", 200, "unknown"},
		{p.projectA, p.viewer, "v1.3.0", 200, "unknown"},
		{p.projectA, p.ownerB, "v1.2.0", 404, ""},
	} {
		r := ask(test.project, test.token, test.release, "How do I refund an order?")
		if r.code != test.status || r.code == 200 && r.body["status"] != test.result {
			t.Fatalf("unexpected lookup: %+v", r)
		}
	}
}

type stringResult struct {
	code int
	body map[string]any
}

func TestKnowledgeNewApprovedVersionMakesOldStale(t *testing.T) {
	p := createPilot(t)
	base := "/v1/projects/" + p.projectA + "/knowledge/cards"
	payload := map[string]any{"app_release": "v1", "question": "Where are receipts?", "answer": "Open the Receipt History menu to view receipts.", "citations": []map[string]string{{"url": "https://example.com/repo/blob/a1b2c3/docs.md", "revision": "a1b2c3", "label": "guide"}}}
	makeCard := func() KnowledgeCard {
		w := p.call("POST", base, p.ownerA, payload)
		expectStatus(t, w, 201)
		var c KnowledgeCard
		if err := json.Unmarshal(w.Body.Bytes(), &c); err != nil {
			t.Fatal(err)
		}
		expectStatus(t, p.call("POST", base+"/"+c.ID+"/publish", p.reviewer, map[string]int64{"expected_revision": 1}), 200)
		return c
	}
	first := makeCard()
	second := makeCard()
	if first.ID == second.ID {
		t.Fatal("duplicate card ID")
	}
	p.store.read(func(st State) {
		if st.Cards[first.ID].Status != "stale" || st.Cards[second.ID].Status != "published" {
			t.Fatal("stale guide still published")
		}
	})
}

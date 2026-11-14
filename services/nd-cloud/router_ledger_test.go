package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
)

func TestDemoLedgerBalancedIdempotentConcurrent(t *testing.T) {
	p := createPilot(t)
	url := "/v1/projects/" + p.projectA + "/ledger"
	grant := map[string]any{"idempotency_key": "seed-1", "units": 1000}
	expectStatus(t, p.call("POST", url+"/demo-grant", p.viewer, grant), 403)
	expectStatus(t, p.call("POST", url+"/demo-grant", p.ownerB, grant), 404)
	expectStatus(t, p.call("POST", url+"/demo-grant", p.ownerA, grant), 201)
	expectStatus(t, p.call("POST", url+"/demo-grant", p.ownerA, grant), 200)
	expectStatus(t, p.call("POST", url+"/demo-grant", p.ownerA, map[string]any{"idempotency_key": "seed-1", "units": 500}), 409)
	expectStatus(t, p.call("GET", url, p.viewer, nil), 403)
	expectStatus(t, p.call("GET", url, p.ownerB, nil), 404)
	expectStatus(t, p.call("GET", url, p.ownerA, nil), 200)
	var wg sync.WaitGroup
	successes := int64(0)
	for i := 0; i < 20; i++ {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			w := p.call("POST", url+"/reservations", p.reviewer, map[string]any{"idempotency_key": fmt.Sprintf("i-%d", i), "units": 100})
			if w.Code == 201 {
				atomic.AddInt64(&successes, 1)
			} else if w.Code != 409 {
				t.Errorf("unexpected %d", w.Code)
			}
		}(i)
	}
	wg.Wait()
	if successes != 10 {
		t.Fatalf("expected 10 reservations for 1000 units, got %d", successes)
	}
	var one Reservation
	p.store.read(func(st State) {
		b := ledgerBalances(st, p.projectA)
		if b["available"] != 0 || b["reserved"] != 1000 || b["spent"] != 0 || b["issuer"] != -1000 {
			t.Fatalf("wrong balances %v", b)
		}
		for _, res := range st.Reservations {
			one = res
			break
		}
		for _, tx := range st.Ledgers[p.projectA] {
			sum := int64(0)
			for _, leg := range tx.Legs {
				sum += leg.Units
			}
			if sum != 0 {
				t.Fatalf("unbalanced ledger %+v", tx)
			}
		}
	})
	settled := url + "/reservations/" + one.ID + "/settle"
	expectStatus(t, p.call("POST", settled, p.reviewer, map[string]int64{"actual_units": 30}), 200)
	expectStatus(t, p.call("POST", settled, p.reviewer, map[string]int64{"actual_units": 30}), 409)
	p.store.read(func(st State) {
		b := ledgerBalances(st, p.projectA)
		if b["available"] != 70 || b["reserved"] != 900 || b["spent"] != 30 {
			t.Fatalf("wrong settled balance %v", b)
		}
	})
	reloaded, err := openStore(p.path)
	if err != nil {
		t.Fatal(err)
	}
	reloaded.read(func(st State) {
		b := ledgerBalances(st, p.projectA)
		if b["available"] != 70 || b["spent"] != 30 {
			t.Fatal("ledger lost on restart")
		}
	})
}

func TestBYOKStreamLabStrictProjectScopeMeteringAndNoCredentialPersistence(t *testing.T) {
	p := createPilot(t)
	prefix := "/v1/projects/" + p.projectA
	expectStatus(t, p.call("POST", prefix+"/router/credentials", p.ownerA, map[string]string{"api_key": "sk-local-example-token", "model": "demo-model"}), 503)
	var upstreamCalls atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		upstreamCalls.Add(1)
		if r.Header.Get("Authorization") != "Bearer sk-test-secret-123" {
			t.Errorf("wrong upstream auth")
		}
		if r.URL.Path != "/chat" {
			t.Errorf("wrong path: %s", r.URL.Path)
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"OK\"}}]}\n\n")
		fmt.Fprint(w, "data: {\"usage\":{\"prompt_tokens\":5,\"completion_tokens\":6}}\n\n")
		fmt.Fprint(w, "data: [DONE]\n\n")
	}))
	defer upstream.Close()
	lab := newRouterLab()
	lab.upstream = upstream.URL + "/chat"
	lab.client = upstream.Client()
	p.handler = newAPIWithRouter(p.store, lab)
	cred := map[string]string{"api_key": "sk-test-secret-123", "model": "demo-model"}
	expectStatus(t, p.call("POST", prefix+"/router/credentials", p.viewer, cred), 403)
	expectStatus(t, p.call("POST", prefix+"/router/credentials", p.ownerB, cred), 403)
	expectStatus(t, p.call("POST", prefix+"/router/credentials", p.ownerA, cred), 200)
	expectStatus(t, p.call("GET", prefix+"/router/status", p.viewer, nil), 200)
	expectStatus(t, p.call("GET", prefix+"/router/status", p.ownerB, nil), 404)
	req := RouterChatRequest{RequestID: "stream-1", Messages: []RouterChatMessage{{Role: "user", Content: "Hello"}}, MaxOutputTokens: 64}
	expectStatus(t, p.call("POST", prefix+"/router/chat/stream", p.ownerA, req), 409) // no quota
	if upstreamCalls.Load() != 0 {
		t.Fatal("provider called without quota")
	}
	expectStatus(t, p.call("POST", prefix+"/ledger/demo-grant", p.ownerA, map[string]any{"idempotency_key": "fund-1", "units": 1000}), 201)
	expectStatus(t, p.call("POST", prefix+"/router/chat/stream", p.ownerB, req), 404)
	w := p.call("POST", prefix+"/router/chat/stream", p.ownerA, req)
	expectStatus(t, w, 200)
	if !strings.Contains(w.Body.String(), "\"content\":\"OK\"") || strings.Contains(w.Body.String(), "sk-test-secret-123") {
		t.Fatal("invalid SSE or key leak")
	}
	expectStatus(t, p.call("POST", prefix+"/router/chat/stream", p.ownerA, req), 409) // one request ID / one charge
	if upstreamCalls.Load() != 1 {
		t.Fatal("duplicate upstream invocation")
	}
	got := p.call("GET", prefix+"/router/attempts", p.ownerA, nil)
	expectStatus(t, got, 200)
	var result struct {
		Attempts []RouterAttempt `json:"attempts"`
	}
	if err := json.Unmarshal(got.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	if len(result.Attempts) != 1 || !result.Attempts[0].ProviderMeasured || result.Attempts[0].SpentDemoUnits != 11 || result.Attempts[0].Status != "completed" {
		t.Fatalf("wrong receipt %+v", result)
	}
	expectStatus(t, p.call("GET", prefix+"/router/attempts", p.viewer, nil), 403)
	b, err := os.ReadFile(p.path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(b), "sk-test-secret-123") || strings.Contains(got.Body.String(), "sk-test-secret-123") {
		t.Fatal("BYOK credential persisted or disclosed")
	}
}

func TestBYOKUpstreamErrorRefundsDemoUnitsAndDoesNotLeakBody(t *testing.T) {
	p := createPilot(t)
	prefix := "/v1/projects/" + p.projectA
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(429)
		fmt.Fprint(w, "PRIVATE_PROVIDER_ERROR_TOKEN")
	}))
	defer upstream.Close()
	lab := newRouterLab()
	lab.upstream = upstream.URL
	lab.client = upstream.Client()
	p.handler = newAPIWithRouter(p.store, lab)
	expectStatus(t, p.call("POST", prefix+"/router/credentials", p.ownerA, map[string]string{"api_key": "sk-test-secret-123", "model": "demo"}), 200)
	expectStatus(t, p.call("POST", prefix+"/ledger/demo-grant", p.ownerA, map[string]any{"idempotency_key": "fund", "units": 1000}), 201)
	req := RouterChatRequest{RequestID: "failed-1", Messages: []RouterChatMessage{{Role: "user", Content: "Hello"}}, MaxOutputTokens: 50}
	w := p.call("POST", prefix+"/router/chat/stream", p.ownerA, req)
	expectStatus(t, w, 502)
	if strings.Contains(w.Body.String(), "PRIVATE_PROVIDER_ERROR_TOKEN") {
		t.Fatal("upstream content leaked")
	}
	p.store.read(func(st State) {
		b := ledgerBalances(st, p.projectA)
		if b["available"] != 1000 || b["reserved"] != 0 {
			t.Fatal("upstream error did not return demo quota", b)
		}
		if len(st.RouterAttempts) != 1 {
			t.Fatal("missing attempt receipt")
		}
	})
}

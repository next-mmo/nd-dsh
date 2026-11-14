package main

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Optional, single-process BYOK streaming lab. NO stored credentials, billing,
// arbitrary upstream URLs or resale claims. The only production constructor
// points at the exact HTTPS OpenAI endpoint; test transports are injected by
// code, never by a caller-controlled API request.
type routerCredential struct{ APIKey, Model string }
type RouterLab struct {
	mu       sync.RWMutex
	keys     map[string]routerCredential
	upstream string
	client   *http.Client
}

func newRouterLab() *RouterLab {
	return &RouterLab{keys: make(map[string]routerCredential), upstream: "https://api.openai.com/v1/chat/completions",
		client: &http.Client{Timeout: 45 * time.Second, CheckRedirect: func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }}}
}
func (r *RouterLab) configured(project string) (routerCredential, bool) {
	r.mu.RLock()
	defer r.mu.RUnlock()
	c, ok := r.keys[project]
	return c, ok
}

var modelPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,95}$`)

type RouterAttempt struct {
	ID                       string    `json:"id"`
	ProjectID                string    `json:"project_id"`
	TenantID                 string    `json:"tenant_id"`
	Subject                  string    `json:"subject"`
	Model                    string    `json:"model"`
	Status                   string    `json:"status"` // completed, upstream-error, interrupted, usage-unmeasured
	ProviderPromptTokens     int64     `json:"provider_prompt_tokens"`
	ProviderCompletionTokens int64     `json:"provider_completion_tokens"`
	ReservedDemoUnits        int64     `json:"reserved_demo_units"`
	SpentDemoUnits           int64     `json:"spent_demo_units"`
	ProviderMeasured         bool      `json:"provider_measured"`
	CreatedAt                time.Time `json:"created_at"`
}

func (a *API) setRouterCredential(w http.ResponseWriter, r *http.Request) {
	p, ok := a.auth(w, r, "human")
	if !ok {
		return
	}
	if a.router == nil {
		failure(w, 503, "router lab disabled")
		return
	}
	projectID := r.PathValue("project")
	var in struct {
		APIKey string `json:"api_key"`
		Model  string `json:"model"`
	}
	if !decode(w, r, &in, 4096) {
		return
	}
	if len(in.APIKey) < 12 || len(in.APIKey) > 1024 || strings.ContainsAny(in.APIKey, " \r\n\t") || !modelPattern.MatchString(in.Model) {
		failure(w, 400, "invalid BYOK configuration")
		return
	}
	allowed := false
	a.store.read(func(st State) { m, _, has := memberProject(st, p, projectID); allowed = has && m.Role == "owner" })
	if !allowed {
		failure(w, 403, "capability denied")
		return
	}
	a.router.mu.Lock()
	a.router.keys[projectID] = routerCredential{APIKey: in.APIKey, Model: in.Model}
	a.router.mu.Unlock()
	respond(w, 200, map[string]any{"provider": "openai", "configured": true, "model": in.Model, "credential_stored": false, "streaming": "lab-only"})
}
func (a *API) getRouterStatus(w http.ResponseWriter, r *http.Request) {
	p, ok := a.auth(w, r, "human")
	if !ok {
		return
	}
	projectID := r.PathValue("project")
	allowed := false
	a.store.read(func(st State) { _, _, allowed = memberProject(st, p, projectID) })
	if !allowed {
		failure(w, 404, "not found")
		return
	}
	if a.router == nil {
		respond(w, 200, map[string]any{"enabled": false, "configured": false})
		return
	}
	cred, found := a.router.configured(projectID)
	respond(w, 200, map[string]any{"enabled": true, "configured": found, "model": cred.Model, "persistent_keys": false, "paid_access": false})
}

type RouterChatMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}
type RouterChatRequest struct {
	RequestID       string              `json:"request_id"`
	Messages        []RouterChatMessage `json:"messages"`
	MaxOutputTokens int64               `json:"max_output_tokens"`
}

func validRouterChat(in RouterChatRequest) bool {
	if !validID(in.RequestID) || len(in.Messages) < 1 || len(in.Messages) > 12 || in.MaxOutputTokens < 1 || in.MaxOutputTokens > 512 {
		return false
	}
	total := 0
	for _, message := range in.Messages {
		if message.Role != "system" && message.Role != "user" && message.Role != "assistant" {
			return false
		}
		if !validName(message.Content, 4000) {
			return false
		}
		total += len(message.Content)
	}
	return total <= 10000
}

// reserveRouterQuota and settleRouterQuota are atomic with the audit receipts.
// The demo ceiling is deliberately conservative, NOT a provider invoice.
func (a *API) reserveRouterQuota(p AccessToken, projectID string, in RouterChatRequest) (Reservation, error) {
	var inputBytes int64
	for _, message := range in.Messages {
		inputBytes += int64(len(message.Content))
	}
	units := in.MaxOutputTokens + (inputBytes+3)/4 + 32
	if units > 10000 {
		return Reservation{}, errInvalid
	}
	id, err := randomID("res_")
	if err != nil {
		return Reservation{}, err
	}
	res := Reservation{ID: id, TenantID: p.TenantID, ProjectID: projectID, RequestedUnits: units, IdempotencyKey: "router." + in.RequestID, Status: "reserved", CreatedAt: time.Now().UTC()}
	err = a.store.transact(func(st *State) error {
		member, _, has := memberProject(*st, p, projectID)
		if !has {
			return errNotFound
		}
		if member.Role != "owner" && member.Role != "reviewer" {
			return errForbidden
		}
		for _, prior := range st.Reservations {
			if prior.ProjectID == projectID && prior.IdempotencyKey == res.IdempotencyKey {
				return errConflict
			}
		}
		if ledgerBalances(*st, projectID)["available"] < units {
			return errConflict
		}
		if err := appendLedger(st, projectID, p.TenantID, "router-reserve", id, []LedgerLeg{{"available", -units}, {"reserved", units}}); err != nil {
			return err
		}
		st.Reservations[id] = res
		return nil
	})
	return res, err
}
func (a *API) settleRouterQuota(p AccessToken, res Reservation, attempt RouterAttempt, actual int64) error {
	return a.store.transact(func(st *State) error {
		current, ok := st.Reservations[res.ID]
		if !ok || current.Status != "reserved" || current.ProjectID != res.ProjectID {
			return errConflict
		}
		if actual < 0 || actual > res.RequestedUnits {
			return errInvalid
		}
		if err := appendLedger(st, res.ProjectID, p.TenantID, "router-settle", res.ID, []LedgerLeg{{"reserved", -res.RequestedUnits}, {"spent", actual}, {"available", res.RequestedUnits - actual}}); err != nil {
			return err
		}
		current.Status = "settled"
		current.ActualUnits = actual
		st.Reservations[res.ID] = current
		attempt.SpentDemoUnits = actual
		st.RouterAttempts[attempt.ID] = attempt
		appendProjectEvent(st, res.ProjectID, "router.attempt", attempt.ID, 1)
		return nil
	})
}

// routerChatStream forwards actual provider SSE rather than simulating model
// output. Lab quota reservation is required before any paid upstream call.
func (a *API) routerChatStream(w http.ResponseWriter, r *http.Request) {
	p, ok := a.auth(w, r, "human")
	if !ok {
		return
	}
	if a.router == nil {
		failure(w, 503, "router lab disabled")
		return
	}
	projectID := r.PathValue("project")
	var in RouterChatRequest
	if !decode(w, r, &in, 16000) {
		return
	}
	if !validRouterChat(in) {
		failure(w, 400, "invalid router request")
		return
	}
	cred, configured := a.router.configured(projectID)
	if !configured {
		failure(w, 409, "owner must configure BYOK session")
		return
	}
	res, err := a.reserveRouterQuota(p, projectID, in)
	if err != nil {
		writeTxError(w, err)
		return
	}
	attemptID, err := randomID("att_")
	if err != nil {
		failure(w, 500, "internal error")
		return
	}
	attempt := RouterAttempt{ID: attemptID, ProjectID: projectID, TenantID: p.TenantID, Subject: p.Subject, Model: cred.Model,
		ReservedDemoUnits: res.RequestedUnits, CreatedAt: time.Now().UTC()}
	requestBody, _ := json.Marshal(map[string]any{"model": cred.Model, "messages": in.Messages, "max_tokens": in.MaxOutputTokens,
		"stream": true, "stream_options": map[string]any{"include_usage": true}})
	outgoing, err := http.NewRequestWithContext(r.Context(), "POST", a.router.upstream, bytes.NewReader(requestBody))
	if err != nil {
		attempt.Status = "upstream-error"
		_ = a.settleRouterQuota(p, res, attempt, 0)
		failure(w, 502, "provider unavailable")
		return
	}
	outgoing.Header.Set("Authorization", "Bearer "+cred.APIKey)
	outgoing.Header.Set("Content-Type", "application/json")
	outgoing.Header.Set("Accept", "text/event-stream")
	response, err := a.router.client.Do(outgoing)
	if err != nil {
		attempt.Status = "upstream-error"
		_ = a.settleRouterQuota(p, res, attempt, 0)
		failure(w, 502, "provider unavailable")
		return
	}
	defer response.Body.Close()
	if response.StatusCode != 200 || !strings.HasPrefix(response.Header.Get("Content-Type"), "text/event-stream") {
		attempt.Status = "upstream-error"
		_ = a.settleRouterQuota(p, res, attempt, 0)
		failure(w, 502, "provider streaming unavailable")
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("X-Accel-Buffering", "no")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(200)
	scanner := bufio.NewScanner(io.LimitReader(response.Body, 1<<20))
	scanner.Buffer(make([]byte, 32<<10), 128<<10)
	flush, _ := w.(http.Flusher)
	done := false
	seenUsage := false
	var promptTokens, completionTokens int64
	for scanner.Scan() {
		if r.Context().Err() != nil {
			break
		}
		// Membership/revocation is rechecked while streaming.
		active := false
		a.store.read(func(st State) {
			m, _, ok := memberProject(st, p, projectID)
			active = ok && (m.Role == "owner" || m.Role == "reviewer")
		})
		if !active {
			break
		}
		line := scanner.Text()
		if strings.HasPrefix(line, "data: ") {
			data := strings.TrimPrefix(line, "data: ")
			if data == "[DONE]" {
				done = true
			} else {
				var payload struct {
					Usage *struct {
						PromptTokens     int64 `json:"prompt_tokens"`
						CompletionTokens int64 `json:"completion_tokens"`
					} `json:"usage"`
				}
				if json.Unmarshal([]byte(data), &payload) == nil && payload.Usage != nil && payload.Usage.PromptTokens >= 0 && payload.Usage.CompletionTokens >= 0 {
					promptTokens = payload.Usage.PromptTokens
					completionTokens = payload.Usage.CompletionTokens
					seenUsage = true
				}
			}
		}
		if _, err := io.WriteString(w, line+"\n"); err != nil {
			break
		}
		if flush != nil {
			flush.Flush()
		}
	}
	attempt.ProviderMeasured = seenUsage
	attempt.ProviderPromptTokens = promptTokens
	attempt.ProviderCompletionTokens = completionTokens
	spent := res.RequestedUnits // fail closed on missing usage/cancellation
	attempt.Status = "usage-unmeasured"
	if scanner.Err() != nil || r.Context().Err() != nil || !done {
		attempt.Status = "interrupted"
	}
	if done && seenUsage {
		attempt.Status = "completed"
		used := promptTokens + completionTokens
		if used >= 0 && used <= res.RequestedUnits {
			spent = used
		} else {
			attempt.Status = "usage-over-reservation"
		}
	}
	// Once upstream accepted a request, never zero out an interrupted request:
	// actual provider costs may still have incurred.
	_ = a.settleRouterQuota(p, res, attempt, spent)
}

func (a *API) routerAttempts(w http.ResponseWriter, r *http.Request) {
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
		if m.Role != "owner" {
			failure(w, 403, "capability denied")
			return
		}
		attempts := make([]RouterAttempt, 0)
		for _, att := range st.RouterAttempts {
			if att.ProjectID == projectID && att.TenantID == p.TenantID {
				attempts = append(attempts, att)
			}
		}
		sort.Slice(attempts, func(i, j int) bool { return attempts[i].ID < attempts[j].ID })
		respond(w, 200, map[string]any{"attempts": attempts, "billing": "disabled", "usage_measured_only_if_provider_reports": true})
	})
}

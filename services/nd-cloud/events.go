package main

import (
	"net/http"
	"strconv"
	"time"
)

// ProjectEvent is a minimal private control-plane receipt. Never place raw
// prompts, API secrets, task descriptions, case text, or tokens in the log.
type ProjectEvent struct {
	Sequence  uint64    `json:"sequence"`
	Kind      string    `json:"kind"`
	EntityID  string    `json:"entity_id"`
	Revision  int64     `json:"revision"`
	CreatedAt time.Time `json:"created_at"`
}

const maxProjectEvents = 1024

func appendProjectEvent(st *State, projectID, kind, id string, revision int64) {
	entries := st.Events[projectID]
	seq := uint64(1)
	if len(entries) > 0 {
		seq = entries[len(entries)-1].Sequence + 1
	}
	entries = append(entries, ProjectEvent{Sequence: seq, Kind: kind, EntityID: id, Revision: revision, CreatedAt: time.Now().UTC()})
	if len(entries) > maxProjectEvents {
		entries = append([]ProjectEvent(nil), entries[len(entries)-maxProjectEvents:]...)
	}
	st.Events[projectID] = entries
}

func (a *API) replayProjectEvents(w http.ResponseWriter, r *http.Request) {
	principal, ok := a.auth(w, r, "human")
	if !ok {
		return
	}
	projectID := r.PathValue("project")
	var after uint64
	if v := r.URL.Query().Get("after"); v != "" {
		n, err := strconv.ParseUint(v, 10, 64)
		if err != nil {
			failure(w, 400, "invalid cursor")
			return
		}
		after = n
	}
	limit := 50
	if v := r.URL.Query().Get("limit"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 100 {
			failure(w, 400, "invalid limit")
			return
		}
		limit = n
	}
	a.store.read(func(st State) {
		if _, _, has := memberProject(st, principal, projectID); !has {
			failure(w, 404, "not found")
			return
		}
		entries := st.Events[projectID]
		latest := uint64(0)
		if len(entries) > 0 {
			first := entries[0].Sequence
			latest = entries[len(entries)-1].Sequence
			if after < first-1 || after > latest {
				failure(w, 409, "event cursor requires snapshot resync")
				return
			}
		} else if after > 0 {
			failure(w, 409, "event cursor requires snapshot resync")
			return
		}
		selected := make([]ProjectEvent, 0)
		for _, event := range entries {
			if event.Sequence > after {
				selected = append(selected, event)
				if len(selected) == limit {
					break
				}
			}
		}
		cursor := after
		if len(selected) > 0 {
			cursor = selected[len(selected)-1].Sequence
		}
		respond(w, 200, map[string]any{"events": selected, "next_cursor": cursor, "latest_cursor": latest, "has_more": cursor < latest})
	})
}

func (a *API) projectSyncStatus(w http.ResponseWriter, r *http.Request) {
	principal, ok := a.auth(w, r, "human")
	if !ok {
		return
	}
	projectID := r.PathValue("project")
	a.store.read(func(st State) {
		if _, _, has := memberProject(st, principal, projectID); !has {
			failure(w, 404, "not found")
			return
		}
		board, exists := st.Boards[projectID]
		if !exists {
			respond(w, 200, map[string]any{"state": "never-synced", "stale": true, "host_online": false})
			return
		}
		stale := time.Since(board.ReceivedAt) > 5*time.Minute
		status := "recent-projection"
		if stale {
			status = "stale-projection"
		}
		respond(w, 200, map[string]any{"state": status, "stale": stale, "host_online": false, "last_received_at": board.ReceivedAt, "revision": board.Revision})
	})
}

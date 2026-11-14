package main

import (
	"net/http"
	"sort"
	"strings"
	"time"
)

// WikiPage records a reviewed human-authored description or a deterministic
// source inventory. Source paths and hashes are provenance, not proof that an
// AI interpreted the implementation correctly. Never copy raw ZIP files here.
type WikiPage struct {
	ID               string    `json:"id"`
	TenantID         string    `json:"tenant_id"`
	ProjectID        string    `json:"project_id"`
	SourceSnapshotID string    `json:"source_snapshot_id"`
	SourcePath       string    `json:"source_path,omitempty"`
	SourceSHA256     string    `json:"source_sha256"`
	Title            string    `json:"title"`
	Body             string    `json:"body"`
	Author           string    `json:"author"`
	Reviewer         string    `json:"reviewer,omitempty"`
	Status           string    `json:"status"` // draft, published, stale
	Revision         int64     `json:"revision"`
	Generated        bool      `json:"generated"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
}

// inventoryDraft creates a transparent index of source paths and SHA-256
// values, not an LLM-generated user manual or inferred code behavior.
func inventoryDraft(source SourceSnapshot, author string) (WikiPage, error) {
	id, err := randomID("wiki_")
	if err != nil {
		return WikiPage{}, err
	}
	var body strings.Builder
	body.WriteString("# Source inventory (unverified)\n\n")
	body.WriteString("Imported archive: " + source.Filename + "\n\n")
	body.WriteString("This page lists observed file paths and immutable hashes only. It is NOT a verified guide.\n\n")
	for _, file := range source.Files {
		body.WriteString("- `" + file.Path + "` · SHA256 `" + file.SHA256 + "` · " + file.Kind + "\n")
	}
	if body.Len() > 65000 {
		return WikiPage{}, errInvalid
	}
	now := time.Now().UTC()
	return WikiPage{ID: id, TenantID: source.TenantID, ProjectID: source.ProjectID, SourceSnapshotID: source.ID,
		SourceSHA256: source.ArtifactSHA256, Title: "Source inventory: " + source.Filename, Body: body.String(),
		Author: author, Status: "draft", Revision: 1, Generated: true, CreatedAt: now, UpdatedAt: now}, nil
}

func (a *API) createWikiPage(w http.ResponseWriter, r *http.Request) {
	principal, ok := a.auth(w, r, "human")
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
	if !validID(in.SourceSnapshotID) || !safeSourcePath(in.SourcePath) || !validName(in.Title, 160) || !validName(in.Body, 8000) {
		failure(w, 400, "invalid wiki draft")
		return
	}
	id, err := randomID("wiki_")
	if err != nil {
		failure(w, 500, "internal error")
		return
	}
	now := time.Now().UTC()
	page := WikiPage{ID: id, TenantID: principal.TenantID, ProjectID: projectID, SourceSnapshotID: in.SourceSnapshotID, SourcePath: in.SourcePath,
		Title: strings.TrimSpace(in.Title), Body: strings.TrimSpace(in.Body), Author: principal.Subject, Status: "draft", Revision: 1, CreatedAt: now, UpdatedAt: now}
	err = a.store.transact(func(st *State) error {
		member, _, has := memberProject(*st, principal, projectID)
		if !has {
			return errNotFound
		}
		if member.Role != "owner" && member.Role != "reviewer" {
			return errForbidden
		}
		source, found := st.Sources[in.SourceSnapshotID]
		if !found || source.TenantID != principal.TenantID || source.ProjectID != projectID {
			return errNotFound
		}
		for _, file := range source.Files {
			if file.Path == in.SourcePath {
				page.SourceSHA256 = file.SHA256
				st.WikiPages[id] = page
				appendProjectEvent(st, projectID, "wiki.draft", page.ID, page.Revision)
				return nil
			}
		}
		return errInvalid
	})
	if err != nil {
		writeTxError(w, err)
		return
	}
	respond(w, 201, page)
}

func (a *API) listWikiPages(w http.ResponseWriter, r *http.Request) {
	principal, ok := a.auth(w, r, "human")
	if !ok {
		return
	}
	projectID := r.PathValue("project")
	a.store.read(func(st State) {
		member, _, allowed := memberProject(st, principal, projectID)
		if !allowed {
			failure(w, 404, "not found")
			return
		}
		pages := make([]WikiPage, 0)
		for _, page := range st.WikiPages {
			if page.ProjectID != projectID || page.TenantID != principal.TenantID {
				continue
			}
			if member.Role != "owner" && member.Role != "reviewer" && page.Status != "published" {
				continue
			}
			pages = append(pages, page)
		}
		sort.Slice(pages, func(i, j int) bool { return pages[i].CreatedAt.Before(pages[j].CreatedAt) })
		respond(w, 200, map[string]any{"pages": pages})
	})
}

func (a *API) publishWikiPage(w http.ResponseWriter, r *http.Request) {
	principal, ok := a.auth(w, r, "human")
	if !ok {
		return
	}
	projectID, pageID := r.PathValue("project"), r.PathValue("page")
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
	var result WikiPage
	err := a.store.transact(func(st *State) error {
		member, _, allowed := memberProject(*st, principal, projectID)
		if !allowed {
			return errNotFound
		}
		if member.Role != "owner" && member.Role != "reviewer" {
			return errForbidden
		}
		page, exists := st.WikiPages[pageID]
		if !exists || page.ProjectID != projectID || page.TenantID != principal.TenantID {
			return errNotFound
		}
		if page.Author == principal.Subject {
			return errForbidden
		}
		if page.Status != "draft" || page.Revision != in.ExpectedRevision {
			return errConflict
		}
		// A new source snapshot means a previous draft is no longer current.
		source, has := st.Sources[page.SourceSnapshotID]
		if !has || source.ProjectID != projectID || source.TenantID != principal.TenantID {
			return errNotFound
		}
		if !currentWikiSource(*st, page) {
			return errConflict
		}
		page.Status = "published"
		page.Reviewer = principal.Subject
		page.Revision++
		page.UpdatedAt = time.Now().UTC()
		st.WikiPages[page.ID] = page
		appendProjectEvent(st, projectID, "wiki.published", page.ID, page.Revision)
		result = page
		return nil
	})
	if err != nil {
		writeTxError(w, err)
		return
	}
	respond(w, 200, result)
}

func currentWikiSource(st State, page WikiPage) bool {
	source, ok := st.Sources[page.SourceSnapshotID]
	if !ok {
		return false
	}
	for _, other := range st.Sources {
		if other.ProjectID == source.ProjectID && other.TenantID == source.TenantID && other.CreatedAt.After(source.CreatedAt) {
			// A newer snapshot always needs re-review; fail closed even if
			// its manifest is identical (hash-equivalent ZIPs are deduped).
			return false
		}
	}
	return true
}

// searchWiki is deliberately simple, scoped keyword search of published pages.
// No semantic confidence, inferred answers, private drafts or auto-demo.
func (a *API) searchWiki(w http.ResponseWriter, r *http.Request) {
	principal, ok := a.auth(w, r, "human")
	if !ok {
		return
	}
	projectID := r.PathValue("project")
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(query) < 2 || len(query) > 120 {
		failure(w, 400, "invalid search query")
		return
	}
	words := strings.Fields(strings.ToLower(query))
	a.store.read(func(st State) {
		if _, _, allowed := memberProject(st, principal, projectID); !allowed {
			failure(w, 404, "not found")
			return
		}
		out := make([]WikiPage, 0)
		for _, page := range st.WikiPages {
			if page.TenantID != principal.TenantID || page.ProjectID != projectID || page.Status != "published" {
				continue
			}
			haystack := strings.ToLower(page.Title + " " + page.Body)
			matched := true
			for _, word := range words {
				if !strings.Contains(haystack, word) {
					matched = false
					break
				}
			}
			if matched {
				out = append(out, page)
			}
		}
		sort.Slice(out, func(i, j int) bool { return out[i].ID < out[j].ID })
		if len(out) > 20 {
			out = out[:20]
		}
		respond(w, 200, map[string]any{"pages": out, "status": "source-linked-unverified", "auto_demo_allowed": false})
	})
}

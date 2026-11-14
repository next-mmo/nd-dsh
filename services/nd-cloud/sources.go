package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"path"
	"sort"
	"strings"
	"time"
)

// A reviewed source import begins with an immutable, bounded, provenance-only
// manifest. Uploaded archives are parsed in memory and deliberately discarded;
// never execute files, install dependencies, or store raw source/credentials.
// Human-approved source text and immutable snapshots are separate future work.
const (
	maxZIPBytes         = 8 << 20
	maxSourceFiles      = 250
	maxProjectSnapshots = 50
	maxSourceFileBytes  = 1 << 20
	maxExpandedBytes    = 16 << 20
)

type SourceEntry struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
	Bytes  int64  `json:"bytes"`
	Kind   string `json:"kind"`
}

type SourceSnapshot struct {
	ID             string        `json:"id"`
	TenantID       string        `json:"tenant_id"`
	ProjectID      string        `json:"project_id"`
	UploadedBy     string        `json:"uploaded_by"`
	Filename       string        `json:"filename"`
	ArtifactSHA256 string        `json:"artifact_sha256"`
	Files          []SourceEntry `json:"files"`
	CreatedAt      time.Time     `json:"created_at"`
	Status         string        `json:"status"` // metadata-only, not AI-verified or publishable
}

func safeSourcePath(name string) bool {
	if name == "" || len(name) > 500 || strings.HasPrefix(name, "/") || strings.ContainsAny(name, "\\\x00:") || strings.Contains(name, "//") || path.Clean(name) != name {
		return false
	}
	for _, segment := range strings.Split(name, "/") {
		if segment == "" || segment == "." || segment == ".." || strings.HasPrefix(strings.ToLower(segment), ".env") || strings.HasPrefix(strings.ToLower(segment), ".ssh") {
			return false
		}
		switch strings.ToLower(segment) {
		case "node_modules", ".git", "vendor", "dist", "build", ".next", ".cache", ".aws", ".config", "secrets", "private", "credentials":
			return false
		}
	}
	return true
}

func sourceKind(name string) string {
	switch strings.ToLower(path.Ext(name)) {
	case ".md", ".markdown", ".txt":
		return "docs"
	case ".json", ".yaml", ".yml", ".toml":
		return "configuration"
	case ".ts", ".tsx", ".js", ".jsx", ".go", ".rs", ".java", ".py", ".vue", ".svelte", ".html", ".css":
		return "code"
	default:
		return ""
	}
}

// inspectSourceZIP rejects unsafe paths, special files, duplicate case-folded
// paths and bombs. It validates uncompressed sizes by actually reading bytes
// with a strict bound, even when ZIP headers lie. Only file hashes survive.
func inspectSourceZIP(raw []byte) ([]SourceEntry, string, error) {
	if len(raw) == 0 || len(raw) > maxZIPBytes {
		return nil, "", errInvalid
	}
	archive, err := zip.NewReader(bytes.NewReader(raw), int64(len(raw)))
	if err != nil {
		return nil, "", errInvalid
	}
	if len(archive.File) > maxSourceFiles {
		return nil, "", errInvalid
	}
	seen := map[string]bool{}
	result := make([]SourceEntry, 0, len(archive.File))
	var expanded int64
	for _, entry := range archive.File {
		name := entry.Name
		if strings.HasSuffix(name, "/") {
			if !safeSourcePath(strings.TrimSuffix(name, "/")) || !entry.FileInfo().IsDir() {
				return nil, "", errInvalid
			}
			continue
		}
		if !safeSourcePath(name) || !entry.FileInfo().Mode().IsRegular() {
			return nil, "", errInvalid
		}
		fold := strings.ToLower(name)
		if seen[fold] {
			return nil, "", errInvalid
		}
		seen[fold] = true
		kind := sourceKind(name)
		if kind == "" {
			return nil, "", errInvalid
		}
		if entry.UncompressedSize64 > maxSourceFileBytes || expanded+int64(entry.UncompressedSize64) > maxExpandedBytes {
			return nil, "", errInvalid
		}
		rc, err := entry.Open()
		if err != nil {
			return nil, "", errInvalid
		}
		// Read the payload but do not retain it. Over-limit streams fail closed.
		h := sha256.New()
		n, readErr := io.Copy(h, io.LimitReader(rc, maxSourceFileBytes+1))
		closeErr := rc.Close()
		if readErr != nil || closeErr != nil || n != int64(entry.UncompressedSize64) || n > maxSourceFileBytes {
			return nil, "", errInvalid
		}
		expanded += n
		if expanded > maxExpandedBytes {
			return nil, "", errInvalid
		}
		result = append(result, SourceEntry{Path: name, SHA256: hex.EncodeToString(h.Sum(nil)), Bytes: n, Kind: kind})
	}
	if len(result) == 0 {
		return nil, "", errInvalid
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Path < result[j].Path })
	hash := sha256.Sum256(raw)
	return result, hex.EncodeToString(hash[:]), nil
}

func (a *API) createSourceSnapshot(w http.ResponseWriter, r *http.Request) {
	p, ok := a.auth(w, r, "human")
	if !ok {
		return
	}
	id := r.PathValue("project")
	// Authorization before any potentially expensive archive parsing.
	allowed := false
	a.store.read(func(st State) {
		member, _, has := memberProject(st, p, id)
		allowed = has && member.Role == "owner"
	})
	if !allowed {
		failure(w, 404, "not found")
		return
	}
	if r.Header.Get("Content-Type") != "application/zip" {
		failure(w, 415, "application/zip required")
		return
	}
	filename := r.Header.Get("X-ND-Source-Filename")
	if filename == "" {
		filename = "upload.zip"
	}
	if !validName(filename, 120) || strings.ContainsAny(filename, "/\\\x00") || !strings.HasSuffix(strings.ToLower(filename), ".zip") {
		failure(w, 400, "invalid archive filename")
		return
	}
	raw, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxZIPBytes+1))
	if err != nil || len(raw) > maxZIPBytes {
		failure(w, 413, "archive exceeds size limit")
		return
	}
	files, digest, err := inspectSourceZIP(raw)
	if err != nil {
		failure(w, 400, "unsafe or invalid source archive")
		return
	}
	snapshotID, err := randomID("src_")
	if err != nil {
		failure(w, 500, "internal error")
		return
	}
	record := SourceSnapshot{
		ID: snapshotID, TenantID: p.TenantID, ProjectID: id, UploadedBy: p.Subject, Filename: filename,
		ArtifactSHA256: digest, Files: files, CreatedAt: time.Now().UTC(), Status: "metadata-only",
	}
	err = a.store.transact(func(st *State) error {
		if !activePrincipal(*st, p) {
			return errForbidden
		}
		member, _, has := memberProject(*st, p, id)
		if !has || member.Role != "owner" {
			return errForbidden
		}
		count := 0
		for _, current := range st.Sources {
			if current.ProjectID == id && current.TenantID == p.TenantID {
				count++
				if current.ArtifactSHA256 == digest {
					return errConflict
				}
			}
		}
		if count >= maxProjectSnapshots {
			return errInvalid
		}
		st.Sources[record.ID] = record
		for pageID, page := range st.WikiPages {
			if page.ProjectID == id && page.TenantID == p.TenantID && page.Status == "published" && page.SourceSnapshotID != record.ID {
				page.Status = "stale"
				page.Revision++
				page.UpdatedAt = time.Now().UTC()
				st.WikiPages[pageID] = page
				appendProjectEvent(st, id, "wiki.stale", page.ID, page.Revision)
			}
		}
		draft, err := inventoryDraft(record, p.Subject)
		if err != nil {
			return err
		}
		st.WikiPages[draft.ID] = draft
		appendProjectEvent(st, id, "source.imported", record.ID, 1)
		appendProjectEvent(st, id, "wiki.draft", draft.ID, draft.Revision)
		return nil
	})
	if err != nil {
		writeTxError(w, err)
		return
	}
	respond(w, http.StatusCreated, record)
}

func (a *API) listSourceSnapshots(w http.ResponseWriter, r *http.Request) {
	p, ok := a.auth(w, r, "human")
	if !ok {
		return
	}
	id := r.PathValue("project")
	a.store.read(func(st State) {
		member, _, has := memberProject(st, p, id)
		if !has || (member.Role != "owner" && member.Role != "reviewer") {
			failure(w, 404, "not found")
			return
		}
		out := make([]SourceSnapshot, 0)
		for _, source := range st.Sources {
			if source.ProjectID == id && source.TenantID == p.TenantID {
				out = append(out, source)
			}
		}
		sort.Slice(out, func(i, j int) bool { return out[i].CreatedAt.Before(out[j].CreatedAt) })
		respond(w, 200, map[string]any{"sources": out})
	})
}

func (a *API) getSourceSnapshot(w http.ResponseWriter, r *http.Request) {
	p, ok := a.auth(w, r, "human")
	if !ok {
		return
	}
	projectID, sourceID := r.PathValue("project"), r.PathValue("source")
	a.store.read(func(st State) {
		member, _, has := memberProject(st, p, projectID)
		if !has || (member.Role != "owner" && member.Role != "reviewer") {
			failure(w, 404, "not found")
			return
		}
		source, found := st.Sources[sourceID]
		if !found || source.TenantID != p.TenantID || source.ProjectID != projectID {
			failure(w, 404, "not found")
			return
		}
		respond(w, 200, source)
	})
}

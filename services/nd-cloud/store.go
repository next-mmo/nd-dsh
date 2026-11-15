package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync"
	"time"
)

const schemaVersion = 4

var (
	errNotFound  = errors.New("not found")
	errForbidden = errors.New("forbidden")
	errConflict  = errors.New("conflict")
	errInvalid   = errors.New("invalid input")
)

type Tenant struct {
	ID        string    `json:"id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
}

type Membership struct {
	TenantID   string   `json:"tenant_id"`
	Subject    string   `json:"subject"`
	Role       string   `json:"role"`        // owner, reviewer, viewer
	ProjectIDs []string `json:"project_ids"` // owner: unrestricted; others: explicit allowlist
}

type Project struct {
	ID        string    `json:"id"`
	TenantID  string    `json:"tenant_id"`
	Name      string    `json:"name"`
	CreatedAt time.Time `json:"created_at"`
}

type AccessToken struct {
	ID             string    `json:"id"`
	Hash           string    `json:"hash"`
	Kind           string    `json:"kind"` // human or host
	Subject        string    `json:"subject,omitempty"`
	TenantID       string    `json:"tenant_id"`
	ProjectID      string    `json:"project_id,omitempty"`
	LocalCompanyID string    `json:"local_company_id,omitempty"`
	LocalProjectID string    `json:"local_project_id,omitempty"`
	ExpiresAt      time.Time `json:"expires_at"`
	Revoked        bool      `json:"revoked"`
}

type TaskSummary struct {
	ID        string `json:"id"`
	Title     string `json:"title"`
	Status    string `json:"status"`
	Priority  string `json:"priority"`
	UpdatedAt int64  `json:"updated_at"`
}

type BoardSubmission struct {
	SchemaVersion  int           `json:"schema_version"`
	SourceSystem   string        `json:"source_system"`
	TenantID       string        `json:"tenant_id"`
	CloudProjectID string        `json:"cloud_project_id"`
	LocalCompanyID string        `json:"local_company_id"`
	LocalProjectID string        `json:"local_project_id"`
	Revision       int64         `json:"revision"`
	Tasks          []TaskSummary `json:"tasks"`
}

type Board struct {
	BoardSubmission
	Digest     string    `json:"digest"`
	ReceivedAt time.Time `json:"received_at"`
}

type SupportCase struct {
	ID             string    `json:"id"`
	TenantID       string    `json:"tenant_id"`
	ProjectID      string    `json:"project_id"`
	Reporter       string    `json:"reporter"`
	Subject        string    `json:"subject"`
	Description    string    `json:"description"`
	Status         string    `json:"status"`
	ProposedNDTask string    `json:"proposed_nd_task,omitempty"` // proposal text, not task execution
	Revision       int64     `json:"revision"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

type SourceCitation struct {
	URL      string `json:"url"`
	Revision string `json:"revision"`
	Label    string `json:"label"`
}

type KnowledgeCard struct {
	ID         string           `json:"id"`
	TenantID   string           `json:"tenant_id"`
	ProjectID  string           `json:"project_id"`
	AppRelease string           `json:"app_release"`
	Question   string           `json:"question"`
	Answer     string           `json:"answer"`
	Citations  []SourceCitation `json:"citations"`
	Status     string           `json:"status"` // draft, published, stale
	Author     string           `json:"author"`
	Reviewer   string           `json:"reviewer,omitempty"`
	Revision   int64            `json:"revision"`
	CreatedAt  time.Time        `json:"created_at"`
	UpdatedAt  time.Time        `json:"updated_at"`
}

type State struct {
	SchemaVersion  int                       `json:"schema_version"`
	Tenants        map[string]Tenant         `json:"tenants"`
	Memberships    map[string]Membership     `json:"memberships"`
	Projects       map[string]Project        `json:"projects"`
	Tokens         map[string]AccessToken    `json:"tokens"` // keyed by SHA-256 of opaque secret, never plaintext
	Boards         map[string]Board          `json:"boards"`
	Cases          map[string]SupportCase    `json:"cases"`
	Cards          map[string]KnowledgeCard  `json:"cards"`
	Sources        map[string]SourceSnapshot `json:"sources"`
	WikiPages      map[string]WikiPage       `json:"wiki_pages"`
	Events         map[string][]ProjectEvent `json:"events"`
	Proposals      map[string]TaskProposal   `json:"proposals"`
	Ledgers        map[string][]LedgerTxn    `json:"ledgers"`
	Reservations   map[string]Reservation    `json:"reservations"`
	RouterAttempts map[string]RouterAttempt  `json:"router_attempts"`
	Specs          map[string]HumanSpec      `json:"specs"`
}

func emptyState() State {
	return State{SchemaVersion: schemaVersion, Tenants: map[string]Tenant{}, Memberships: map[string]Membership{}, Projects: map[string]Project{}, Tokens: map[string]AccessToken{}, Boards: map[string]Board{}, Cases: map[string]SupportCase{}, Cards: map[string]KnowledgeCard{}, Sources: map[string]SourceSnapshot{}, WikiPages: map[string]WikiPage{}, Events: map[string][]ProjectEvent{}, Proposals: map[string]TaskProposal{}, Ledgers: map[string][]LedgerTxn{}, Reservations: map[string]Reservation{}, RouterAttempts: map[string]RouterAttempt{}, Specs: map[string]HumanSpec{}}
}

func memberKey(tenant, subject string) string { return tenant + ":" + subject }
func tokenHash(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

func randomID(prefix string) (string, error) {
	b := make([]byte, 16)
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		return "", err
	}
	return prefix + hex.EncodeToString(b), nil
}

func newCredential() (string, error) {
	b := make([]byte, 32)
	if _, err := io.ReadFull(rand.Reader, b); err != nil {
		return "", err
	}
	return "ndp_" + base64.RawURLEncoding.EncodeToString(b), nil
}

type Store struct {
	mu    sync.RWMutex
	path  string
	state State
}

func openStore(path string) (*Store, error) {
	if strings.TrimSpace(path) == "" {
		return nil, fmt.Errorf("data file is required")
	}
	s := &Store{path: path, state: emptyState()}
	info, err := os.Lstat(path)
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 {
		return nil, fmt.Errorf("data file must be a private regular file (0600)")
	}
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	state, err := normalizedState(b)
	if err != nil {
		return nil, err
	}
	s.state = state
	return s, nil
}

// Transact is all-or-nothing: the on-disk replacement is durable before the
// in-memory state changes. No successful write is acknowledged before fsync.
func (s *Store) transact(fn func(*State) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	b, err := json.Marshal(s.state)
	if err != nil {
		return err
	}
	var draft State
	if err := json.Unmarshal(b, &draft); err != nil {
		return err
	}
	if err := fn(&draft); err != nil {
		return err
	}
	next, err := json.MarshalIndent(draft, "", "  ")
	if err != nil {
		return err
	}
	if len(next) > maxBackupBytes {
		return fmt.Errorf("state exceeds local pilot size limit: %w", errInvalid)
	}
	if err := persistAtomic(s.path, append(next, '\n')); err != nil {
		return err
	}
	s.state = draft
	return nil
}

func (s *Store) read(fn func(State)) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	fn(s.state)
}

func persistAtomic(path string, b []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	if fi, err := os.Lstat(path); err == nil && (!fi.Mode().IsRegular() || fi.Mode().Perm()&0077 != 0) {
		return fmt.Errorf("unsafe data file permissions or type")
	} else if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	f, err := os.CreateTemp(dir, ".nd-cloud-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if err := f.Chmod(0600); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(b); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(f.Name(), path); err != nil {
		return err
	}
	// On Windows directory fsync is unsupported; the temporary file itself
	// was flushed before rename. The pilot is not a production database.
	if runtime.GOOS == "windows" {
		return nil
	}
	d, err := os.Open(dir)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

// bootstrap is an operator-only local command; no public account provisioning.
func (s *Store) bootstrap(tenantID, tenantName, subject string) (string, error) {
	if !validID(tenantID) || !validID(subject) || !validName(tenantName, 120) {
		return "", errInvalid
	}
	key, err := newCredential()
	if err != nil {
		return "", err
	}
	tokenID, err := randomID("tok_")
	if err != nil {
		return "", err
	}
	err = s.transact(func(st *State) error {
		if _, ok := st.Tenants[tenantID]; ok {
			return errConflict
		}
		st.Tenants[tenantID] = Tenant{ID: tenantID, Name: tenantName, CreatedAt: time.Now().UTC()}
		st.Memberships[memberKey(tenantID, subject)] = Membership{TenantID: tenantID, Subject: subject, Role: "owner"}
		st.Tokens[tokenHash(key)] = AccessToken{ID: tokenID, Hash: tokenHash(key), Kind: "human", Subject: subject, TenantID: tenantID, ExpiresAt: time.Now().UTC().Add(30 * 24 * time.Hour)}
		return nil
	})
	if err != nil {
		return "", err
	}
	return key, nil
}

func (s *Store) issueHuman(tenant, subject, role string, projects []string) (string, error) {
	if !validID(tenant) || !validID(subject) || (role != "viewer" && role != "reviewer") {
		return "", errInvalid
	}
	key, err := newCredential()
	if err != nil {
		return "", err
	}
	id, err := randomID("tok_")
	if err != nil {
		return "", err
	}
	err = s.transact(func(st *State) error {
		if _, ok := st.Tenants[tenant]; !ok {
			return errNotFound
		}
		if _, ok := st.Memberships[memberKey(tenant, subject)]; ok {
			return errConflict
		}
		if len(projects) == 0 {
			return errInvalid
		}
		seen := map[string]bool{}
		for _, p := range projects {
			if seen[p] || st.Projects[p].TenantID != tenant {
				return errInvalid
			}
			seen[p] = true
		}
		st.Memberships[memberKey(tenant, subject)] = Membership{TenantID: tenant, Subject: subject, Role: role, ProjectIDs: append([]string{}, projects...)}
		st.Tokens[tokenHash(key)] = AccessToken{ID: id, Hash: tokenHash(key), Kind: "human", Subject: subject, TenantID: tenant, ExpiresAt: time.Now().UTC().Add(30 * 24 * time.Hour)}
		return nil
	})
	if err != nil {
		return "", err
	}
	return key, nil
}

func (s *Store) issueHost(tenant, project, company, localProject string) (string, error) {
	if !validID(tenant) || !validID(project) || !validID(company) || !validID(localProject) {
		return "", errInvalid
	}
	key, err := newCredential()
	if err != nil {
		return "", err
	}
	id, err := randomID("tok_")
	if err != nil {
		return "", err
	}
	err = s.transact(func(st *State) error {
		if st.Projects[project].TenantID != tenant {
			return errNotFound
		}
		st.Tokens[tokenHash(key)] = AccessToken{ID: id, Hash: tokenHash(key), Kind: "host", TenantID: tenant, ProjectID: project, LocalCompanyID: company, LocalProjectID: localProject, ExpiresAt: time.Now().UTC().Add(30 * 24 * time.Hour)}
		return nil
	})
	if err != nil {
		return "", err
	}
	return key, nil
}

func (s *Store) revokeToken(id string) error {
	if !validID(id) {
		return errInvalid
	}
	return s.transact(func(st *State) error {
		for hash, t := range st.Tokens {
			if t.ID == id {
				t.Revoked = true
				st.Tokens[hash] = t
				return nil
			}
		}
		return errNotFound
	})
}

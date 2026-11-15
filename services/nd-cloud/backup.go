package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
)

const backupFormatVersion = 1
const maxBackupBytes = 32 << 20

type BackupEnvelope struct {
	FormatVersion int             `json:"format_version"`
	CreatedAt     time.Time       `json:"created_at"`
	SHA256        string          `json:"sha256"`
	State         json.RawMessage `json:"state"`
}

func normalizedState(raw []byte) (State, error) {
	var state State
	if len(raw) > maxBackupBytes || !json.Valid(raw) {
		return state, errInvalid
	}
	if err := json.Unmarshal(raw, &state); err != nil {
		return state, errInvalid
	}
	switch state.SchemaVersion {
	case 1:
		state.Sources = map[string]SourceSnapshot{}
		state.SchemaVersion = 2
		fallthrough
	case 2:
		state.WikiPages = map[string]WikiPage{}
		state.Events = map[string][]ProjectEvent{}
		state.Proposals = map[string]TaskProposal{}
		state.Ledgers = map[string][]LedgerTxn{}
		state.Reservations = map[string]Reservation{}
		state.RouterAttempts = map[string]RouterAttempt{}
		state.SchemaVersion = 3
		fallthrough
	case 3:
		state.Specs = map[string]HumanSpec{}
		state.SchemaVersion = schemaVersion
	case schemaVersion:
	default:
		return state, fmt.Errorf("unsupported schema version %d", state.SchemaVersion)
	}
	if state.Tenants == nil || state.Memberships == nil || state.Projects == nil || state.Tokens == nil || state.Boards == nil || state.Cases == nil || state.Cards == nil || state.Sources == nil || state.WikiPages == nil || state.Events == nil || state.Proposals == nil || state.Ledgers == nil || state.Reservations == nil || state.RouterAttempts == nil || state.Specs == nil {
		return state, errInvalid
	}
	return state, nil
}

func privateRegularFile(path string) ([]byte, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0077 != 0 || info.Size() > maxBackupBytes {
		return nil, errors.New("backup must be a private regular file (0600) under 32 MiB")
	}
	return os.ReadFile(path)
}

func sameFilePath(a, b string) bool {
	left, err1 := filepath.Abs(a)
	right, err2 := filepath.Abs(b)
	return err1 == nil && err2 == nil && filepath.Clean(left) == filepath.Clean(right)
}

// exportBackup writes a private, checksummed point-in-time envelope. It refuses
// to overwrite an existing backup to reduce accidental replacement risk.
func (s *Store) exportBackup(destination string) error {
	if strings.TrimSpace(destination) == "" || sameFilePath(s.path, destination) {
		return errInvalid
	}
	if _, err := os.Lstat(destination); err == nil {
		return errConflict
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	var raw []byte
	s.read(func(st State) { raw, _ = json.Marshal(st) })
	if len(raw) == 0 || len(raw) > maxBackupBytes {
		return errInvalid
	}
	sum := sha256.Sum256(raw)
	envelope := BackupEnvelope{FormatVersion: backupFormatVersion, CreatedAt: time.Now().UTC(), SHA256: hex.EncodeToString(sum[:]), State: raw}
	b, err := json.MarshalIndent(envelope, "", "  ")
	if err != nil {
		return err
	}
	return persistNoReplace(destination, append(b, '\n'))
}

// restoreBackup restores only into an absent data path. The checked envelope
// and schema are validated before writing. Never silently replace live data.
func restoreBackup(source, destination string) error {
	if strings.TrimSpace(source) == "" || strings.TrimSpace(destination) == "" || sameFilePath(source, destination) {
		return errInvalid
	}
	if _, err := os.Lstat(destination); err == nil {
		return errConflict
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	b, err := privateRegularFile(source)
	if err != nil {
		return err
	}
	d := json.NewDecoder(strings.NewReader(string(b)))
	d.DisallowUnknownFields()
	var envelope BackupEnvelope
	if err := d.Decode(&envelope); err != nil {
		return errInvalid
	}
	var extra any
	if err := d.Decode(&extra); err != io.EOF {
		return errInvalid
	}
	if envelope.FormatVersion != backupFormatVersion || len(envelope.SHA256) != 64 {
		return errInvalid
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, envelope.State); err != nil {
		return errInvalid
	}
	hash := sha256.Sum256(compact.Bytes())
	if hex.EncodeToString(hash[:]) != envelope.SHA256 {
		return errors.New("backup checksum mismatch")
	}
	state, err := normalizedState(envelope.State)
	if err != nil {
		return err
	}
	next, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return err
	}
	if err := persistNoReplace(destination, append(next, '\n')); err != nil {
		return err
	}
	// Make sure the resulting file is an openable ND store before reporting success.
	_, err = openStore(destination)
	return err
}

package main

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// FileStateLock is a cooperative, process-wide single-writer guard for the
// local JSON pilot. The lock is never automatically stolen: after a crash,
// an operator must independently confirm no writer is active and remove it.
// This is NOT a distributed lock or a substitute for PostgreSQL transactions.
type FileStateLock struct{ path, nonce string }

func acquireFileStateLock(dataPath string) (*FileStateLock, error) {
	if strings.TrimSpace(dataPath) == "" {
		return nil, errInvalid
	}
	abs, err := filepath.Abs(dataPath)
	if err != nil {
		return nil, err
	}
	dir := filepath.Dir(abs)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return nil, err
	}
	name := abs + ".writer.lock"
	nonce := make([]byte, 16)
	if _, err := rand.Read(nonce); err != nil {
		return nil, err
	}
	f, err := os.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if errors.Is(err, os.ErrExist) {
		return nil, fmt.Errorf("ND Cloud data already locked; check active process before manually removing %s: %w", name, errConflict)
	}
	if err != nil {
		return nil, err
	}
	value := hex.EncodeToString(nonce)
	if _, err := fmt.Fprintf(f, "%s\nPID %d\n", value, os.Getpid()); err != nil {
		f.Close()
		os.Remove(name)
		return nil, err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(name)
		return nil, err
	}
	if err := f.Close(); err != nil {
		os.Remove(name)
		return nil, err
	}
	return &FileStateLock{path: name, nonce: value}, nil
}

func (l *FileStateLock) Release() error {
	if l == nil {
		return nil
	}
	b, err := os.ReadFile(l.path)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if !strings.HasPrefix(string(b), l.nonce+"\n") {
		return errors.New("writer lock ownership changed; refusing to remove")
	}
	return os.Remove(l.path)
}

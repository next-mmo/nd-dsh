package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

const testBackupPassphrase = "this is a strong offline-only test passphrase"

func TestEncryptedBackupRoundTripWrongPasswordAndTampering(t *testing.T) {
	p := createPilot(t)
	expectStatus(t, p.call("PUT", "/v1/projects/"+p.projectA+"/board", p.host, p.board(1)), 201)
	backup := filepath.Join(t.TempDir(), "saved.nd.enc.json")
	if err := p.store.exportEncryptedBackup(backup, testBackupPassphrase); err != nil {
		t.Fatal(err)
	}
	raw, err := os.ReadFile(backup)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(raw, []byte("Tenant A")) || bytes.Contains(raw, []byte("tenant-a")) || bytes.Contains(raw, []byte("ndp_")) {
		t.Fatal("plaintext backup leak")
	}
	info, err := os.Stat(backup)
	if err != nil {
		t.Fatal(err)
	}
	expectPrivateMode(t, info.Mode())
	restored := filepath.Join(t.TempDir(), "restored", "nd-cloud.json")
	if err := restoreEncryptedBackup(backup, restored, testBackupPassphrase); err != nil {
		t.Fatal(err)
	}
	s, err := openStore(restored)
	if err != nil {
		t.Fatal(err)
	}
	s.read(func(st State) {
		if st.SchemaVersion != schemaVersion || len(st.Tenants) != 2 || len(st.Boards) != 1 {
			t.Fatal("restored snapshot lost state")
		}
	})
	if err := restoreEncryptedBackup(backup, restored, testBackupPassphrase); !errors.Is(err, errConflict) {
		t.Fatalf("overwrote restored data: %v", err)
	}
	wrongDestination := filepath.Join(t.TempDir(), "wrong.json")
	if err := restoreEncryptedBackup(backup, wrongDestination, "not the same passphrase please"); err == nil {
		t.Fatal("wrong password succeeded")
	}
	if _, err := os.Stat(wrongDestination); !os.IsNotExist(err) {
		t.Fatal("wrong password produced file")
	}
	var envelope EncryptedBackupEnvelope
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatal(err)
	}
	// Mutation preserves parseable JSON but invalidates GCM authentication.
	ciphertext := []byte(envelope.Ciphertext)
	ciphertext[len(ciphertext)-5] = 'A'
	envelope.Ciphertext = string(ciphertext)
	tampered, _ := json.Marshal(envelope)
	bad := filepath.Join(t.TempDir(), "tampered.json")
	if err := os.WriteFile(bad, tampered, 0600); err != nil {
		t.Fatal(err)
	}
	if err := restoreEncryptedBackup(bad, filepath.Join(t.TempDir(), "unsafe.json"), testBackupPassphrase); err == nil {
		t.Fatal("modified encrypted backup accepted")
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		t.Fatal(err)
	}
	envelope.CreatedAt = envelope.CreatedAt.Add(24 * time.Hour)
	changed, _ := json.Marshal(envelope)
	changedFile := filepath.Join(t.TempDir(), "changed-time.enc")
	if err := os.WriteFile(changedFile, changed, 0600); err != nil {
		t.Fatal(err)
	}
	if err := restoreEncryptedBackup(changedFile, filepath.Join(t.TempDir(), "unexpected.json"), testBackupPassphrase); err == nil {
		t.Fatal("modified metadata accepted")
	}
	if err := p.store.exportEncryptedBackup(backup, testBackupPassphrase); !errors.Is(err, errConflict) {
		t.Fatalf("overwrote backup: %v", err)
	}
}

func TestEncryptedBackupParameterValidation(t *testing.T) {
	p := createPilot(t)
	if err := p.store.exportEncryptedBackup(filepath.Join(t.TempDir(), "backup.enc"), "short"); err == nil {
		t.Fatal("weak password accepted")
	}
	file := filepath.Join(t.TempDir(), "backup.enc")
	if err := p.store.exportEncryptedBackup(file, testBackupPassphrase); err != nil {
		t.Fatal(err)
	}
	b, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	var envelope EncryptedBackupEnvelope
	if err := json.Unmarshal(b, &envelope); err != nil {
		t.Fatal(err)
	}
	envelope.Iterations = 0
	altered, _ := json.Marshal(envelope)
	wrong := filepath.Join(t.TempDir(), "modified.enc")
	if err := os.WriteFile(wrong, altered, 0600); err != nil {
		t.Fatal(err)
	}
	if err := restoreEncryptedBackup(wrong, filepath.Join(t.TempDir(), "new.json"), testBackupPassphrase); err == nil {
		t.Fatal("unsafe KDF parameters accepted")
	}
	// Windows has no POSIX permission bits, so public-backup refusal is POSIX-only.
	if runtime.GOOS != "windows" {
		if err := os.Chmod(file, 0644); err != nil {
			t.Fatal(err)
		}
		if err := restoreEncryptedBackup(file, filepath.Join(t.TempDir(), "other.json"), testBackupPassphrase); err == nil {
			t.Fatal("public backup allowed")
		}
	}
}

func TestProcessWriterLockIsExclusiveAndOwnerChecked(t *testing.T) {
	data := filepath.Join(t.TempDir(), "private", "state.json")
	first, err := acquireFileStateLock(data)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := acquireFileStateLock(data); !errors.Is(err, errConflict) {
		t.Fatalf("concurrent writer admitted: %v", err)
	}
	// The lock file never contains a credential.
	contents, err := os.ReadFile(first.path)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(contents), "ndp_") {
		t.Fatal("token leaked in lock")
	}
	if err := first.Release(); err != nil {
		t.Fatal(err)
	}
	second, err := acquireFileStateLock(data)
	if err != nil {
		t.Fatal(err)
	}
	second.nonce = "other-owner"
	if err := second.Release(); err == nil {
		t.Fatal("other process removed lock")
	}
	second.nonce = strings.Split(string(mustRead(t, second.path)), "\n")[0]
	if err := second.Release(); err != nil {
		t.Fatal(err)
	}
}

func mustRead(t *testing.T, path string) []byte {
	t.Helper()
	b, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func TestSchemaThreeMigratesToFourWithoutErasingExistingState(t *testing.T) {
	p := createPilot(t)
	old, err := os.ReadFile(p.path)
	if err != nil {
		t.Fatal(err)
	}
	var raw map[string]any
	if err := json.Unmarshal(old, &raw); err != nil {
		t.Fatal(err)
	}
	raw["schema_version"] = float64(3)
	delete(raw, "specs")
	v3, _ := json.Marshal(raw)
	if err := os.WriteFile(p.path, v3, 0600); err != nil {
		t.Fatal(err)
	}
	migrated, err := openStore(p.path)
	if err != nil {
		t.Fatal(err)
	}
	migrated.read(func(st State) {
		if st.SchemaVersion != schemaVersion || st.Specs == nil || len(st.Tenants) != 2 || len(st.Projects) != 3 {
			t.Fatal("migration lost old records")
		}
	})
	unchanged, _ := os.ReadFile(p.path)
	if !bytes.Equal(v3, unchanged) {
		t.Fatal("read-only migration changed file")
	}
	if err := migrated.transact(func(s *State) error { return nil }); err != nil {
		t.Fatal(err)
	}
	disk, _ := os.ReadFile(p.path)
	if !bytes.Contains(disk, []byte(`"schema_version": 4`)) || !bytes.Contains(disk, []byte(`"specs": {}`)) {
		t.Fatal("upgrade not persisted")
	}
}

func TestPBKDF2MatchesReferenceVector(t *testing.T) {
	salt := []byte{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}
	key, err := deriveBackupKey("a long secure passphrase", salt, encryptedBackupRounds)
	if err != nil {
		t.Fatal(err)
	}
	const expected = "98c53a3034d75816bc1f5154f84a25c0ab1fc1f2fad1b7d8645c6de09817e4cc"
	if hex.EncodeToString(key[:]) != expected {
		t.Fatalf("PBKDF2 mismatch: %x", key)
	}
}

func TestBackupNoClobberUnderConcurrentWriters(t *testing.T) {
	target := filepath.Join(t.TempDir(), "new", "output.nd")
	done := make(chan error, 2)
	for _, message := range []string{"ONE", "TWO"} {
		go func(data string) { done <- persistNoReplace(target, []byte(data)) }(message)
	}
	first, second := <-done, <-done
	ok := (first == nil && errors.Is(second, errConflict)) || (second == nil && errors.Is(first, errConflict))
	if !ok {
		t.Fatalf("publish no-clobber failed: %v / %v", first, second)
	}
	saved, err := os.ReadFile(target)
	if err != nil {
		t.Fatal(err)
	}
	if string(saved) != "ONE" && string(saved) != "TWO" {
		t.Fatal("partial file created")
	}
}

func TestEncryptedBackupCLIAndWriterLock(t *testing.T) {
	p := createPilot(t)
	t.Setenv("ND_CLOUD_BACKUP_PASSPHRASE", testBackupPassphrase)
	output := filepath.Join(t.TempDir(), "snapshot.enc")
	if err := run([]string{"backup-encrypted", "-data", p.path, "-out", output}); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(t.TempDir(), "new.json")
	if err := run([]string{"restore-encrypted", "-data", dest, "-from", output}); err != nil {
		t.Fatal(err)
	}
	lock, err := acquireFileStateLock(p.path)
	if err != nil {
		t.Fatal(err)
	}
	if err := run([]string{"revoke", "-data", p.path, "-token-id", "tok_123"}); !errors.Is(err, errConflict) {
		t.Fatalf("second writer admitted: %v", err)
	}
	if err := lock.Release(); err != nil {
		t.Fatal(err)
	}
}

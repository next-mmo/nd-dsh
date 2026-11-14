package main

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func TestPrivateBackupRestoreAndTamperRejection(t *testing.T) {
	p := createPilot(t)
	expectStatus(t, p.call("PUT", "/v1/projects/"+p.projectA+"/board", p.host, p.board(1)), 201)
	backupPath := filepath.Join(t.TempDir(), "backup.nd.json")
	if err := p.store.exportBackup(backupPath); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(backupPath)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatalf("backup not private: %v", info.Mode())
	}
	if err := p.store.exportBackup(backupPath); err != errConflict {
		t.Fatalf("existing backup overwritten: %v", err)
	}
	restored := filepath.Join(t.TempDir(), "new", "state.json")
	if err := restoreBackup(backupPath, restored); err != nil {
		t.Fatal(err)
	}
	s, err := openStore(restored)
	if err != nil {
		t.Fatal(err)
	}
	s.read(func(st State) {
		if len(st.Tenants) != 2 || len(st.Projects) != 3 || len(st.Boards) != 1 || st.SchemaVersion != 2 {
			t.Fatal("unexpected restored state")
		}
	})
	if err := restoreBackup(backupPath, restored); err != errConflict {
		t.Fatalf("restore overwrote existing data: %v", err)
	}
	b, err := os.ReadFile(backupPath)
	if err != nil {
		t.Fatal(err)
	}
	tampered := bytes.Replace(b, []byte("Tenant A"), []byte("Tenant X"), 1)
	if bytes.Equal(tampered, b) {
		t.Fatal("fixture missing tenant name")
	}
	bad := filepath.Join(t.TempDir(), "bad.nd.json")
	if err := os.WriteFile(bad, tampered, 0600); err != nil {
		t.Fatal(err)
	}
	dest := filepath.Join(t.TempDir(), "dest.json")
	if err := restoreBackup(bad, dest); err == nil {
		t.Fatal("tampering accepted")
	}
	if _, err := os.Stat(dest); !os.IsNotExist(err) {
		t.Fatal("tampered backup wrote state")
	}
	if err := os.Chmod(backupPath, 0644); err != nil {
		t.Fatal(err)
	}
	if err := restoreBackup(backupPath, filepath.Join(t.TempDir(), "untrusted.json")); err == nil {
		t.Fatal("world-readable backup accepted")
	}
}

func TestSchemaOneMigratesOnNextWriteWithoutDataLoss(t *testing.T) {
	file := filepath.Join(t.TempDir(), "legacy.json")
	old := emptyState()
	old.SchemaVersion = 1
	old.Tenants["legacy"] = Tenant{ID: "legacy", Name: "Legacy Tenant"}
	raw, err := json.Marshal(old)
	if err != nil {
		t.Fatal(err)
	}
	var obj map[string]any
	if err := json.Unmarshal(raw, &obj); err != nil {
		t.Fatal(err)
	}
	delete(obj, "sources")
	oldRaw, err := json.Marshal(obj)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, oldRaw, 0600); err != nil {
		t.Fatal(err)
	}
	store, err := openStore(file)
	if err != nil {
		t.Fatal(err)
	}
	store.read(func(st State) {
		if st.SchemaVersion != 2 || st.Tenants["legacy"].Name != "Legacy Tenant" || st.Sources == nil {
			t.Fatal("migration failed")
		}
	})
	original, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(original, oldRaw) {
		t.Fatal("read-only migration touched original file")
	}
	if err := store.transact(func(s *State) error { return nil }); err != nil {
		t.Fatal(err)
	}
	disk, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Contains(disk, []byte(`"schema_version": 2`)) || !bytes.Contains(disk, []byte(`"sources": {}`)) {
		t.Fatal("schema not upgraded")
	}
	_, err = openStore(file)
	if err != nil {
		t.Fatal(err)
	}
}

func TestUnsupportedNewerSchemaFailClosed(t *testing.T) {
	file := filepath.Join(t.TempDir(), "future.json")
	raw := []byte(`{"schema_version":99,"tenants":{},"memberships":{},"projects":{},"tokens":{},"boards":{},"cases":{},"cards":{},"sources":{}}`)
	if err := os.WriteFile(file, raw, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := openStore(file); err == nil {
		t.Fatal("future schema read succeeded")
	}
}

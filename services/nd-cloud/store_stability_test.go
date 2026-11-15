package main

import (
	"path/filepath"
	"testing"
	"time"
)

// A client may read a large response slowly or pause during a download.
// Its snapshot must remain consistent without preventing a separate mutation.
func TestSlowReadDoesNotBlockIndependentWrite(t *testing.T) {
	store, err := openStore(filepath.Join(t.TempDir(), "nd-cloud.json"))
	if err != nil {
		t.Fatal(err)
	}
	if err := store.transact(func(state *State) error {
		state.Tenants["first"] = Tenant{ID: "first", Name: "First"}
		return nil
	}); err != nil {
		t.Fatal(err)
	}

	entered := make(chan struct{})
	release := make(chan struct{})
	readResult := make(chan int, 1)
	go store.read(func(snapshot State) {
		close(entered)
		<-release
		readResult <- len(snapshot.Tenants)
	})
	<-entered

	writeResult := make(chan error, 1)
	go func() {
		writeResult <- store.transact(func(state *State) error {
			state.Tenants["second"] = Tenant{ID: "second", Name: "Second"}
			return nil
		})
	}()

	select {
	case err := <-writeResult:
		if err != nil {
			close(release)
			t.Fatal(err)
		}
	case <-time.After(1500 * time.Millisecond):
		close(release)
		<-readResult
		t.Fatal("blocked: slow snapshot reader prevented independent write")
	}
	close(release)
	if got := <-readResult; got != 1 {
		t.Fatalf("read snapshot changed during concurrent write: saw %d tenants", got)
	}
	store.read(func(latest State) {
		if len(latest.Tenants) != 2 {
			t.Errorf("latest snapshot should contain both writes")
		}
	})
	reloaded, err := openStore(store.path)
	if err != nil {
		t.Fatal(err)
	}
	reloaded.read(func(onDisk State) {
		if len(onDisk.Tenants) != 2 {
			t.Errorf("durable state lost concurrent write")
		}
	})
}

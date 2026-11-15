package main

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
)

// privateModeOK reports whether permission bits are owner-only. Windows has no
// POSIX mode bits (Go synthesizes 0666/0444 from the read-only attribute), so
// there the NTFS ACLs inherited from the data directory are the protection
// boundary and bit checks must not fail closed.
func privateModeOK(mode os.FileMode) bool {
	if runtime.GOOS == "windows" {
		return true
	}
	return mode.Perm()&0077 == 0
}

// persistNoReplace durably publishes a new private file without replacing any
// existing destination, including when an unrelated writer races the caller.
// Hard-linking the synced temporary regular file makes the no-clobber publish
// atomic on filesystems that support hard links; unsupported systems fail closed.
func persistNoReplace(path string, payload []byte) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(dir, ".nd-cloud-create-*")
	if err != nil {
		return err
	}
	name := f.Name()
	defer os.Remove(name)
	if err := f.Chmod(0600); err != nil {
		f.Close()
		return err
	}
	if _, err := f.Write(payload); err != nil {
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
	if err := os.Link(name, path); err != nil {
		if errors.Is(err, os.ErrExist) {
			return errConflict
		}
		return err
	}
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
